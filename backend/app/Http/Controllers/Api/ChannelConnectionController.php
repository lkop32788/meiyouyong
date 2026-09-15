<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Channel;
use App\Http\Controllers\Api\MetaAppConfigController;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;
use Illuminate\Validation\Rule;

/**
 * Channel connect flows (borrowed from wabapanel, adapted to OmniClick):
 *
 * - WhatsApp QR  : proxy start/status/disconnect to the gateway's Baileys
 *                  session manager via the internal API
 * - Facebook     : OAuth "one-click" Page connect — exchange the FB.login
 *                  code, list Pages, store the Page token, subscribe the page
 *                  to our app's webhook
 */
class ChannelConnectionController extends Controller
{
    // ── Telegram ─────────────────────────────────────────────────────────────

    /**
     * POST /api/channels/{id}/telegram/register-webhook
     *
     * Telegram inbound could never have worked: nothing in the repo ever called
     * setWebhook, so Telegram had no URL to deliver to. And even with a URL, the
     * gateway's verifyTelegram requires an X-Telegram-Bot-Api-Secret-Token
     * header that Telegram only sends when the webhook was registered WITH a
     * secret_token — which it reads back from credentials as app_secret /
     * channel_secret, while the UI only ever wrote bot_token.
     *
     * This closes both halves: mint a secret, register it with Telegram, and
     * store it under the key the gateway already looks for.
     */
    public function telegramRegisterWebhook(Request $request, string $id): JsonResponse
    {
        $channel = Channel::where('company_id', $request->user()->company_id)
            ->where('type', 'telegram')
            ->findOrFail($id);

        $creds = $channel->getCredentials();
        $token = $creds['bot_token'] ?? null;

        if (! $token) {
            return response()->json(['message' => '该渠道缺少 bot_token，请先在凭据中填写。'], 422);
        }

        // Reuse an existing secret so re-registering does not invalidate
        // in-flight deliveries the gateway is still verifying against.
        $secret = $creds['channel_secret'] ?? Str::random(48);

        $baseUrl    = rtrim((string) config('app.webhook_base_url', env('WEBHOOK_BASE_URL', 'https://webhook.37182.club')), '/');
        $webhookUrl = "{$baseUrl}/webhook/telegram/{$channel->id}";

        $resp = Http::acceptJson()->timeout(15)->post("https://api.telegram.org/bot{$token}/setWebhook", [
            'url'          => $webhookUrl,
            'secret_token' => $secret,
            // Telegram silently drops updates we have no normalizer for.
            'allowed_updates' => ['message', 'edited_message', 'callback_query'],
        ]);

        if (! $resp->successful() || $resp->json('ok') !== true) {
            Log::warning('Telegram setWebhook failed', [
                'channel_id' => $channel->id,
                'error_code' => $resp->json('error_code') ?? $resp->status(),
            ]);

            return response()->json([
                'message' => 'Telegram 拒绝了 webhook 注册：' . ($resp->json('description') ?? '未知错误'),
            ], 502);
        }

        $creds['channel_secret'] = $secret;
        $channel->setCredentials($creds);
        $channel->save();

        return response()->json([
            'webhook_url' => $webhookUrl,
            'bot'         => Http::acceptJson()->timeout(10)
                ->get("https://api.telegram.org/bot{$token}/getMe")->json('result.username'),
        ]);
    }

    // ── WhatsApp QR (Baileys on the gateway) ─────────────────────────────────

    /** POST /api/channels/{id}/qr/start */
    public function qrStart(Request $request, string $id): JsonResponse
    {
        $channel = $this->findQrChannel($request, $id);

        $resp = $this->gatewayPost("/internal/waqr/{$channel->id}/start", [
            'company_id' => $request->user()->company_id,
        ]);
        if (! $resp['ok']) {
            return response()->json(['message' => $resp['error']], 502);
        }

        return response()->json(['data' => $resp['data']]);
    }

    /** GET /api/channels/{id}/qr/status — poll QR image + connection state */
    public function qrStatus(Request $request, string $id): JsonResponse
    {
        $channel = $this->findQrChannel($request, $id);

        $resp = $this->gatewayGet("/internal/waqr/{$channel->id}/status");
        if (! $resp['ok']) {
            return response()->json(['message' => $resp['error']], 502);
        }

        return response()->json(['data' => $resp['data']]);
    }

    /** POST /api/channels/{id}/qr/disconnect — log out + wipe session */
    public function qrDisconnect(Request $request, string $id): JsonResponse
    {
        $channel = $this->findQrChannel($request, $id);

        $resp = $this->gatewayPost("/internal/waqr/{$channel->id}/disconnect");
        if (! $resp['ok']) {
            return response()->json(['message' => $resp['error']], 502);
        }

        return response()->json(['message' => 'disconnected']);
    }

