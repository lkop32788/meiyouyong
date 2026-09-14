<?php

use App\Http\Controllers\Internal\AgentController;
use App\Http\Controllers\Internal\AgentSkillsController;
use App\Http\Controllers\Internal\CacheController;
use App\Http\Controllers\Internal\ConversationStateController;
use App\Http\Controllers\Internal\VoiceInternalController;
use Illuminate\Support\Facades\Route;

// Internal service-to-service routes — protected by X-Internal-Key header
// Tidak terekspos ke public internet. Dipanggil dari:
//   - Node.js gateway     (cache invalidation)
//   - Realtime Server     (agent presence, skills, conversation state)

Route::middleware('internal.key')->prefix('internal')->group(function () {

    Route::get('/ping', fn () => response()->json(['ok' => true]));

    // Cache invalidation
    Route::post('/cache/invalidate/channel', [CacheController::class, 'invalidateChannel']);

    // Agent presence (dipanggil Realtime Server saat socket event)
    Route::post('/agent/heartbeat', [AgentController::class, 'heartbeat']);
    Route::post('/agent/offline',   [AgentController::class, 'offline']);

    // Agent skills (dipanggil Realtime Server saat agent connect)
    Route::get('/agent/{agentId}/skills', [AgentSkillsController::class, 'show'])
        ->where('agentId', '[0-9a-f-]{36}');

    // Conversation state (Redis HASH untuk Realtime Server event routing)
    Route::get('/conversations/{id}/state', [ConversationStateController::class, 'show'])
        ->where('id', '[0-9a-f-]{36}');

    // AI voice calling (dipanggil gateway saat WhatsApp call webhook)
    Route::get('/voice/resolve-agent',  [VoiceInternalController::class, 'resolveAgent']);
    Route::post('/voice/sessions',      [VoiceInternalController::class, 'createSession']);
    Route::post('/voice/session-status', [VoiceInternalController::class, 'sessionStatus']);
});
