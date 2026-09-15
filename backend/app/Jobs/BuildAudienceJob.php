<?php

namespace App\Jobs;

use App\Models\AudienceSnapshot;
use App\Models\AudienceSnapshotRecipient;
use App\Models\BroadcastCampaign;
use App\Models\Contact;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

class BuildAudienceJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable;

    public function __construct(private readonly string $campaignId) {}

    public function handle(): void
    {
        $campaign = BroadcastCampaign::findOrFail($this->campaignId);

        if (! in_array($campaign->status, ['scheduled', 'running'])) {
            return;
        }

        $recipients = $this->resolveAudience($campaign);

        if ($recipients->isEmpty()) {
            $campaign->update(['status' => 'failed']);
            return;
        }

        // Create snapshot
        $snapshot = AudienceSnapshot::create([
            'campaign_id' => $campaign->id,
            'company_id'  => $campaign->company_id,
            'total_count' => $recipients->count(),
        ]);

        // Batch insert recipients with transaction
        DB::transaction(function () use ($recipients, $snapshot) {
            foreach ($recipients->chunk(500) as $chunk) {
                AudienceSnapshotRecipient::insert(
                    $chunk->map(fn ($r) => [
                        'snapshot_id'      => $snapshot->id,
                        'contact_id'       => $r['contact_id'],
                        'channel_identity' => $r['channel_identity'],
                        'variables'        => json_encode($r['variables'] ?? []),
                        'status'           => 'pending',
                    ])->all()
                );
            }
        });

        $campaign->update([
            'audience_snapshot_id' => $snapshot->id,
            'total_recipients'     => $recipients->count(),
            'status'               => 'running',
            'started_at'           => now(),
        ]);

        // Dispatch chunks sequentially (chain pattern)
        $recipientIds = AudienceSnapshotRecipient::where('snapshot_id', $snapshot->id)
            ->orderBy('id')
            ->pluck('id');

        $chunkSize  = 100;
        $chunks     = $recipientIds->chunk($chunkSize);
        $ratePerMin = $campaign->rate_limit_per_minute;

        foreach ($chunks as $index => $chunk) {
            $delay = $index === 0
                ? 0
                : min((int) round(60 / $ratePerMin * $chunkSize * $index), PHP_INT_MAX);

            ProcessBroadcastChunkJob::dispatch(
                $campaign->id,
                $snapshot->id,
                $chunk->first(),
                $chunk->last()
            )->delay(now()->addSeconds($delay));
        }
    }

    private function resolveAudience(BroadcastCampaign $campaign): \Illuminate\Support\Collection
    {
        $channel = DB::table('channels')
            ->where('id', $campaign->channel_id)
            ->first();

        // channels.type — there is no channel_type column on this table, so this
        // was always null and every campaign bailed out here as "channel not
        // found", which BuildAudienceJob::handle then reports as status=failed.
        if (! $channel || ! $channel->type) {
            Log::warning('BuildAudienceJob: channel not found', [
                'campaign_id' => $campaign->id,
                'channel_id'  => $campaign->channel_id,
            ]);
            return collect();
        }

        $base = DB::table('contacts as c')
            ->join('contact_channel_identities as ci', function ($join) use ($channel) {
                $join->on('ci.contact_id', '=', 'c.id')
                     ->where('ci.channel_type', '=', $channel->type);
            })
            ->where('c.company_id', $campaign->company_id)
            ->whereNull('c.deleted_at')
            ->select('c.id as contact_id', 'ci.external_id as channel_identity');

        if ($campaign->audience_type === 'all') {
            return collect($base->get())->map(fn ($r) => (array) $r);
        }

        if ($campaign->audience_type === 'tag') {
            $tags     = $campaign->audience_config['tags'] ?? [];
            $tagCount = count($tags);

            if ($tagCount === 0) {
                return collect();
            }

            // JSON_CONTAINS(target, candidate_array) is 1 only when every element
            // of the candidate is present, which is what the old T-SQL OPENJSON
            // COUNT(DISTINCT value) = $tagCount was expressing. A NULL tags column
            // yields NULL and is correctly excluded.
            $rows = $base->whereRaw(
                'JSON_CONTAINS(c.tags, ?)',
                [json_encode(array_values($tags), JSON_UNESCAPED_UNICODE)]
            )->get();

            return collect($rows)->map(fn ($r) => (array) $r);
        }

        if ($campaign->audience_type === 'upload') {
            $contactIds = $campaign->audience_config['contact_ids'] ?? [];

            if (empty($contactIds)) {
                return collect();
            }

            // Validate UUID format
            $validIds = array_filter($contactIds, fn($id) =>
                is_string($id) && preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i', $id)
            );

            if (empty($validIds)) {
                Log::warning('BuildAudienceJob: no valid contact UUIDs', [
                    'campaign_id' => $campaign->id,
                ]);
                return collect();
            }

            $rows = $base->whereIn('c.id', $validIds)->get();
            return collect($rows)->map(fn ($r) => (array) $r);
        }

        // segment handled by separate pre-processing steps
        return collect();
    }
}
