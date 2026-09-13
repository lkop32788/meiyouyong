<?php

namespace App\Services\Channels;

use App\Models\Channel;
use App\Models\Contact;
use App\Models\Conversation;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

/**
 * Adapter for WhatsApp QR channels (unofficial WhatsApp Web protocol via
 * Baileys, managed by the Node gateway). Outbound sends are relayed through
 * the gateway's internal API — the Baileys socket lives there.
 *
 * Credentials (from channel->getCredentials()): none required — session state
 * lives on the gateway filesystem. The channel row just needs is_active=true
 * and a connected session.
 *
 * Contact identifier: contact->phone (E.164 with or without '+').
 */
class WhatsAppQrAdapter implements ChannelAdapterInterface
{
    public function supports(string $channelType): bool
    {
        return $channelType === 'whatsapp_qr';
    }

    public function send(
        Conversation $conv,
        Contact      $contact,
        Channel      $channel,
        string       $contentType,
        array        $content,
        ?string      $replyToProviderMsgId = null
    ): string {
        $baseUrl = rtrim(config('services.gateway.url'), '/');
        $apiKey  = config('services.gateway.internal_api_key');

        if (! $baseUrl || ! $apiKey) {
            throw new ChannelSendException('Gateway internal API not configured', channelType: 'whatsapp_qr');
        }

        $payload = [
            'phone' => ltrim($contact->phone ?? '', '+'),
            'type'  => $this->mapContentType($contentType),
            'text'  => $content['body'] ?? null,
        ];

        if (in_array($contentType, ['image', 'audio', 'video', 'file'], true)) {
            $payload['media'] = [
                'url'      => $content['url'] ?? $content['provider_media_id'] ?? null,
                'caption'  => $content['caption'] ?? null,
                'filename' => $content['filename'] ?? null,
            ];
            if (empty($payload['media']['url'])) {
                throw new ChannelSendException('Media URL required for QR media sends', channelType: 'whatsapp_qr');
            }
        }

        $response = Http::withHeaders(['X-Internal-Api-Key' => $apiKey])
            ->timeout(90) // QR sends are queued with human-like delays (5–15s)
            ->post("{$baseUrl}/internal/waqr/{$channel->id}/send", $payload);

        if (! $response->successful()) {
            $errorMsg = $response->json('error') ?? "Gateway HTTP {$response->status()}";
            Log::warning('WhatsApp QR send failed', [
                'channel_id' => $channel->id,
                'error'      => $errorMsg,
            ]);
            throw new ChannelSendException($errorMsg, channelType: 'whatsapp_qr');
        }

        $providerMsgId = $response->json('data.provider_message_id') ?? '';
        if (! $providerMsgId) {
            throw new ChannelSendException('Gateway accepted send but returned no message id', channelType: 'whatsapp_qr');
        }

        return $providerMsgId;
    }

    private function mapContentType(string $contentType): string
    {
        return match ($contentType) {
            'image' => 'image',
            'audio' => 'audio',
            'video' => 'video',
            'file'  => 'document',
            default => 'text',
        };
    }
}
