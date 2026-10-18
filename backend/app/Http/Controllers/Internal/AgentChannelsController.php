<?php

namespace App\Http\Controllers\Internal;

use App\Http\Controllers\Controller;
use App\Models\AgentChannel;
use App\Models\User;
use Illuminate\Http\JsonResponse;

/**
 * Dipanggil oleh Realtime Server saat agent connect (atau saat menerima
 * AGENT_CHANNELS_UPDATED) untuk menentukan channel room mana yang boleh
 * di-join oleh socket agent tersebut.
 *
 * Agent yang nonaktif / terhapus → 404, Realtime Server treat sebagai
 * zero-assignment (fail-closed).
 */
class AgentChannelsController extends Controller
{
    /**
     * GET /internal/agent/{agentId}/channels
     */
    public function show(string $agentId): JsonResponse
    {
        $agent = User::select('id', 'company_id', 'role')
            ->where('id', $agentId)
            ->where('is_active', true)
            ->firstOrFail();

        $channelIds = AgentChannel::where('agent_id', $agent->id)
            ->where('company_id', $agent->company_id)
            ->pluck('channel_id');

        return response()->json([
            'agent_id'    => $agent->id,
            'company_id'  => $agent->company_id,
            'role'        => $agent->role,
            'channel_ids' => $channelIds,
        ]);
    }
}
