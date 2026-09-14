<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\CallSession;
use App\Models\Channel;
use App\Models\VoiceAgent;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * AI Voice Agent management + call session browsing.
 *
 * Agent CRUD:
 *   GET    /api/voice/agents              → list (includes computed stats)
 *   POST   /api/voice/agents              → create
 *   GET    /api/voice/agents/{id}         → show
 *   PUT    /api/voice/agents/{id}         → update
 *   DELETE /api/voice/agents/{id}         → delete
 *   POST   /api/voice/agents/{id}/default → make default inbound agent
 *
 * Outbound call:
 *   POST   /api/voice/agents/{id}/call    → start outbound AI call
 *
 * Call sessions:
 *   GET    /api/voice/calls               → paginated call log
 *   GET    /api/voice/calls/{id}          → call session detail + transcript
 */
class VoiceAgentController extends Controller
{
    public function index(): JsonResponse
    {
        $agents = VoiceAgent::orderByDesc('created_at')->get();

        // Append computed stats to each agent (avoids N+1 in the view)
        $agents->each(fn ($a) => $a->append('stats'));

        return response()->json($agents);
    }

    public function show(string $id): JsonResponse
    {
        $agent = VoiceAgent::findOrFail($id);
        $agent->append('stats');

        return response()->json($agent);
    }

    public function store(Request $request): JsonResponse
    {
        $data = $this->validated($request);

        if (! empty($data['is_default'])) {
            VoiceAgent::where('is_default', true)->update(['is_default' => false]);
        }

        $agent = VoiceAgent::create($data + ['company_id' => $request->user()->company_id]);
        $agent->append('stats');

        return response()->json($agent, 201);
    }

    public function update(Request $request, string $id): JsonResponse
    {
        $agent = VoiceAgent::findOrFail($id);
        $data  = $this->validated($request, updating: true);

        if (! empty($data['is_default'])) {
            VoiceAgent::where('is_default', true)->where('id', '!=', $id)->update(['is_default' => false]);
        }

        $agent->update($data);
        $agent->refresh();
        $agent->append('stats');

        return response()->json($agent);
    }

    public function destroy(string $id): JsonResponse
    {
        VoiceAgent::findOrFail($id)->delete();

        return response()->json(['message' => 'deleted']);
    }

    public function makeDefault(string $id): JsonResponse
    {
        $agent = VoiceAgent::findOrFail($id);
        VoiceAgent::where('is_default', true)->update(['is_default' => false]);
        $agent->update(['is_default' => true, 'is_active' => true]);
        $agent->refresh();
        $agent->append('stats');

        return response()->json($agent);
    }

    /**
     * Business-initiated outbound AI call.
     * Generates a WebRTC offer in the gateway, sends it to Meta's Calls API,
     * and completes the bridge when the customer's answer SDP arrives via webhook.
     */
    public function call(Request $request, string $id): JsonResponse
    {
        $data = $request->validate([
            'phone' => 'required|string|max:30',
        ]);

        $agent = VoiceAgent::findOrFail($id);

        $channel = $agent->channel_id
            ? Channel::find($agent->channel_id)
            : Channel::where('type', 'whatsapp')->where('is_active', true)->first();

        if (! $channel) {
            return response()->json(['message' => '没有可用的 WhatsApp 渠道，请先接入渠道'], 422);
        }

        $settings = json_decode(Crypt::decryptString($channel->credentials_encrypted), true) ?? [];
        $token   = $settings['access_token'] ?? null;
        $phoneId = $settings['phone_number_id'] ?? null;

        if (! $token || ! $phoneId) {
            return response()->json(['message' => '该渠道缺少 access_token 或 phone_number_id'], 422);
        }

        try {
            $resp = Http::withHeaders(['X-Internal-Api-Key' => config('services.gateway.internal_api_key')])
                ->timeout(30)
                ->post(rtrim(config('services.gateway.url', 'http://127.0.0.1:3001'), '/') . '/internal/voice/outbound', [
                    'company_id'      => $request->user()->company_id,
                    'channel_id'      => $channel->id,
                    'agent_id'        => $agent->id,
                    'to'              => preg_replace('/[^0-9]/', '', $data['phone']),
                    'access_token'    => $token,
                    'phone_number_id' => $phoneId,
                ]);
        } catch (Throwable $e) {
            Log::error('Voice outbound gateway unreachable', ['error' => $e->getMessage()]);
            return response()->json(['message' => '网关不可达：' . $e->getMessage()], 502);
        }

        if ($resp->failed()) {
            return response()->json([
                'message' => '发起通话失败：' . ($resp->json('error') ?? $resp->body()),
            ], 502);
        }

        $payload = $resp->json('data') ?? [];

        $session = CallSession::create([
            'company_id'     => $request->user()->company_id,
            'channel_id'     => $channel->id,
            'voice_agent_id' => $agent->id,
            'call_id'        => $payload['call_id'] ?? ('out-' . uniqid()),
            'to_number'      => $payload['to'] ?? $data['phone'],
            'direction'      => 'business_initiated',
            'status'         => 'initiating',
            'started_at'     => now(),
        ]);

        return response()->json([
            'data' => [
                'session_id' => $session->id,
                'call_id'    => $session->call_id,
                'to'         => $session->to_number,
                'status'     => $session->status,
            ],
        ], 201);
    }

