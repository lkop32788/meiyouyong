<?php

namespace App\Services;

use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * OpenAI-compatible chat client with multi-provider + custom-endpoint support
 * (pattern borrowed from wabapanel's aiService).
 *
 * Providers:
 *   - openai    → api.openai.com/v1            (model: gpt-4o-mini)
 *   - deepseek  → api.deepseek.com/v1          (model: deepseek-chat)
 *   - xai       → api.x.ai/v1                  (model: grok-3-mini)
 *   - gemini    → generativelanguage.googleapis.com/v1beta (OpenAI-compat path)
 *   - anthropic → api.anthropic.com/v1         (native /messages API)
 *   - custom    → any OpenAI-compatible endpoint (vLLM, Ollama, OneAPI, 智谱…)
 *
 * Config comes from companies.settings.ai_config (set via /api/ai-config):
 *   { provider, api_key (encrypted), base_url?, model? }
 * Falls back to env: AI_PROVIDER, AI_API_KEY, AI_BASE_URL, AI_MODEL.
 */
class AiClientService
{
    private const PROVIDERS = [
        'openai'    => ['base_url' => 'https://api.openai.com/v1',         'model' => 'gpt-4o-mini',       'label' => 'OpenAI'],
        'deepseek'  => ['base_url' => 'https://api.deepseek.com/v1',       'model' => 'deepseek-chat',     'label' => 'DeepSeek'],
        'xai'       => ['base_url' => 'https://api.x.ai/v1',               'model' => 'grok-3-mini',       'label' => 'xAI (Grok)'],
        'gemini'    => ['base_url' => 'https://generativelanguage.googleapis.com/v1beta/openai', 'model' => 'gemini-2.5-flash', 'label' => 'Google Gemini'],
        'anthropic' => ['base_url' => 'https://api.anthropic.com/v1',      'model' => 'claude-sonnet-4-20250514', 'label' => 'Anthropic Claude'],
        'custom'    => ['base_url' => '',                                  'model' => '',                  'label' => '自定义（OpenAI 兼容）'],
    ];

    /**
     * Resolve the active AI config for a company.
     *
     * @return array{ provider: string, api_key: string, base_url: string, model: string }|null
     */
    public function resolveConfig(string $companyId): ?array
    {
        $company = \App\Models\Company::find($companyId);
        $cfg     = $company?->settings['ai_config'] ?? [];

        $provider = $cfg['provider'] ?? env('AI_PROVIDER', 'openai');
        if (! isset(self::PROVIDERS[$provider])) {
            $provider = 'openai';
        }

        $encKey = $cfg['api_key'] ?? null;
        if ($encKey) {
            try {
                $apiKey = Crypt::decryptString($encKey);
            } catch (Throwable) {
                return null;
            }
        } else {
            $apiKey = env('AI_API_KEY');
        }

        if (! $apiKey) {
            return null;
        }

        return [
            'provider' => $provider,
            'api_key'  => $apiKey,
            'base_url' => rtrim($cfg['base_url'] ?? env('AI_BASE_URL', self::PROVIDERS[$provider]['base_url']), '/'),
            'model'    => $cfg['model'] ?? env('AI_MODEL', self::PROVIDERS[$provider]['model']),
        ];
    }

    /**
     * Send a chat completion; returns the assistant's text content.
     *
     * @param array<int, array{role: string, content: string}> $messages
     * @throws \RuntimeException on config/network/format errors
     */
    public function chat(string $companyId, array $messages, int $maxTokens = 2000, float $temperature = 0.4): string
    {
        $cfg = $this->resolveConfig($companyId);
        if (! $cfg) {
            throw new \RuntimeException('AI 服务未配置。请先在「设置 → AI 配置」中添加 API Key。');
        }

        if ($cfg['provider'] === 'anthropic') {
            return $this->anthropicChat($cfg, $messages, $maxTokens, $temperature);
        }

        if (empty($cfg['base_url'])) {
            throw new \RuntimeException('自定义 AI 接口需要填写 Base URL。');
        }

        $resp = Http::withToken($cfg['api_key'])
            ->timeout(120)
            ->post("{$cfg['base_url']}/chat/completions", [
                'model'       => $cfg['model'],
                'messages'    => $messages,
                'temperature' => $temperature,
                'max_tokens'  => $maxTokens,
            ]);

        if ($resp->status() === 401) {
            throw new \RuntimeException('AI API Key 无效（401）。');
        }
        if ($resp->failed()) {
            Log::warning('AI chat failed', ['provider' => $cfg['provider'], 'status' => $resp->status()]);
            throw new \RuntimeException('AI 接口错误: HTTP ' . $resp->status());
        }

        $content = $resp->json('choices.0.message.content');
        if (! is_string($content) || $content === '') {
            throw new \RuntimeException('AI 返回了空内容。');
        }

        return $content;
    }

    private function anthropicChat(array $cfg, array $messages, int $maxTokens, float $temperature): string
    {
        $system = collect($messages)->where('role', 'system')->pluck('content')->implode("\n");
        $rest   = collect($messages)
            ->reject(fn ($m) => $m['role'] === 'system')
            ->map(fn ($m) => ['role' => $m['role'] === 'assistant' ? 'assistant' : 'user', 'content' => $m['content']])
            ->values()
            ->all();

        $resp = Http::withHeaders([
                'x-api-key'         => $cfg['api_key'],
                'anthropic-version' => '2023-06-01',
            ])
            ->timeout(120)
            ->post("{$cfg['base_url']}/messages", [
                'model'       => $cfg['model'],
                'max_tokens'  => $maxTokens,
                'temperature' => $temperature,
                ...( $system ? ['system' => $system] : []),
                'messages'    => $rest ?: [['role' => 'user', 'content' => 'Hello']],
            ]);

        if ($resp->failed()) {
            throw new \RuntimeException('Anthropic 接口错误: HTTP ' . $resp->status());
        }

        $content = $resp->json('content.0.text');
        if (! is_string($content) || $content === '') {
            throw new \RuntimeException('AI 返回了空内容。');
        }

        return $content;
    }

    /** Public list of supported providers (for the settings UI). */
    public static function providers(): array
    {
        return collect(self::PROVIDERS)
            ->map(fn ($p, $key) => ['id' => $key, 'label' => $p['label'], 'base_url' => $p['base_url'], 'model' => $p['model']])
            ->values()
            ->all();
    }
}
