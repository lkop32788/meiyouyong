<?php

namespace App\Console\Commands;

use App\Models\Channel;
use App\Services\ChannelHealthService;
use App\Services\RealtimeEventPublisher;
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
                            {--channel= : Check a single channel id}
                            {--no-deactivate : Do NOT auto-deactivate channels found down}
                            {--no-notify : Do NOT push realtime status events}';

    protected $description = 'Probe channel connectivity; auto-stop dead channels (default) and notify';

    public function handle(ChannelHealthService $health, RealtimeEventPublisher $realtime): int
    {
        $autoDeactivate = ! $this->option('no-deactivate');
        $notify         = ! $this->option('no-notify');

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
            $previous = $channel->settings['health']['status'] ?? null;
            $result   = $health->check($channel);
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

            $wasDeactivated = false;

            // Auto-stop: a channel that is down loses routing until someone
            // fixes it and re-enables. Down on two consecutive checks avoids
            // flapping on a single network blip.
            if (
                $autoDeactivate
                && $result['status'] === 'down'
                && $previous === 'down'
            ) {
                $channel->update(['is_active' => false]);
                $wasDeactivated = true;
                $deactivated++;
                $this->warn("  → auto-deactivated {$channel->name}");

                Log::warning('Channel auto-deactivated by health watchdog', [
                    'channel_id' => $channel->id,
                    'company_id' => $channel->company_id,
                    'reason'     => $result['reason'] ?? null,
                ]);
            }

            // Realtime toast/badge refresh for online staff on any transition
            if ($notify && $previous !== null && $previous !== $result['status']) {
                $realtime->channelStatusChanged(
                    companyId:     $channel->company_id,
                    channelId:     $channel->id,
                    channelName:   $channel->name,
                    healthStatus:  $result['status'],
                    reason:        $result['reason'] ?? null,
                    deactivated:   $wasDeactivated,
                );
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
