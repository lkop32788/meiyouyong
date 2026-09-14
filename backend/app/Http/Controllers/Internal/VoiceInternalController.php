<?php

namespace App\Http\Controllers\Internal;

use App\Http\Controllers\Controller;
use App\Models\CallSession;
use App\Models\VoiceAgent;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Crypt;

/**
 * Internal voice endpoints — called by the Node gateway (X-Internal-Key):
 *
 * GET  /internal/voice/resolve-agent?company_id=…  → default active agent (decrypted keys)
 * POST /internal/voice/sessions                    → create / update call session
 * POST /internal/voice/session-status              → status / transcript / summary updates
 */
class VoiceInternalController extends Controller
{
    public function resolveAgent(Request $request): JsonResponse
    {
        $request->validate(['company_id' => 'required|uuid']);

        $agent = VoiceAgent::withoutGlobalScope(\App\Models\Scopes\TenantScope::class)
            ->where('company_id', $request->query('company_id'))
            ->where('is_active', true)
            ->orderByDesc('is_default')
            ->first();

        if (! $agent) {
            return response()->json(['data' => null]);
        }

        return response()->json(['data' => [
            'id'                   => $agent->id,
            'name'                 => $agent->name,
            'engine'               => $agent->engine,
            'system_prompt'        => $agent->system_prompt,
            'greeting'             => $agent->greeting,
            'voice'                => $agent->voice,
            'voice_id'             => $agent->voice_id,
            'language'             => $agent->language,
            'voice_speed'          => $agent->voice_speed,
            'voice_pitch'          => $agent->voice_pitch,
            'max_duration_seconds' => $agent->max_duration_seconds,
            'transfer_number'      => $agent->transfer_number,
            'summary_enabled'      => $agent->summary_enabled,
            'realtime_api_key'     => $agent->realtime_api_key ? Crypt::decryptString($agent->realtime_api_key) : null,
            'groq_api_key'         => $agent->groq_api_key ? Crypt::decryptString($agent->groq_api_key) : null,
            'sarvam_api_key'       => $agent->sarvam_api_key ? Crypt::decryptString($agent->sarvam_api_key) : null,
        ]]);
    }

    public function createSession(Request $request): JsonResponse
    {
        $data = $request->validate([
            'company_id'      => 'required|uuid',
            'channel_id'      => 'nullable|uuid',
            'voice_agent_id'  => 'nullable|uuid',
            'call_id'         => 'required|string|max:80',
            'from_number'    => 'nullable|string|max:30',
            'to_number'      => 'nullable|string|max:30',
            'direction'      => 'required|in:user_initiated,business_initiated',
            'status'         => 'required|string|max:24',
            'error'          => 'nullable|string|max:1000',
            'started'        => 'nullable|boolean',
        ]);

        $session = CallSession::withoutGlobalScope(\App\Models\Scopes\TenantScope::class)
            ->updateOrCreate(
                ['call_id' => $data['call_id'], 'company_id' => $data['company_id']],
                collect($data)->except('call_id', 'company_id', 'started')->all()
                + ['started_at' => now()]
            );

        return response()->json(['data' => ['id' => $session->id]]);
    }

    public function sessionStatus(Request $request): JsonResponse
    {
        $data = $request->validate([
            'session_id'       => 'nullable|uuid',
            'call_id'          => 'nullable|string|max:80',
            'company_id'       => 'nullable|uuid',
            'status'           => 'nullable|string|max:24',
            'transcript'       => 'nullable|array',
            'duration_seconds' => 'nullable|integer|min:0',
            'summary'          => 'nullable|string|max:2000',
            'disposition'      => 'nullable|string|max:40',
            'recording_url'   => 'nullable|string|max:500',
            'error'           => 'nullable|string|max:1000',
            'ended'           => 'nullable|boolean',
        ]);

        $query = CallSession::withoutGlobalScope(\App\Models\Scopes\TenantScope::class)->query();

        if (! empty($data['session_id'])) {
            $query->where('id', $data['session_id']);
        } elseif (! empty($data['call_id'])) {
            $query->where('call_id', $data['call_id']);
            if (! empty($data['company_id'])) {
                $query->where('company_id', $data['company_id']);
            }
        } else {
            return response()->json(['message' => 'session_id or call_id required'], 422);
        }

        $session = $query->first();

        if (! $session) {
            return response()->json(['message' => 'session not found'], 404);
        }

        $update = collect($data)->only([
            'status', 'transcript', 'duration_seconds',
            'summary', 'disposition', 'recording_url', 'error',
        ])->all();

        if (! empty($data['ended'])) {
            $update['ended_at'] = now();

            if (in_array($session->status, ['initiating', 'incoming', 'ringing', 'connecting'], true)
                && empty($update['status'])) {
                $update['status'] = 'missed';
            }
        }

        $session->update($update);

        return response()->json(['data' => ['ok' => true]]);
    }
}
