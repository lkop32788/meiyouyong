<?php

use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Schedule;

Artisan::command('inspire', function () {
    $this->comment(Inspiring::quote());
})->purpose('Display an inspiring quote');

// ── Channel health watchdog ────────────────────────────────────────
// Probe every active channel every 2 minutes, fully automatic:
// results land in channels.settings.health (UI badges), status changes are
// pushed to online staff in realtime, and channels found down on two
// consecutive checks are auto-deactivated (is_active = false).
Schedule::command('channels:health-check')->everyTwoMinutes();
