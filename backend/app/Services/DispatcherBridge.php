<?php

namespace App\Services;

use App\Models\Conversation;
use Illuminate\Support\Facades\Redis;

/**
 * Jembatan antara Laravel dan Dispatcher Engine.
 *
 * Dispatcher bisa berupa:
 * A) Node.js process (Phase 1 redis_key_design.js) yang subscribe ke Redis channel
 * B) Laravel-native implementasi langsung (lebih sederhana, kurang scalable)
 *
 * Implementasi ini menggunakan opsi A: publish ke Redis Pub/Sub.
 * Dispatcher subscribe ke 'dispatcher:requests' dan publish hasil ke 'dispatcher:results'.
 */
class DispatcherBridge
{
    /**
     * Request dispatcher untuk assign agent ke conversation.
     * Dipanggil saat:
     * - Conversation baru dibuat (status = pending)
     * - Conversation di-reopen
     * - Agent logout / go offline (reassign)
     */
    public function requestDispatch(Conversation $conv): void
    {
        Redis::publish('dispatcher:requests', json_encode([
            'action'          => 'DISPATCH',
            'company_id'      => $conv->company_id,
            'conversation_id' => $conv->id,
            'intent_tags'     => $conv->intent_tags ?? [],
            'priority'        => $conv->priority,
            'requested_at'    => now()->toISOString(),
        ]));
    }

    /**
     * Catat conversation state ke Redis untuk fast-access oleh Realtime Server.
     * Key: conv:state:{company_id}:{conversation_id}
     */
    public function syncConversationState(Conversation $conv): void
    {
        $key = "conv:state:{$conv->company_id}:{$conv->id}";

        Redis::hMSet($key, [
            'status'            => $conv->status,
            'assigned_agent_id' => $conv->assigned_agent_id ?? '',
            'channel_id'        => $conv->channel_id ?? '',
            'channel_type'      => $conv->channel->type ?? '',
            'is_bot_active'     => '0',
            'contact_id'        => $conv->contact_id,
            'last_activity'     => now()->timestamp,
        ]);

        Redis::expire($key, 3600); // 1 jam TTL
    }
}
