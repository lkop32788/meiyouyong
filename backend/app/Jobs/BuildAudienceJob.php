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

        // Batch insert recipients (500 per batch)
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
            $delay = $index === 0 ? 0 : (int) round(60 / $ratePerMin * $chunkSize * $index);

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
        $channelType = DB::table('channels')
            ->where('id', $campaign->channel_id)
            ->value('channel_type');

        $base = DB::table('contacts as c')
            ->join('contact_channel_identities as ci', function ($join) use ($channelType) {
                $join->on('ci.contact_id', '=', 'c.id')
                     ->where('ci.channel_type', '=', $channelType);
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

            $rows = $base->whereRaw(
                "(SELECT COUNT(DISTINCT value) FROM OPENJSON(c.tags) WHERE value IN (" .
                implode(',', array_fill(0, $tagCount, '?')) . ")) = ?",
                [...$tags, $tagCount]
            )->get();

            return collect($rows)->map(fn ($r) => (array) $r);
        }

        if ($campaign->audience_type === 'tag') {
            $tags     = $campaign->audience_config['tags'] ?? [];
            $tagCount = count($tags);

            $rows = $base->whereRaw(
                "(SELECT COUNT(DISTINCT value) FROM OPENJSON(c.tags) WHERE value IN (" .
                implode(',', array_fill(0, $tagCount, '?')) . ")) = ?",
                [...$tags, $tagCount]
            )->get();

            return collect($rows)->map(fn ($r) => (array) $r);
        }

        if ($campaign->audience_type === 'upload') {
            $contactIds = $campaign->audience_config['contact_ids'] ?? [];
            if (empty($contactIds)) {
                return collect();
            }

            $rows = $base->whereIn('c.id', $contactIds)->get();
            return collect($rows)->map(fn ($r) => (array) $r);
        }

        // segment handled by separate pre-processing steps
        return collect();
    }
}
