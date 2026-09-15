<?php

namespace App\Jobs;

use App\Services\BusinessHoursCalculator;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Support\Facades\DB;
use MongoDB\Laravel\Eloquent\Model as MongoModel;

class ConversationResolvedAnalyticsJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable;

    public function __construct(private readonly string $conversationId) {}

    public function handle(BusinessHoursCalculator $bhCalc): void
    {
        $conv = DB::table('conversations')->where('id', $this->conversationId)->first();
        if (! $conv || ! $conv->resolved_at) {
            return;
        }

        $resolvedAt = \Carbon\Carbon::parse($conv->resolved_at);
        $createdAt  = \Carbon\Carbon::parse($conv->created_at);

        // Load SLA config
        $sla = DB::table('sla_configs')
            ->where('company_id', $conv->company_id)
            ->where(fn ($q) => $q->where('channel_id', $conv->channel_id)->orWhereNull('channel_id'))
            ->orderByRaw('channel_id IS NULL ASC') // prefer channel-specific
            ->first();

        $bhConfig = $sla && $sla->business_hours_only && $sla->business_hours_config
            ? json_decode($sla->business_hours_config, true)
            : null;

        // first_response_seconds
        $firstResponseSec = null;
        if ($conv->first_response_at) {
            $firstResponseAt = \Carbon\Carbon::parse($conv->first_response_at);
            $firstResponseSec = $bhConfig
                ? $bhCalc->calculateSeconds($createdAt, $firstResponseAt, $bhConfig)
                : $createdAt->diffInSeconds($firstResponseAt);
        }

        // resolution_seconds
        $resolutionSec = $bhConfig
            ? $bhCalc->calculateSeconds($createdAt, $resolvedAt, $bhConfig)
            : $createdAt->diffInSeconds($resolvedAt);

        // Message counts from MongoDB
        $db = app('mongodb');
        $msgCounts = $db->selectCollection('messages')->aggregate([
            ['$match'  => ['conversation_id' => $this->conversationId]],
            ['$group'  => ['_id' => '$sender_type', 'count' => ['$sum' => 1]]],
        ])->toArray();

        $counts       = [];
        foreach ($msgCounts as $row) {
            $counts[$row['_id']] = $row['count'];
        }
        $inbound  = $counts['contact'] ?? 0;
        $outbound = $counts['agent'] ?? 0;
        $bot      = $counts['bot'] ?? 0;
        $total    = $inbound + $outbound + $bot;

        // Handoff / reassignment counts
        $assignments = DB::table('conversation_assignments')
            ->where('conversation_id', $this->conversationId)
            ->get();

        $hadHandoff       = $assignments->contains('reason', 'bot_handoff');
        $reassignCount    = $assignments->whereIn('reason', ['manual', 'reassign'])->count();
        $wasBotHandled    = $bot > 0 && ! $hadHandoff;

        // SLA flags
        $metFirstResponse = null;
        $metResolution    = null;
        if ($sla) {
            $metFirstResponse = $firstResponseSec !== null
                ? $firstResponseSec <= $sla->first_response_seconds
                : null;
            $metResolution = $resolutionSec <= $sla->resolution_seconds;
        }

        $channel = DB::table('channels')->where('id', $conv->channel_id)->first();

        // UPSERT analytics_conversation_facts
        DB::table('analytics_conversation_facts')->upsert([
            'company_id'              => $conv->company_id,
            'conversation_id'         => $this->conversationId,
            'channel_id'              => $conv->channel_id,
            'channel_type'            => $channel->type ?? 'unknown',
            'contact_id'              => $conv->contact_id,
            'assigned_agent_id'       => $conv->assigned_agent_id,
            'first_response_seconds'  => $firstResponseSec,
            'resolution_seconds'      => $resolutionSec,
            'handle_seconds'          => $resolutionSec,
            'total_messages'          => $total,
            'inbound_messages'        => $inbound,
            'outbound_messages'       => $outbound,
            'bot_messages'            => $bot,
            'was_bot_handled'         => $wasBotHandled ? 1 : 0,
            'had_bot_handoff'         => $hadHandoff ? 1 : 0,
            'reassignment_count'      => $reassignCount,
            'resolved_date'           => $resolvedAt->toDateString(),
            'resolved_hour'           => $resolvedAt->hour,
            'resolved_week'           => $resolvedAt->weekOfYear,
            'resolved_month'          => $resolvedAt->format('Y-m'),
            'met_first_response_sla'  => $metFirstResponse,
            'met_resolution_sla'      => $metResolution,
        ], ['company_id', 'conversation_id'], [
            'channel_type',
            'first_response_seconds', 'resolution_seconds', 'handle_seconds',
            'total_messages', 'inbound_messages', 'outbound_messages', 'bot_messages',
            'was_bot_handled', 'had_bot_handoff', 'reassignment_count',
            'assigned_agent_id', 'met_first_response_sla', 'met_resolution_sla',
        ]);

        // UPSERT hourly volume.
        //
        // This row is shared with HourlyVolumeAggregationJob on the same unique
        // key, but the two have opposite semantics — that job SETS absolute
        // values, this one INCREMENTS. Ownership is therefore split by column:
        // this job owns resolved_count, that one owns new_conv_count. The update
        // lists are disjoint, so ON DUPLICATE KEY UPDATE settles any insert race
        // atomically regardless of which job arrives first.
        //
        // inbound_count / outbound_count are deliberately NOT incremented here.
        // This job runs on resolve, so it would bucket a conversation's entire
        // message history under resolved_at: a conversation opened Monday 09:00
        // and resolved Friday 17:00 would dump every inbound message into
        // Friday-17:00. hourlyHeatmap reads SUM(inbound_count) to answer "when
        // does traffic arrive" — filling it from resolution time would not make
        // the chart slow, it would make it wrong. The correct source is a
        // MongoDB messages aggregate bucketed by message timestamp.
        $hourBucket = $resolvedAt->copy()->startOfHour();
        DB::table('analytics_hourly_volume')->upsert([
            'company_id'     => $conv->company_id,
            'channel_id'     => $conv->channel_id,
            'channel_type'   => $channel->type ?? 'unknown',
            'hour_bucket'    => $hourBucket,
            'resolved_count' => 1,
            'inbound_count'  => 0,
            'outbound_count' => 0,
            'new_conv_count' => 0,
        ], ['company_id', 'channel_id', 'hour_bucket'], [
            'resolved_count' => DB::raw('analytics_hourly_volume.resolved_count + 1'),
        ]);

        // CSAT survey (if enabled)
        $company = DB::table('companies')->where('id', $conv->company_id)->first();
        $settings = json_decode($company->settings ?? '{}', true);
        if ($settings['csat_enabled'] ?? false) {
            SendCsatSurveyJob::dispatch($this->conversationId)->delay(now()->addMinutes(5));
        }
    }
}