    /** POST /api/channels/{id}/qr/sync — pull messages received while offline */
    public function qrSync(Request $request, string $id): JsonResponse
    {
        $channel = $this->findQrChannel($request, $id);

        $resp = $this->gatewayPost("/internal/waqr/{$channel->id}/sync");
        if (! $resp['ok']) {
            return response()->json(['message' => $resp['error']], 502);
        }

        return response()->json(['message' => 'syncing']);
    }

    // ── Facebook Page connect (Messenger) ────────────────────────────────────

    /** GET /api/channels/facebook/config — available Meta apps + connected pages */
    public function facebookConfig(Request $request): JsonResponse
    {
        $companyId = $request->user()->company_id;

        // All configured Meta apps (multi-app support); fall back to .env
        $apps = collect($request->user()->company->settings['meta_apps'] ?? [])
            ->filter(fn ($a) => ($a['kind'] ?? null) === 'facebook')
            ->map(fn ($a) => [
                'id'        => $a['id'],
                'label'     => $a['label'],
                'app_id'    => $a['app_id'],
                'config_id' => $a['config_id'] ?? null,
            ])
            ->values();

        if ($apps->isEmpty() && config('services.facebook.app_id')) {
            $apps->push([
                'id'        => 'env',
                'label'     => '默认应用（.env）',
                'app_id'    => config('services.facebook.app_id'),
                'config_id' => config('services.facebook.config_id'),
            ]);
        }

        $connected = Channel::where('company_id', $companyId)
            ->where('type', 'facebook')
            ->get(['id', 'name', 'settings', 'is_active']);

        return response()->json([
            'data' => [
                'apps'      => $apps,
                'channels'  => $connected->map(fn ($c) => [
                    'id'        => $c->id,
                    'name'      => $c->name,
                    'page_id'   => $c->settings['page_id'] ?? null,
                    'page_name' => $c->settings['page_name'] ?? null,
                    'is_active' => $c->is_active,
                ]),
            ],
        ]);
    }

    /**
     * POST /api/channels/facebook/connect  { code, pageId?, redirectUri?, appId? }
     * Exchange the FB.login code → list Pages → store Page token as a channel.
     * Uses the per-company Meta app (multi-app) matching appId, or the first
     * configured app, or the .env fallback. If the user manages several Pages
     * and none was selected, returns needs_page_choice for the frontend picker.
     */
    public function facebookConnect(Request $request): JsonResponse
    {
        $request->validate([
            'code'        => 'required|string',
            'pageId'      => 'nullable|string',
            'redirectUri' => 'nullable|string',
            'appId'       => 'nullable|string',
        ]);

        $companyId = $request->user()->company_id;

        // Multi-app: prefer the app the frontend logged in with
        $app = MetaAppConfigController::resolveFor($companyId, 'facebook', $request->input('appId'));

        if ($app) {
            $appId     = $app['app_id'];
            $appSecret = $app['app_secret'];
        } else {
            // .env fallback (single-app legacy mode)
            $appId     = config('services.facebook.app_id');
            $appSecret = config('services.facebook.app_secret');
        }

        if (! $appId || ! $appSecret) {
            return response()->json(['message' => '尚未配置 Meta 应用。请在「Meta 应用配置」中添加 App ID 和 Secret。'], 503);
        }

        $companyId = $request->user()->company_id;

        // Plan limit
        $existing = Channel::where('company_id', $companyId)->count();
        if ($existing >= $request->user()->company->max_channels && ! $request->input('pageId')) {
            return response()->json([
                'message' => "已达到套餐渠道上限（最多 {$request->user()->company->max_channels} 个）。",
            ], 422);
        }

        // 1. Exchange code → user access token (FB.login codes use empty redirect_uri)
        $userToken = $this->exchangeFacebookCode($appId, $appSecret, $request->input('code'), $request->input('redirectUri'));
        if (! $userToken) {
            return response()->json(['message' => 'Facebook 授权码交换失败。'], 401);
        }

        // 2. List Pages the user manages
        $pagesResp = Http::timeout(15)->get(self::GRAPH . '/me/accounts', [
            'fields'      => 'id,name,access_token',
            'access_token' => $userToken,
        ]);
        $pages = $pagesResp->json('data', []);
        if ($pagesResp->failed() || empty($pages)) {
            return response()->json(['message' => '该 Facebook 账号没有可管理的公共主页。'], 400);
        }

        // 3. Pick the page (single → auto; multiple → ask unless pageId given)
        $pageId = $request->input('pageId');
        $page   = $pageId
            ? collect($pages)->first(fn ($p) => (string) $p['id'] === (string) $pageId)
            : (count($pages) === 1 ? $pages[0] : null);

        if (! $page) {
            return response()->json([
                'data' => [
                    'needs_page_choice' => true,
                    'pages'             => collect($pages)->map(fn ($p) => ['id' => $p['id'], 'name' => $p['name']])->values(),
                ],
            ]);
        }

        // 4. Create/update the facebook channel with encrypted credentials
        $channel = Channel::where('company_id', $companyId)
            ->where('type', 'facebook')
            ->get()
            ->first(fn ($c) => ($c->settings['page_id'] ?? null) === (string) $page['id']);

        if (! $channel) {
            $channel = new Channel();
            $channel->company_id = $companyId;
            $channel->type       = 'facebook';
            $channel->name       = $page['name'];
        } else {
            $channel->name = $page['name'];
        }
        $channel->settings = [
            'page_id'   => (string) $page['id'],
            'page_name' => $page['name'] ?? '',
        ];
        $channel->setCredentials(['page_access_token' => $page['access_token']]);
        $channel->is_active        = true;
        $channel->is_inbox_enabled = true;
        $channel->save();

        // 5. Subscribe our app to the Page's messaging events (best effort)
        $this->subscribePageToApp($page['id'], $page['access_token']);

        Log::info('Facebook Page connected', ['company_id' => $companyId, 'page_id' => $page['id']]);

        return response()->json([
            'data' => [
                'connected' => true,
                'channel_id' => $channel->id,
                'page_id'   => $page['id'],
                'page_name' => $page['name'],
            ],
        ], 201);
    }

