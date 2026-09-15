<?php

namespace App\Services;

use App\Models\Channel;
use App\Models\Contact;
use App\Models\Conversation;
use App\Services\Channels\ChannelRoutingService;
use App\Services\Channels\ChannelSendException;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Redis;

/**
 * Orkestrasi pengiriman pesan outbound dari agent ke customer.
 *
 * Alur:
 * 1. Rate limit check (Redis sliding window per channel)
 * 2. Persist ke MongoDB (status = pending)
 * 3. Kirim via ChannelRoutingService (primary → failover)
 * 4. Update MongoDB status (sent / failed)
 * 5. Publish realtime event ke frontend
 */
class OutboundMessageService
{
    public function __construct(
        private readonly MessagePersistenceService $persistence,
        private readonly ChannelRoutingService     $router,
        private readonly RealtimeEventPublisher    $realtime,
    ) {}

    /**
     * Kirim pesan outbound dan kembalikan MongoDB message ID.
     *
     * @param  Conversation $conv
     * @param  Contact      $contact       Penerima
     * @param  string       $agentId       UUID agent pengirim
     * @param  string       $contentType   text | image | audio | video | file
     * @param  array        $content       Body pesan sesuai content_type
     * @param  string|null  $replyToProviderMsgId  ID pesan yang di-quote (provider-side)
     * @return string MongoDB _id pesan yang dikirim
     *
     * @throws ChannelSendException  Bila semua channel gagal
     * @throws \RuntimeException     Bila rate limit tercapai
     */
    public function send(
        Conversation $conv,
        Contact      $contact,
        string       $agentId,
        string       $contentType,
        array        $content,
        ?string      $replyToProviderMsgId = null
    ): string {
        return $this->deliver($conv, $contact, $contentType, $content, $replyToProviderMsgId, 'agent', $agentId);
    }

    /**
     * Send without an agent behind it — bot flows, CSAT surveys, broadcasts.
     *
     * Exists because those callers have neither a Contact nor an agent id to
     * hand over, and because persistOutbound used to hardcode sender_type
     * 'agent': routing them through send() would file every bot message as an
     * agent message and corrupt the bot-containment analytics.
     *
     * @throws ChannelSendException  Bila conversation tidak punya contact
     */
    public function sendSystemMessage(
        Conversation $conv,
        string       $contentType,
        array        $content,
        string       $senderType = 'bot',
        ?string      $senderId = null
    ): string {
        $contact = $conv->contact;

        if (! $contact) {
            throw new ChannelSendException(
                'Conversation has no contact to send to',
                channelType: $conv->channel?->type ?? 'unknown',
            );
        }

        return $this->deliver($conv, $contact, $contentType, $content, null, $senderType, $senderId);
    }

    private function deliver(
        Conversation $conv,
        Contact      $contact,
        string       $contentType,
        array        $content,
        ?string      $replyToProviderMsgId,
        string       $senderType,
        ?string      $senderId
    ): string {
        // ── 1. Rate limit check ───────────────────────────────────────────────
        $this->checkRateLimit($conv);

        // ── 2. Persist ke MongoDB (status = pending) ──────────────────────────
        $mongoId = $this->persistence->persistOutbound($conv, $senderId, $contentType, $content, $senderType);

        // ── 3. Kirim via channel (dengan failover) ────────────────────────────
        try {
            $result = $this->router->send(
                $conv, $contact, $contentType, $content, $replyToProviderMsgId
            );

            // ── 4. Update status = sent ───────────────────────────────────────
            $this->persistence->updateStatus($mongoId, 'sent');

            // Update conversation last_message
            $conv->update([
                'last_message_preview'   => $this->buildPreview($contentType, $content),
                'last_message_at'        => now(),
                'last_message_direction' => 'outbound',
            ]);

            // ── 5. Realtime event ─────────────────────────────────────────────
            $this->realtime->messageStatusUpdate($conv->company_id, $conv->id, $mongoId, 'sent');

            Log::info('Outbound message sent', [
                'company_id'          => $conv->company_id,
                'conversation_id'     => $conv->id,
                'mongo_id'            => $mongoId,
                'channel_id'          => $result['channel_id'],
                'provider_message_id' => $result['provider_message_id'],
            ]);

            return $mongoId;

        } catch (ChannelSendException $e) {
            // ── 4b. Semua channel gagal — update status = failed ──────────────
            $this->persistence->updateStatus($mongoId, 'failed', $e->providerErrorCode);
            $this->realtime->messageStatusUpdate($conv->company_id, $conv->id, $mongoId, 'failed');

            Log::error('Outbound message failed after all channels', [
                'company_id'      => $conv->company_id,
                'conversation_id' => $conv->id,
                'mongo_id'        => $mongoId,
                'error'           => $e->getMessage(),
            ]);

            throw $e;
        }
    }

    // ── Private ───────────────────────────────────────────────────────────────

    /**
     * Sliding window rate limiter menggunakan Redis sorted set.
     * Key: ratelimit:outbound:{company_id}:{channel_id}
     * Konvensi: mengikuti format {scope}:{company_id}:{entity}:{id} dari redis_key_design.js
     *
     * @throws \RuntimeException Bila rate limit tercapai
     */
    private function checkRateLimit(Conversation $conv): void
    {
        $channel = Channel::withoutGlobalScopes()
            ->where('id', $conv->channel_id)
            ->firstOrFail();

        $limit      = $channel->getRateLimit(); // messages_per_minute dari settings
        $windowSecs = 60;
        $now        = (int) (microtime(true) * 1000); // milliseconds
        $windowStart = $now - ($windowSecs * 1000);

        $key = "ratelimit:outbound:{$conv->company_id}:{$conv->channel_id}";

        // Bersihkan entry lama di luar window
        Redis::zRemRangeByScore($key, 0, $windowStart);

        $current = Redis::zCard($key);
        if ($current >= $limit) {
            throw new \RuntimeException(
                "Rate limit reached for channel {$conv->channel_id}: {$current}/{$limit} messages/min"
            );
        }

        // Catat pengiriman saat ini
        Redis::zAdd($key, $now, "{$now}-" . uniqid());
        Redis::expire($key, $windowSecs * 2);
    }

    private function buildPreview(string $contentType, array $content): string
    {
        return match ($contentType) {
            'text'  => mb_substr($content['body'] ?? '', 0, 150),
            'image' => '[Foto]',
            'audio' => '[Pesan suara]',
            'video' => '[Video]',
            'file'  => '[File: ' . ($content['filename'] ?? 'unknown') . ']',
            default => '[Pesan]',
        };
    }
}
