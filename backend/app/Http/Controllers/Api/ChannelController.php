<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Channel;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Throwable;

class ChannelController extends Controller
{
    /** Types allowed by the channels schema. */
    private const TYPES = ['whatsapp', 'line', 'email', 'telegram', 'sms', 'webchat'];

    /** Types that receive provider webhooks (i.e. have a callback URL). */
    private const WEBHOOK_TYPES = ['whatsapp', 'line', 'email', 'telegram'];

    /**
     * GET /api/channels
     * List the tenant's channels. Credential VALUES are never returned —
     * only the key names, so the UI can show which fields are configured.
     */
    public function index(Request $request): JsonResponse
    {
        $channels = Channel::where('company_id', $request->user()->company_id)
            ->orderByDesc('created_at')
            ->get();

        return response()->json(['data' => $channels->map(fn (Channel $c) => $this->format($c))]);
    }

    /**
     * POST /api/channels
     * Create a channel. `credentials` are validated as present, then encrypted
     * at rest (APP_KEY) — they are never persisted in plaintext or echoed back.
     */
    public function store(Request $request): JsonResponse
    {
        $company = $request->user()->company;

        // Plan limit: companies.max_channels
        $existing = Channel::where('company_id', $company->id)->count();
        if ($existing >= $company->max_channels) {
            return response()->json([
                'message' => "已达到套餐渠道上限（最多 {$company->max_channels} 个）。请升级套餐或删除未使用的渠道。",
            ], 422);
        }

        $data = $request->validate([
            'name'                 => 'required|string|max:100',
            'type'                 => ['required', 'in:' . implode(',', self::TYPES)],
            'provider'             => 'nullable|string|max:50',
            'credentials'          => 'required|array|min:1',
            'settings'             => 'nullable|array',
            'failover_channel_ids' => 'nullable|array',
            'failover_channel_ids.*' => 'uuid',
            'is_active'            => 'sometimes|boolean',
            'is_inbox_enabled'     => 'sometimes|boolean',
        ]);

        $channel = new Channel();
        $channel->company_id          = $company->id;
        $channel->name                = $data['name'];
        $channel->type                = $data['type'];
        $channel->provider            = $data['provider'] ?? null;
        $channel->settings            = $data['settings'] ?? null;
        $channel->failover_channel_ids = $data['failover_channel_ids'] ?? null;
        $channel->is_active           = $data['is_active'] ?? true;
        $channel->is_inbox_enabled    = $data['is_inbox_enabled'] ?? true;
        $channel->setCredentials($data['credentials']);
        $channel->save();

        return response()->json($this->format($channel), 201);
    }

    /**
     * PUT /api/channels/{id}
     * Update metadata/toggles. If `credentials` is sent with non-empty values
     * they replace the stored set; omitted/null leaves credentials untouched.
     */
    public function update(Request $request, string $id): JsonResponse
    {
        $channel = Channel::where('company_id', $request->user()->company_id)
            ->findOrFail($id);

        $data = $request->validate([
            'name'                 => 'sometimes|string|max:100',
            'provider'             => 'sometimes|nullable|string|max:50',
            'credentials'          => 'sometimes|nullable|array',
            'settings'             => 'sometimes|nullable|array',
            'failover_channel_ids' => 'sometimes|nullable|array',
            'failover_channel_ids.*' => 'uuid',
            'is_active'            => 'sometimes|boolean',
            'is_inbox_enabled'     => 'sometimes|boolean',
        ]);

        foreach (['name', 'provider', 'settings', 'failover_channel_ids', 'is_active', 'is_inbox_enabled'] as $field) {
            if (array_key_exists($field, $data)) {
                $channel->{$field} = $data[$field];
            }
        }

        if (! empty($data['credentials'])) {
            $channel->setCredentials($data['credentials']);
        }

        $channel->save();

        return response()->json($this->format($channel));
    }

    /**
     * DELETE /api/channels/{id}
     * Soft delete — historical conversations keep their channel reference.
     */
    public function destroy(Request $request, string $id): JsonResponse
    {
        Channel::where('company_id', $request->user()->company_id)
            ->findOrFail($id)
            ->delete();

        return response()->json(['message' => 'deleted']);
    }

    // ── Private ───────────────────────────────────────────────────────────────

    private function format(Channel $c): array
    {
        try {
            $credentialKeys = array_keys($c->getCredentials());
        } catch (Throwable) {
            // APP_KEY rotated or corrupt payload — never leak, just report none.
            $credentialKeys = [];
        }

        $baseUrl = rtrim((string) config('app.webhook_base_url', env('WEBHOOK_BASE_URL', 'https://webhook.37182.club')), '/');

        return [
            'id'                   => $c->id,
            'name'                 => $c->name,
            'type'                 => $c->type,
            'provider'             => $c->provider,
            'settings'             => $c->settings,
            'failover_channel_ids' => $c->failover_channel_ids,
            'is_active'            => $c->is_active,
            'is_inbox_enabled'     => $c->is_inbox_enabled,
            'last_webhook_at'      => $c->last_webhook_at?->toISOString(),
            'credential_keys'      => $credentialKeys,
            'webhook_url'          => in_array($c->type, self::WEBHOOK_TYPES, true)
                ? "{$baseUrl}/webhook/{$c->type}/{$c->id}"
                : null,
            'created_at'           => $c->created_at?->toISOString(),
        ];
    }
}
