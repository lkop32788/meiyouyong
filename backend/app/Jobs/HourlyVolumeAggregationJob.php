<?php

namespace App\Jobs;

use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Support\Facades\DB;

class HourlyVolumeAggregationJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable;

    public function handle(): void
    {
        // Process the hour that just completed
        $hourEnd   = now()->startOfHour();
        $hourStart = $hourEnd->copy()->subHour();

        $companies = DB::table('companies')->where('is_active', true)->pluck('id');

        foreach ($companies as $companyId) {
            $rows = DB::table('conversations as c')
                ->join('channels as ch', 'ch.id', '=', 'c.channel_id')
                ->where('c.company_id', $companyId)
                ->where('c.created_at', '>=', $hourStart)
                ->where('c.created_at', '<',  $hourEnd)
                // channels.type — there is no channel_type column on this table
                // (only contact_channel_identities has one). This was a hard SQL
                // error, so this job had never completed a single run.
                ->selectRaw('
                    c.channel_id,
                    ch.type AS channel_type,
                    COUNT(*) AS new_conv_count
                ')
                ->groupBy('c.channel_id', 'ch.type')
                ->get();

            foreach ($rows as $row) {
                // Column ownership is split with ConversationResolvedAnalyticsJob,
                // which shares this unique key but increments rather than sets.
                // This job owns new_conv_count; that one owns resolved_count.
                // Disjoint update lists let ON DUPLICATE KEY UPDATE settle any
                // insert race atomically, whichever job gets there first.
                //
                // inbound_count / outbound_count stay 0 for now — they have to
                // come from a MongoDB messages aggregate (the conversations join
                // cannot know message counts), which is what hourlyHeatmap reads.
                // Populating them is a separate piece of work.
                DB::table('analytics_hourly_volume')->upsert([
                    'company_id'     => $companyId,
                    'channel_id'     => $row->channel_id,
                    'channel_type'   => $row->channel_type,
                    'hour_bucket'    => $hourStart,
                    'new_conv_count' => $row->new_conv_count,
                    'resolved_count' => 0,
                    'inbound_count'  => 0,
                    'outbound_count' => 0,
                ], ['company_id', 'channel_id', 'hour_bucket'], [
                    'new_conv_count' => $row->new_conv_count,
                ]);
            }
        }
    }
}
