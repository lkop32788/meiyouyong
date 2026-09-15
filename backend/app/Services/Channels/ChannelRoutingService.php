<?php

namespace App\Services\Channels;

use App\Models\Channel;
use App\Models\Contact;
use App\Models\Conversation;
use App\Models\ConversationFailoverLog;
use Illuminate\Support\Facades\Log;

/**
 * Pilih channel yang tepat dan handle failover ke channel cadangan.
 *
 * Urutan pengiriman:
 * 1. Coba primary channel (channel asli conversation)
 * 2. Jika gagal, iterasi failover_channel_ids (JSON array di tabel channels)
 * 3. Log setiap failover ke conversation_failover_log
 * 4. Jika semua gagal, throw ChannelSendException terakhir
 */
class ChannelRoutingService
{
    public function __construct(
        private readonly AdapterRegistry $registry
    ) {}

    /**
     * Kirim pesan — coba primary channel, fallback ke cadangan bila gagal.
     *
     * @return array{ channel_id: string, provider_message_id: string }
     * @throws ChannelSendException Bila semua channel gagal
     */
    public function send(
        Conversation $conv,
        Contact      $contact,
        string       $contentType,
        array        $content,
        ?string      $replyToProviderMsgId = null
    ): array {
        // Load primary channel dengan eager load (sudah terikat ke conv)
        $primaryChannel = Channel::withoutGlobalScopes()
            ->where('id', $conv->channel_id)
            ->where('company_id', $conv->company_id)
            ->where('is_active', true)
            ->first();

        if (! $primaryChannel) {
            throw new ChannelSendException(
                'Primary channel not found or inactive',
                channelType: 'unknown',
            );
        }

        // Susun daftar channel yang akan dicoba: primary dulu, lalu failover
        $channelsToTry = collect([$primaryChannel]);
        $failoverIds   = $primaryChannel->failover_channel_ids ?? [];

        if (! empty($failoverIds)) {
            $failoverChannels = Channel::withoutGlobalScopes()
                ->whereIn('id', $failoverIds)
                ->where('company_id', $conv->company_id)
                ->where('is_active', true)
                ->get()
                ->keyBy('id');

            // Pertahankan urutan yang ada di failover_channel_ids
            foreach ($failoverIds as $fId) {
                if ($failoverChannels->has($fId)) {
                    $channelsToTry->push($failoverChannels->get($fId));
                }
            }
        }

        $lastException   = null;
        $usedPrimary     = true;

        foreach ($channelsToTry as $channel) {
            try {
                // Inside the try: forChannel() throws InvalidArgumentException
                // for an unregistered channel type, and that is not a
                // ChannelSendException — so it used to escape this loop and the
                // whole outbound stack instead of degrading to failover. A
                // channel type with no adapter should behave like a dead
                // channel, not like a crash.
                $adapter = $this->registry->forChannel($channel->type);

                $providerMsgId = $adapter->send(
                    $conv, $contact, $channel, $contentType, $content, $replyToProviderMsgId
                );

                return [
                    'channel_id'          => $channel->id,
                    'provider_message_id' => $providerMsgId,
                ];

            } catch (\InvalidArgumentException $e) {
                $lastException = new ChannelSendException(
                    $e->getMessage(),
                    channelType: $channel->type,
                    previous: $e,
                );

                Log::warning('No adapter for channel type, trying failover', [
                    'conversation_id'   => $conv->id,
                    'company_id'        => $conv->company_id,
                    'failed_channel_id' => $channel->id,
                    'channel_type'      => $channel->type,
                ]);

                continue;

            } catch (ChannelSendException $e) {
                $lastException = $e;

                Log::warning('Channel send failed, trying failover', [
                    'conversation_id'    => $conv->id,
                    'company_id'         => $conv->company_id,
                    'failed_channel_id'  => $channel->id,
                    'channel_type'       => $channel->type,
                    'error_code'         => $e->providerErrorCode,
                ]);

                if (! $usedPrimary) {
                    // Log failover (jika ini bukan percobaan pertama)
                    $this->logFailover($conv, $primaryChannel->id, $channel->id, $e->getMessage());
                }

                $usedPrimary = false;
            }
        }

        throw $lastException ?? new ChannelSendException(
            'All channels failed',
            channelType: $primaryChannel->type,
        );
    }

    // ── Private ───────────────────────────────────────────────────────────────

    private function logFailover(
        Conversation $conv,
        string       $originalChannelId,
        string       $failedChannelId,
        string       $reason
    ): void {
        try {
            ConversationFailoverLog::create([
                'conversation_id'    => $conv->id,
                'company_id'         => $conv->company_id,
                'original_channel_id' => $originalChannelId,
                'failover_channel_id' => $failedChannelId,
                'reason'             => mb_substr($reason, 0, 500),
                'failed_at'          => now(),
            ]);
        } catch (\Throwable $e) {
            Log::error('Failed to log failover', ['error' => $e->getMessage()]);
        }
    }
}
