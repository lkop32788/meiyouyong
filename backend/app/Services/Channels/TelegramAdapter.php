<?php

namespace App\Services\Channels;

use App\Models\Channel;
use App\Models\Contact;
use App\Models\ContactChannelIdentity;
use App\Models\Conversation;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

/**
 * Telegram Bot API outbound adapter.
 *
 * Inbound already worked (gateway/routes/telegram.js + normalizer), but there
 * was no adapter on this side — AdapterRegistry::forChannel('telegram') threw,
 * so a Telegram channel could receive messages and never reply.
 *
 * Credentials:
 *   - bot_token : from BotFather. Same key ChannelHealthService probes with.
 *
 * Contact identifier: ContactChannelIdentity.external_id, which the gateway
 * normalizer fills with the Telegram user id. Only private chats are
 * normalized, where chat.id == from.id, so that value is a usable chat_id.
 *
 * Request shapes follow wabapanel's telegramService.js, which is the working
 * reference this project already borrows its WhatsApp-QR flow from.
 */
class TelegramAdapter implements ChannelAdapterInterface
{
    private const API = 'https://api.telegram.org';

    public function send(
        Conversation $conv,
        Contact      $contact,
        Channel      $channel,
        string       $contentType,
        array        $content,
        ?string      $replyToProviderMsgId = null
    ): string {
        $token = $channel->getCredentials()['bot_token'] ?? null;

        if (! $token) {
            throw new ChannelSendException('Bot token missing on channel', channelType: 'telegram');
        }

        $identity = ContactChannelIdentity::where('contact_id', $contact->id)
            ->where('company_id', $conv->company_id)
            ->where('channel_type', 'telegram')
            ->first();

        if (! $identity) {
            throw new ChannelSendException('Telegram chat id not found for contact', channelType: 'telegram');
        }

        [$method, $payload] = $this->buildRequest($contentType, $content);
        $payload['chat_id'] = $identity->external_id;

        if ($replyTo = $this->parseReplyTarget($replyToProviderMsgId)) {
            $payload['reply_to_message_id'] = $replyTo;
        }

        $response = Http::acceptJson()
            ->timeout(15)
            ->post(self::API . "/bot{$token}/{$method}", $payload);

        // Telegram answers 200 with ok=false for application-level failures
        // (blocked bot, unknown chat), so the status code alone is not enough.
        if (! $response->successful() || $response->json('ok') !== true) {
            $errorMsg  = $response->json('description') ?? 'Unknown Telegram API error';
            $errorCode = (string) ($response->json('error_code') ?? $response->status());

            Log::warning('Telegram send failed', [
                'channel_id' => $channel->id,
                'company_id' => $conv->company_id,
                'error_code' => $errorCode,
            ]);

            throw new ChannelSendException(
                "Telegram send failed: {$errorMsg}",
                channelType:       'telegram',
                providerErrorCode: $errorCode,
            );
        }

        return (string) $response->json('result.message_id');
    }

    public function supports(string $channelType): bool
    {
        return $channelType === 'telegram';
    }

    // ── Private ───────────────────────────────────────────────────────────────

    /**
     * @return array{0: string, 1: array} Bot API method name and its payload.
     */
    private function buildRequest(string $contentType, array $content): array
    {
        $caption = $content['caption'] ?? null;

        return match ($contentType) {
            'text'  => ['sendMessage',  ['text' => $content['body'] ?? '']],
            'image' => ['sendPhoto',    array_filter(['photo'    => $content['url'] ?? '', 'caption' => $caption])],
            'audio' => ['sendAudio',    array_filter(['audio'    => $content['url'] ?? '', 'caption' => $caption])],
            'video' => ['sendVideo',    array_filter(['video'    => $content['url'] ?? '', 'caption' => $caption])],
            'file'  => ['sendDocument', array_filter([
                'document' => $content['url'] ?? '',
                'caption'  => $caption ?? ($content['filename'] ?? null),
            ])],
            // MessageController only validates the five above, but adapters are
            // also reachable from bot flows and broadcasts. Degrade to text
            // rather than silently dropping the message.
            default => ['sendMessage', ['text' => $content['body'] ?? '[unsupported message type]']],
        };
    }

    /**
     * Inbound quoted ids are composites — `tg_{message_id}_{sender_id}` — built
     * by the gateway normalizer. Telegram's reply_to_message_id wants the bare
     * numeric message id.
     */
    private function parseReplyTarget(?string $quoted): ?int
    {
        if ($quoted === null) {
            return null;
        }

        if (preg_match('/^tg_(\d+)(?:_|$)/', $quoted, $m)) {
            return (int) $m[1];
        }

        return ctype_digit($quoted) ? (int) $quoted : null;
    }
}
