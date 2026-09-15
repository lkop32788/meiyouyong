<?php

use App\Http\Middleware\EnsureIsSuperAdmin;
use App\Http\Middleware\InternalApiKeyMiddleware;
use App\Http\Middleware\TenantMiddleware;
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Http\Request;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        api: __DIR__.'/../routes/api.php',
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
        then: function () {
            \Illuminate\Support\Facades\Route::middleware('web')
                ->group(base_path('routes/internal.php'));
            // Prefixed api/ so the SPA can reach it: the frontend has a single
            // axios instance with baseURL '/api', the vite dev proxy forwards
            // only /api, and nginx proxies only /api/ — a bare 'system' prefix
            // was unreachable from every environment. Also brings these routes
            // under shouldRenderJsonWhen() below, so errors render as JSON.
            // No 'tenant' middleware: super_admin is deliberately cross-tenant.
            \Illuminate\Support\Facades\Route::prefix('api/system')
                ->middleware(['auth:sanctum', 'system.admin'])
                ->group(base_path('routes/system.php'));
        },
    )
    ->withMiddleware(function (Middleware $middleware): void {
        $middleware->alias([
            'tenant'       => TenantMiddleware::class,
            'internal.key' => InternalApiKeyMiddleware::class,
            'system.admin' => EnsureIsSuperAdmin::class,
        ]);

        // All /api/* routes return JSON
        $middleware->statefulApi();

        // SPA + pure API app: there is no named `login` route to redirect
        // guests to. Returning null makes unauthenticated API requests fall
        // through to a 401 JSON response (rendered via shouldRenderJsonWhen)
        // instead of throwing RouteNotFoundException.
        $middleware->redirectGuestsTo(fn () => null);
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        $exceptions->shouldRenderJsonWhen(
            fn (Request $request) => $request->is('api/*') || $request->is('internal/*'),
        );
    })->create();
