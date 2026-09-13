<?php

namespace App\Services;

use App\Models\Channel;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

/**
 * Per-channel connectivity health checks.
 *
 * Every channel type gets a concrete, cheap probe:
 *
 *   whatsapp      → Graph API /{phone_number_id} with stored access_token
 *   whatsapp_qr   → gateway session status (connected / qr / qr_timeout …)
 *   facebook      → Graph API /me?access_token={page_token}
 *   line          → LINE API /v2/bot/info with channel_access_token
 *   telegram      → Telegram getMe with bot token
 *   email / sms   → presence of configured credentials (no live ping)
 *
 * Health is written to channels.settings.health = {
 *   status: 'healthy'|'degraded'|'down'|'unknown', reason, checked_at }.
 * The UI shows it as a badge; the watchdog uses it to auto-stop dead channels.
 */
class ChannelHealthService
{
    public function check(Channel $channel): array
    {
        try {
            $result = match ($channel->type) {
                'whatsapp'    => $this->checkWhatsappCloud($channel),
                'whatsapp_qr' => $this->checkWhatsappQr($channel),
                'facebook'    => $this->checkFacebook($channel),
                'line'        => $this->checkLine($channel),
                'telegram'    => $this->checkTelegram($channel),
                default       => $this->checkConfigured($channel),
            };
        } catch (\Throwable $e) {
            $result = ['status' => 'down', 'reason' => '检测异常: ' . $e->getMessage()];
        }

        $this->persist($channel, $result);

        return $result;
    }

    /** Check all active channels of a company; returns summary counts. */
    public function checkAll(string $companyId): array
    {
        $summary = ['healthy' => 0, 'degraded' => 0, 'down' => 0, 'unknown' => 0];

        Channel::where('company_id', $companyId)
            ->where('is_active', true)
            ->get()
            ->each(function (Channel $channel) use (&$summary) {
                $result = $this->check($channel);
                $summary[$result['status']] = ($summary[$result['status']] ?? 0) + 1;
            });

        return $summary;
    }

    // ── Per-type probes ───────────────────────────────────────────────────────

    private function checkWhatsappCloud(Channel $channel): array
    {
        try {
            $creds = $channel->getCredentials();
        } catch (\Throwable) {
            return ['status' => 'down', 'reason' => '凭据解密失败'];
        }

        $token = $creds['access_token'] ?? null;
        $phoneId = $creds['phone_number_id'] ?? null;
        if (! $token || ! $phoneId) {
            return ['status' => 'down', 'reason' => '缺少 phone_number_id 或 access_token'];
        }

        $resp = Http::withToken($token)->timeout(10)
            ->get("https://graph.facebook.com/v19.0/{$phoneId}", ['fields' => 'display_phone_number,verified_name']);

        if ($resp->status() === 401) {
            return ['status' => 'down', 'reason' => 'Access token 已失效，请重新获取'];
        }
        if ($resp->failed()) {
            return ['status' => 'degraded', 'reason' => 'Graph API 异常: HTTP ' . $resp->status()];
        }

        $phone = $resp->json('display_phone_number');
        return ['status' => 'healthy', 'reason' => $phone ? "号码 {$phone} 正常" : '连接正常'];
    }

    private function checkWhatsappQr(Channel $channel): array
    {
        $baseUrl  = rtrim(config('services.gateway.url'), '/');
        $apiKey   = config('services.gateway.internal_api_key');

        $resp = Http::withHeaders(['X-Internal-Api-Key' => $apiKey])
            ->timeout(15)
            ->get("{$baseUrl}/internal/waqr/{$channel->id}/status");

        if ($resp->failed()) {
            return ['status' => 'down', 'reason' => '网关不可达或会话查询失败'];
        }

        $status = $resp->json('data.status', 'unknown');

        return match ($status) {
            'connected'  => ['status' => 'healthy', 'reason' => '已连接 ' . ($resp->json('data.phone') ?? '')],
            'qr'         => ['status' => 'degraded', 'reason' => '等待扫码中…'],
            'qr_timeout' => ['status' => 'down', 'reason' => '扫码超时，会话已自动停止'],
            'rescan_needed' => ['status' => 'down', 'reason' => '会话失效，需要重新扫码'],
            'connecting', 'reconnecting' => ['status' => 'degraded', 'reason' => '连接中…'],
            default      => ['status' => 'down', 'reason' => "会话状态: {$status}"],
        };
    }