    /** Paginated call log with optional agent filter. */
    public function calls(Request $request): JsonResponse
    {
        $query = CallSession::with('voiceAgent')
            ->orderByDesc('created_at')
            ->limit(200);

        if ($request->query('agent_id')) {
            $query->where('voice_agent_id', $request->query('agent_id'));
        }

        $calls = $query->get();

        $calls->transform(fn ($c) => [
            'id'               => $c->id,
            'call_id'          => $c->call_id,
            'voice_agent_id'   => $c->voice_agent_id,
            'agent_name'       => $c->voiceAgent?->name,
            'from_number'      => $c->from_number,
            'to_number'        => $c->to_number,
            'direction'        => $c->direction,
            'direction_label'  => CallSession::directionLabel($c->direction),
            'status'           => $c->status,
            'status_label'     => CallSession::statusLabel($c->status),
            'duration_seconds'  => $c->duration_seconds,
            'duration_formatted' => $c->duration_formatted,
            'summary'          => $c->summary,
            'disposition'      => $c->disposition,
            'recording_url'    => $c->recording_url,
            'error'            => $c->error,
            'started_at'       => $c->started_at?->toIso8601String(),
            'ended_at'         => $c->ended_at?->toIso8601String(),
            'created_at'       => $c->created_at?->toIso8601String(),
        ]);

        return response()->json($calls);
    }

    /** Full call session detail including transcript. */
    public function showCall(string $id): JsonResponse
    {
        $session = CallSession::with('voiceAgent')->findOrFail($id);

        return response()->json([
            'id'               => $session->id,
            'call_id'          => $session->call_id,
            'voice_agent_id'   => $session->voice_agent_id,
            'agent_name'       => $session->voiceAgent?->name,
            'from_number'      => $session->from_number,
            'to_number'        => $session->to_number,
            'direction'        => $session->direction,
            'direction_label'  => CallSession::directionLabel($session->direction),
            'status'           => $session->status,
            'status_label'     => CallSession::statusLabel($session->status),
            'duration_seconds' => $session->duration_seconds,
            'duration_formatted' => $session->duration_formatted,
            'transcript'       => $session->transcript ?? [],
            'summary'          => $session->summary,
            'disposition'      => $session->disposition,
            'recording_url'    => $session->recording_url,
            'error'            => $session->error,
            'started_at'       => $session->started_at?->toIso8601String(),
            'ended_at'         => $session->ended_at?->toIso8601String(),
            'created_at'       => $session->created_at?->toIso8601String(),
        ]);
    }

    /** Return available WhatsApp channels for the call destination selector. */
    public function channels(): JsonResponse
    {
        $channels = Channel::where('type', 'whatsapp')
            ->where('is_active', true)
            ->get(['id', 'name']);

        return response()->json($channels);
    }

    // ── Validation ─────────────────────────────────────────────────────────────

    private function validated(Request $request, bool $updating = false): array
    {
        $data = $request->validate([
            'name'                 => $updating ? 'sometimes|string|max:120' : 'required|string|max:120',
            'description'          => 'nullable|string|max:500',
            'channel_id'           => 'nullable|uuid',
            'engine'               => $updating ? 'sometimes|in:openai,groq_sarvam' : 'required|in:openai,groq_sarvam',
            'system_prompt'        => 'nullable|string|max:8000',

            // Greeting
            'greeting'             => 'nullable|string|max:500',

            // Voice settings
            'voice'                => 'nullable|string|max:40',
            'voice_id'             => 'nullable|string|max:60',
            'language'             => 'nullable|string|max:20',
            'voice_speed'          => 'nullable|numeric|min:0.5|max:2.0',
            'voice_pitch'          => 'nullable|numeric|min:0.5|max:2.0',

            // API keys
            'realtime_api_key'     => 'nullable|string|max:300',
            'groq_api_key'         => 'nullable|string|max:300',
            'sarvam_api_key'       => 'nullable|string|max:300',

            // Behaviour
            'max_duration_seconds' => 'nullable|integer|min:30|max:3600',
            'transfer_number'      => 'nullable|string|max:30',
            'summary_enabled'      => 'nullable|boolean',
            'is_active'            => 'nullable|boolean',
            'is_default'           => 'nullable|boolean',
        ]);

        // Encrypt secrets when provided; null means "clear / leave unchanged"
        foreach (['realtime_api_key', 'groq_api_key', 'sarvam_api_key'] as $field) {
            if (array_key_exists($field, $data)) {
                if ($data[$field] !== null && $data[$field] !== '') {
                    $data[$field] = Crypt::encryptString($data[$field]);
                } else {
                    unset($data[$field]); // empty → don't touch the existing encrypted value
                }
            }
        }

        return $data;
    }
}
