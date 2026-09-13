<?php

namespace App\Providers;

use App\Services\Channels\AdapterRegistry;
use App\Services\Channels\FacebookMessengerAdapter;
use App\Services\Channels\LineAdapter;
use App\Services\Channels\SmtpEmailAdapter;
use App\Services\Channels\TwilioSmsAdapter;
use App\Services\Channels\WhatsAppCloudAdapter;
use App\Services\Channels\WhatsAppQrAdapter;
use Illuminate\Support\ServiceProvider;
use MongoDB\Laravel\MongoDBServiceProvider;

class AppServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        // Bind a default null tenant — overwritten per-request by TenantMiddleware
        $this->app->instance('tenant.company_id', null);

        // Register MongoDB service provider (required for mongodb/laravel-mongodb)
        $this->app->register(MongoDBServiceProvider::class);

        // Channel adapter registry — tambah adapter baru di sini
        $this->app->singleton(AdapterRegistry::class, fn() => new AdapterRegistry([
            new WhatsAppCloudAdapter(),
            new WhatsAppQrAdapter(),
            new FacebookMessengerAdapter(),
            new LineAdapter(),
            new TwilioSmsAdapter(),
            new SmtpEmailAdapter(),
        ]));
    }

    public function boot(): void
    {
        //
    }
}
