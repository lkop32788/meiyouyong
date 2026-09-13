<?php

use App\Http\Controllers\Api\AgentController;
use App\Http\Controllers\Api\AnalyticsController;
use App\Http\Controllers\Api\BotFlowController;
use App\Http\Controllers\Api\CampaignController;
use App\Http\Controllers\Api\ChannelConnectionController;
use App\Http\Controllers\Api\ChannelController;
use App\Http\Controllers\Api\AiConfigController;
use App\Http\Controllers\Api\ContactController;
use App\Http\Controllers\Api\ConversationController;
use App\Http\Controllers\Api\MessageController;
use App\Http\Controllers\Api\MetaAppConfigController;
use App\Http\Controllers\Api\TemplateController;
use App\Http\Controllers\Auth\LoginController;
use Illuminate\Support\Facades\Route;

// ── PUBLIC AUTH ──────────────────────────────────────────────────────────────
Route::prefix('auth')->group(function () {
    Route::post('login', [LoginController::class, 'login']);
});

// ── AUTHENTICATED ROUTES ─────────────────────────────────────────────────────
Route::middleware(['auth:sanctum', 'tenant'])->group(function () {

    // Auth
    Route::prefix('auth')->group(function () {
        Route::post('logout',  [LoginController::class, 'logout']);
        Route::post('refresh', [LoginController::class, 'refresh']); // refresh JWT untuk Socket.io
        Route::get('me',       [LoginController::class, 'me']);
    });

    // Conversations
    Route::prefix('conversations')->group(function () {
        Route::get('/',          [ConversationController::class, 'index']);
        Route::get('/{id}',      [ConversationController::class, 'show'])
            ->where('id', '[0-9a-f-]{36}');
        Route::post('/{id}/resolve', [ConversationController::class, 'resolve'])
            ->where('id', '[0-9a-f-]{36}');
        Route::post('/{id}/reopen',  [ConversationController::class, 'reopen'])
            ->where('id', '[0-9a-f-]{36}');
        Route::post('/{id}/assign',  [ConversationController::class, 'assign'])
            ->where('id', '[0-9a-f-]{36}');
        Route::post('/{id}/snooze',  [ConversationController::class, 'snooze'])
            ->where('id', '[0-9a-f-]{36}');

        // Messages
        Route::get('/{id}/messages',  [MessageController::class, 'index'])
            ->where('id', '[0-9a-f-]{36}');
        Route::post('/{id}/messages', [MessageController::class, 'store'])
            ->where('id', '[0-9a-f-]{36}');
    });

    // Contacts
    Route::prefix('contacts')->group(function () {
        Route::get('/{id}',   [ContactController::class, 'show'])
            ->where('id', '[0-9a-f-]{36}');
        Route::patch('/{id}', [ContactController::class, 'update'])
            ->where('id', '[0-9a-f-]{36}');
    });

    // Agents (untuk transfer dropdown, presence list)
    Route::get('agents',    [AgentController::class, 'index']);
    Route::post('agents',   [AgentController::class, 'store']);
    Route::put('agents/{id}',    [AgentController::class, 'update'])->where('id', '[0-9a-f-]{36}');
    Route::delete('agents/{id}', [AgentController::class, 'destroy'])->where('id', '[0-9a-f-]{36}');

    // Channels (CRUD)
    Route::prefix('channels')->group(function () {
        Route::get('/',        [ChannelController::class, 'index']);
        Route::post('/',       [ChannelController::class, 'store']);
        Route::put('/{id}',    [ChannelController::class, 'update'])->where('id', '[0-9a-f-]{36}');
        Route::delete('/{id}', [ChannelController::class, 'destroy'])->where('id', '[0-9a-f-]{36}');

        // Connectivity health checks (live probes per provider)
        Route::get('/{id}/health',    [ChannelController::class, 'health']);
        Route::post('/health/check-all', [ChannelController::class, 'healthCheckAll']);

        // WhatsApp QR connect flow (Baileys session proxied via gateway)
        Route::post('/{id}/qr/start',      [ChannelConnectionController::class, 'qrStart']);
        Route::get('/{id}/qr/status',      [ChannelConnectionController::class, 'qrStatus']);
        Route::post('/{id}/qr/disconnect', [ChannelConnectionController::class, 'qrDisconnect']);
        Route::post('/{id}/qr/sync',       [ChannelConnectionController::class, 'qrSync']);

        // Facebook Page connect flow (OAuth)
        Route::get('/facebook/config',    [ChannelConnectionController::class, 'facebookConfig']);
        Route::post('/facebook/connect',  [ChannelConnectionController::class, 'facebookConnect']);
        Route::post('/facebook/{id}/disconnect', [ChannelConnectionController::class, 'facebookDisconnect'])
            ->where('id', '[0-9a-f-]{36}');
    });

    // Bot Flows (Phase 5A)
    Route::prefix('bot-flows')->group(function () {
        Route::get('/',               [BotFlowController::class, 'index']);
        Route::post('/',              [BotFlowController::class, 'store']);
        Route::get('/{id}',           [BotFlowController::class, 'show']);
        Route::put('/{id}',           [BotFlowController::class, 'update']);
        Route::delete('/{id}',        [BotFlowController::class, 'destroy']);
        Route::post('/{id}/activate', [BotFlowController::class, 'activate']);
        Route::post('/{id}/deactivate',[BotFlowController::class, 'deactivate']);
        Route::post('/{id}/duplicate',[BotFlowController::class, 'duplicate']);
    });

    // Broadcast Campaigns (Phase 5B)
    Route::prefix('campaigns')->group(function () {
        Route::get('/',                    [CampaignController::class, 'index']);
        Route::post('/',                   [CampaignController::class, 'store']);
        Route::get('/{id}',                [CampaignController::class, 'show']);
        Route::post('/{id}/launch',        [CampaignController::class, 'launch']);
        Route::post('/{id}/pause',         [CampaignController::class, 'pause']);
        Route::post('/{id}/resume',        [CampaignController::class, 'resume']);
        Route::post('/{id}/cancel',        [CampaignController::class, 'cancel']);
        Route::get('/{id}/recipients',     [CampaignController::class, 'recipients']);
    });

    // Message Templates (Phase 5B)
    Route::prefix('templates')->group(function () {
        Route::get('/',        [TemplateController::class, 'index']);
        Route::post('/',       [TemplateController::class, 'store']);
        Route::get('/{id}',    [TemplateController::class, 'show']);
        Route::delete('/{id}', [TemplateController::class, 'destroy']);
    });

    // Meta app credentials (multi-app: Facebook / WhatsApp per company)
    Route::prefix('meta-apps')->group(function () {
        Route::get('/',            [MetaAppConfigController::class, 'index']);
        Route::post('/',           [MetaAppConfigController::class, 'store']);
        Route::put('/{id}',        [MetaAppConfigController::class, 'update']);
        Route::delete('/{id}',     [MetaAppConfigController::class, 'destroy']);
        Route::post('/{id}/verify',[MetaAppConfigController::class, 'verify']);
    });

    // AI: config + flow generation
    Route::get('/ai-config',        [AiConfigController::class, 'show']);
    Route::put('/ai-config',        [AiConfigController::class, 'update']);
    Route::post('/ai-config/test',  [AiConfigController::class, 'test']);
    Route::post('/ai/generate-flow',[AiConfigController::class, 'generateFlow']);
    Route::post('/ai/append-nodes', [AiConfigController::class, 'appendNodes']);

    // Analytics (Phase 5C)
    Route::prefix('analytics')->group(function () {
        Route::get('/overview',           [AnalyticsController::class, 'overview']);
        Route::get('/volume-trend',       [AnalyticsController::class, 'volumeTrend']);
        Route::get('/channel-breakdown',  [AnalyticsController::class, 'channelBreakdown']);
        Route::get('/agent-performance',  [AnalyticsController::class, 'agentPerformance']);
        Route::get('/hourly-heatmap',     [AnalyticsController::class, 'hourlyHeatmap']);
        Route::get('/sla-breaches',       [AnalyticsController::class, 'slaBreaches']);
        Route::post('/export',            [AnalyticsController::class, 'export']);
        Route::get('/export/{jobId}/status', fn ($jobId) =>
            response()->json([
                'status' => \Illuminate\Support\Facades\Cache::get("export:{$jobId}:status", 'not_found'),
                'path'   => \Illuminate\Support\Facades\Cache::get("export:{$jobId}:path"),
            ])
        );
    });
});