    private function checkFacebook(Channel $channel): array
    {
        try {
            $creds = $channel->getCredentials();
        } catch (\Throwable) {
            return ['status' => 'down', 'reason' => '凭据解密失败'];
        }

        $token = $creds['page_access_token'] ?? null;
        if (! $token) {
            return ['status' => 'down', 'reason' => '缺少 page_access_token'];
        }

        $resp = Http::timeout(10)->get('https://graph.facebook.com/v21.0/me', [
            'fields'       => 'id,name',
            'access_token' => $token,
        ]);

        if ($resp->status() === 401 || $resp->status() === 400) {
            return ['status' => 'down', 'reason' => 'Page token 已失效，请重新授权'];
        }
        if ($resp->failed()) {
            return ['status' => 'degraded', 'reason' => 'Graph API 异常: HTTP ' . $resp->status()];
        }

        return ['status' => 'healthy', 'reason' => '主页 ' . ($resp->json('name') ?? '') . ' 正常'];
    }

    private function checkLine(Channel $channel): array
    {
        try {
            $creds = $channel->getCredentials();
        } catch (\Throwable) {
            return ['status' => 'down', 'reason' => '凭据解密失败'];
        }

        $token = $creds['channel_access_token'] ?? null;
        if (! $token) {
            return ['status' => 'down', 'reason' => '缺少 channel_access_token'];
        }

        $resp = Http::withToken($token)->timeout(10)->get('https://api.line.me/v2/bot/info');

        if ($resp->status() === 401) {
            return ['status' => 'down', 'reason' => 'Channel access token 已失效'];
        }
        if ($resp->failed()) {
            return ['status' => 'degraded', 'reason' => 'LINE API 异常: HTTP ' . $resp->status()];
        }

        return ['status' => 'healthy', 'reason' => 'Bot ' . ($resp->json('displayName') ?? '') . ' 正常'];
    }

    private function checkTelegram(Channel $channel): array
    {
        try {
            $creds = $channel->getCredentials();
        } catch (\Throwable) {
            return ['status' => 'down', 'reason' => '凭据解密失败'];
        }

        $token = $creds['bot_token'] ?? null;
        if (! $token) {
            return ['status' => 'down', 'reason' => '缺少 bot_token'];
        }

        $resp = Http::timeout(10)->get("https://api.telegram.org/bot{$token}/getMe");

        if ($resp->json('ok') !== true) {
            return ['status' => 'down', 'reason' => 'Bot token 无效或网络异常'];
        }

        return ['status' => 'healthy', 'reason' => 'Bot @' . ($resp->json('result.username') ?? '?') . ' 正常'];
    }

    /** Fallback for types without a live probe (email, sms, webchat). */
    private function checkConfigured(Channel $channel): array
    {
        try {
            $creds = $channel->getCredentials();
        } catch (\Throwable) {
            return ['status' => 'down', 'reason' => '凭据解密失败'];
        }

        if (empty($creds) || $creds === ['mode' => $channel->type]) {
            return ['status' => 'degraded', 'reason' => '凭据未配置'];
        }

        return ['status' => 'healthy', 'reason' => '凭据已配置'];
    }

    private function persist(Channel $channel, array $result): void
    {
        $settings           = $channel->settings ?? [];
        $settings['health'] = [
            'status'     => $result['status'],
            'reason'     => $result['reason'] ?? null,
            'checked_at' => now()->toIso8601String(),
        ];
        $channel->settings = $settings;
        $channel->save();
    }
}
