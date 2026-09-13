<?php

namespace App\Console\Commands;

use App\Models\Channel;
use App\Services\ChannelHealthService;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Log;

/**
 * Channel health watchdog.
 *
 *   php artisan channels:health-check            # probe all active channels
 *   php artisan channels:health-check --deactivate  # also auto-stop dead ones
 *
 * Behaviour per status:
 *   healthy          → nothing
 *   degraded         → logged (QR waiting for scan, provider hiccup, …)
 *   down             → logged; with --deactivate the channel is marked
 *                      is_active = false so nothing routes through it until
 *                      someone fixes/reconnects it (UI shows 停用 + reason)
 *
 * Designed to run every 5 minutes from the scheduler (routes/console.php).
 */
class CheckChannelHealth extends Command
{
    protected $signature = 'channels:health-check
                            {--company= : Limit to one company id}
                            {--deactivate : Auto-deactivate channels found down}
                            {--channel= : Check a single channel id}';

    protected $description = 'Probe channel connectivity and (optionally) auto-stop dead channels';

    public function handle(ChannelHealthService $health): int
    {
        $query = Channel::where('is_active', true);

        if ($companyId = $this->option('company')) {
            $query->where('company_id', $companyId);
        }
        if ($channelId = $this->option('channel')) {
            $query->where('id', $channelId);
        }

        $channels = $query->get();
        if ($channels->isEmpty()) {
            $this->info('No active channels to check.');

            return self::SUCCESS;
        }

        $counts = ['healthy' => 0, 'degraded' => 0, 'down' => 0, 'unknown' => 0];
        $deactivated = 0;

        foreach ($channels as $channel) {
            $result = $health->check($channel);
            $counts[$result['status']] = ($counts[$result['status']] ?? 0) + 1;

            $line = "[{$channel->type}] {$channel->name}: {$result['status']}"
                . (isset($result['reason']) ? " — {$result['reason']}" : '');
            $this->line($line);

            match ($result['status']) {
                'down'   => Log::warning('Channel health: DOWN', [
                    'channel_id' => $channel->id,
                    'company_id' => $channel->company_id,
                    'reason'     => $result['reason'] ?? null,
                ]),
                'degraded' => Log::info('Channel health: degraded', [
                    'channel_id' => $channel->id,
                    'reason'     => $result['reason'] ?? null,
                ]),
                default  => null,
            };

            if ($result['status'] === 'down' && $this->option('deactivate')) {
                $channel->update(['is_active' => false]);
                $deactivated++;
                $this->warn("  → auto-deactivated {$channel->name}");
            }
        }

        $this->info(sprintf(
            'Checked %d channels — healthy: %d, degraded: %d, down: %d%s',
            $channels->count(),
            $counts['healthy'],
            $counts['degraded'],
            $counts['down'],
            $deactivated > 0 ? ", auto-deactivated: {$deactivated}" : ''
        ));

        return self::SUCCESS;
    }
}
