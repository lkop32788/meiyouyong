<?php

use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Schedule;

Artisan::command('inspire', function () {
    $this->comment(Inspiring::quote());
})->purpose('Display an inspiring quote');

// ── Channel health watchdog ────────────────────────────────────────────
// Probe every active channel every 5 minutes. Results land in
// channels.settings.health and surface as badges in the channels UI.
Schedule::command('channels:health-check')->everyFiveMinutes();
