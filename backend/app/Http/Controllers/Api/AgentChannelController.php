<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\AgentChannel;
use App\Models\Channel;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class AgentChannelController extends Controller
{
    /**
     * GET /api/agent-channels
     * Query: ?agent_id=uuid (optional) — filter by agent
     */
    public function index(Request $request): JsonResponse
    {
        if (! $request->user()->canOverrideAssignment()) {
            return response()->json(['message' => 'Forbidden'], 403);
        }

        $query = AgentChannel::with(['agent:id,name,email', 'channel:id,name,type,is_active'])
            ->where('company_id', $request->user()->company_id);

        if ($request->query('agent_id')) {
            $query->where('agent_id', $request->query('agent_id'));
        }

        $rows = $query->orderByDesc('created_at')->get();

        return response()->json($rows->map(fn ($ac) => [
            'id'          => $ac->id,
            'agent_id'    => $ac->agent_id,
            'agent_name'  => $ac->agent?->name,
            'channel_id'  => $ac->channel_id,
            'channel_name'=> $ac->channel?->name,
            'channel_type'=> $ac->channel?->type,
            'created_at'  => $ac->created_at?->toISOString(),
        ]));
    }

    /**
     * POST /api/agent-channels
     * Body: { agent_id, channel_id }
     */
    public function store(Request $request): JsonResponse
    {
        if (! $request->user()->canOverrideAssignment()) {
            return response()->json(['message' => 'Forbidden'], 403);
        }

        $data = $request->validate([
            'agent_id'   => 'required|uuid',
            'channel_id' => 'required|uuid',
        ]);

        $companyId = $request->user()->company_id;

        // Agent must belong to the same company and be an agent/supervisor/admin
        $agent = User::where('id', $data['agent_id'])
            ->where('company_id', $companyId)
            ->whereIn('role', ['agent', 'supervisor', 'admin'])
            ->first();

        if (! $agent) {
            return response()->json(['message' => '未找到该客服账号'], 422);
        }

        // Channel must belong to the same company and be active
        $channel = Channel::where('id', $data['channel_id'])
            ->where('company_id', $companyId)
            ->where('is_active', true)
            ->first();

        if (! $channel) {
            return response()->json(['message' => '未找到该渠道或渠道未激活'], 422);
        }

        // Upsert — delete existing first, then insert (idempotent)
        $existing = AgentChannel::where('agent_id', $data['agent_id'])
            ->where('channel_id', $data['channel_id'])
            ->first();

        if ($existing) {
            return response()->json([
                'id'          => $existing->id,
                'agent_id'    => $existing->agent_id,
                'channel_id'  => $existing->channel_id,
                'created_at'  => $existing->created_at?->toISOString(),
            ]);
        }

        $ac = AgentChannel::create([
            'agent_id'   => $data['agent_id'],
            'channel_id' => $data['channel_id'],
            'company_id' => $companyId,
        ]);

        return response()->json([
            'id'          => $ac->id,
            'agent_id'    => $ac->agent_id,
            'channel_id'  => $ac->channel_id,
            'created_at'  => $ac->created_at?->toISOString(),
        ], 201);
    }

    /**
     * DELETE /api/agent-channels/{id}
     */
    public function destroy(Request $request, string $id): JsonResponse
    {
        if (! $request->user()->canOverrideAssignment()) {
            return response()->json(['message' => 'Forbidden'], 403);
        }

        $ac = AgentChannel::where('company_id', $request->user()->company_id)
            ->findOrFail($id);

        $ac->delete();

        return response()->json(['message' => 'deleted']);
    }
}
