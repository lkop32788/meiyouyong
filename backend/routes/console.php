<?php

use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Schedule;

Artisan::command('inspire', function () {
    $this->comment(Inspiring::quote());
})->purpose('Display an inspiring quote');

// ── Channel health watchdog ────────────────────────────────────────
// Probe every active channel every 2 minutes: results land in
// channels.settings.health (UI badges) and status changes are pushed to online
// staff in realtime.
//
// --no-deactivate is deliberate. The command auto-deactivates by default
// (CheckChannelHealth::handle), and the probe is far too eager to call a
// channel dead: ChannelHealthService::checkWhatsappQr() has no arm for the
// gateway's 'disconnected' status, so it falls through to default => 'down'.
// A WhatsApp-QR channel that is merely logged out therefore reads as down, and
// two consecutive ticks set is_active = false. That is not a degraded state —
// it takes the channel out of routing entirely (ChannelRoutingService requires
// is_active) AND breaks inbound, because the gateway resolves webhook secrets
// with `AND is_active = 1` and starts failing signature verification.
//
// With every channel currently probing as 'disconnected', enabling the
// scheduler with auto-deactivate on would take all channels offline within two
// ticks. Keep the watchdog observational until the probe can tell "logged out"
// apart from "broken".
Schedule::command('channels:health-check --no-deactivate')->everyTwoMinutes();
