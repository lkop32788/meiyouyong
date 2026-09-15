<?php

namespace App\Services\Channels;

use App\Models\Channel;
use App\Models\Contact;
use App\Models\Conversation;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

/**
 * Adapter for Facebook Messenger channels (Meta Graph API).
 *
 * Credentials (from channel->getCredentials()):
 *   - page_access_token : Page access token from the OAuth connect flow
 *
 * Contact identifier: contact->phone is NOT used — Messenger recipients are
 * addressed by PSID (Page-Scoped ID). The IdentityResolutionService stores
 * the PSID as external_id; we read it from the conversation's channel identity.
 */
class FacebookMessengerAdapter implements ChannelAdapterInterface
{
    private const GRAPH = 'https://graph.facebook.com';
    private const API_VERSION = 'v21.0';

    public function supports(string $channelType): bool
    {
        return $channelType === 'facebook';
    }

    public function send(
        Conversation $conv,
        Contact      $contact,
        Channel      $channel,
        string       $contentType,
        array        $content,
        ?string      $replyToProviderMsgId = null
    ): string {
        $creds = $channel->getCredentials();
        $pageToken = $creds['page_access_token'] ?? null;

        if (! $pageToken) {
            throw new ChannelSendException('Page access token missing on channel', channelType: 'facebook');
        }

        // Recipient = the contact's Facebook identity (PSID)
        $identity = $contact->channelIdentities()
            ->where('channel_type', 'facebook')
            ->orderByDesc('created_at')
            ->first();

        $psid = $identity?->external_id;
        if (! $psid) {
            throw new ChannelSendException('Contact has no Facebook (PSID) identity', channelType: 'facebook');
        }

        $message = $this->buildMessage($contentType, $content, $replyToProviderMsgId);

        // withToken() has to be on the PendingRequest, before post(). Chained
        // after it, it lands on the Response — which has no such method, so this
        // threw a raw Error (not ChannelSendException) and escaped the failover
        // loop in ChannelRoutingService entirely.
        //
        // Endpoint is /me/messages, not /{psid}/messages: the path segment is
        // the sending page, and the recipient goes in the body.
        $response = Http::acceptJson()
            ->withToken($pageToken)
            ->timeout(20)
            ->post(self::GRAPH . '/' . self::API_VERSION . '/me/messages', [
                'recipient'      => ['id' => $psid],
                'message'        => $message,
                'messaging_type' => 'RESPONSE',
            ]);

        if (! $response->successful()) {
            $errorData = $response->json('error', []);
            $errorCode = (string) ($errorData['code'] ?? $response->status());
            $errorMsg  = $errorData['message'] ?? 'Unknown Messenger API error';

            Log::warning('Messenger send failed', [
                'channel_id' => $channel->id,
                'error_code' => $errorCode,
            ]);
            throw new ChannelSendException($errorMsg, channelType: 'facebook', providerErrorCode: $errorCode);
        }

        return (string) $response->json('message_id', '');
    }

    private function buildMessage(string $contentType, array $content, ?string $replyTo): array
    {
        if ($replyTo) {
            return [
                'reply' => ['message_id' => $replyTo],
                'text'  => $content['body'] ?? '',
            ];
        }

        return match ($contentType) {
            'text'  => ['text' => $content['body'] ?? ''],
            'image' => [
                'attachment' => [
                    'type'    => 'image',
                    'payload' => ['url' => $content['url'] ?? '', 'is_reusable' => false],
                ],
            ],
            'audio' => [
                'attachment' => [
                    'type'    => 'audio',
                    'payload' => ['url' => $content['url'] ?? '', 'is_reusable' => false],
                ],
            ],
            'video' => [
                'attachment' => [
                    'type'    => 'video',
                    'payload' => ['url' => $content['url'] ?? '', 'is_reusable' => false],
                ],
            ],
            'file'  => [
                'attachment' => [
                    'type'    => 'file',
                    'payload' => ['url' => $content['url'] ?? '', 'is_reusable' => false],
                ],
            ],
            'button_reply', 'list_reply' => ['text' => $content['button_text'] ?? ''],
            default => ['text' => json_encode($content, JSON_UNESCAPED_UNICODE)],
        };
    }
}