    /** DELETE /api/channels/{id} already removes the channel; this only marks FB off. */
    public function facebookDisconnect(Request $request, string $id): JsonResponse
    {
        $channel = Channel::where('company_id', $request->user()->company_id)
            ->where('type', 'facebook')
            ->findOrFail($id);

        $channel->update(['is_active' => false]);

        return response()->json(['message' => 'disconnected']);
    }

    // ── Private ───────────────────────────────────────────────────────────────

    private const GRAPH = 'https://graph.facebook.com/v21.0';
    private const PAGE_FIELDS = 'messages,messaging_postbacks,message_reads,message_reactions,messaging_handovers';

    private function findQrChannel(Request $request, string $id): Channel
    {
        $channel = Channel::where('company_id', $request->user()->company_id)
            ->where('type', 'whatsapp_qr')
            ->findOrFail($id);

        if ($channel->getCredentials() === [] && ! $channel->exists) {
            abort(422, 'Channel is not a QR channel');
        }

        return $channel;
    }

    private function gatewayPost(string $path, array $body = []): array
    {
        $resp = Http::withHeaders(['X-Internal-Api-Key' => config('services.gateway.internal_api_key')])
            ->timeout(60)
            ->post(rtrim(config('services.gateway.url'), '/') . $path, $body);

        if ($resp->failed()) {
            return ['ok' => false, 'error' => $resp->json('error') ?? "Gateway HTTP {$resp->status()}"];
        }

        return ['ok' => true, 'data' => $resp->json('data')];
    }

    private function gatewayGet(string $path): array
    {
        $resp = Http::withHeaders(['X-Internal-Api-Key' => config('services.gateway.internal_api_key')])
            ->timeout(30)
            ->get(rtrim(config('services.gateway.url'), '/') . $path);

        if ($resp->failed()) {
            return ['ok' => false, 'error' => $resp->json('error') ?? "Gateway HTTP {$resp->status()}"];
        }

        return ['ok' => true, 'data' => $resp->json('data')];
    }

    private function exchangeFacebookCode(string $appId, string $appSecret, string $code, ?string $redirectUri): ?string
    {
        // The FB.login JS SDK issues codes bound to an empty redirect_uri;
        // plain OAuth redirects bind to the real one. Try both (wabapanel trick).
        foreach (array_unique(['', (string) $redirectUri]) as $uri) {
            $resp = Http::timeout(15)->get(self::GRAPH . '/oauth/access_token', [
                'client_id'     => $appId,
                'client_secret' => $appSecret,
                'redirect_uri'  => $uri,
                'code'          => $code,
            ]);
            if ($resp->successful() && $resp->json('access_token')) {
                return $resp->json('access_token');
            }
        }
        return null;
    }

    private function subscribePageToApp(string $pageId, string $pageToken): void
    {
        try {
            Http::withToken($pageToken)->timeout(10)
                ->post(self::GRAPH . "/{$pageId}/subscribed_apps", ['subscribed_fields' => self::PAGE_FIELDS]);
        } catch (\Throwable $e) {
            Log::warning('Page subscribe failed: ' . $e->getMessage());
        }
    }
}
