<?php

namespace App\Services;

use App\Data\CanonicalMessage;
use App\Models\Contact;
use App\Models\Conversation;
use App\Models\Message;
use MongoDB\Driver\Exception\BulkWriteException;

class MessagePersistenceService
{
    /**
     * Simpan pesan ke MongoDB.
     * Idempotent: jika provider_message_id sudah ada, return _id yang sudah ada.
     *
     * @return string MongoDB _id
     */
    public function persist(
        Conversation     $conv,
        Contact          $contact,
        CanonicalMessage $message
    ): string {
        try {
            $doc = Message::create([
                'company_id'          => $message->company_id,
                'conversation_id'     => $conv->id,
                'channel_id'          => $message->channel_id,
                'channel_type'        => $message->channel_type,
                'direction'           => 'inbound',
                'sender_type'         => 'contact',
                'sender_id'           => $contact->id,
                'content_type'        => $message->content_type,
                'content'             => $message->content,
                'quoted_message_id'   => $message->quoted_message_id,
                'status'              => 'delivered', // inbound = selalu delivered
                'provider_message_id' => $message->idempotency_key,
                'provider_timestamp'  => $message->provider_timestamp,
                'is_deleted'          => false,
                'is_automated'        => false,
            ]);

            return (string) $doc->_id;

        } catch (BulkWriteException $e) {
            // Error code 11000 = duplicate key (provider_message_id sudah ada)
            if ($e->getCode() === 11000) {
                $existing = Message::where('company_id',          $message->company_id)
                    ->where('channel_type',        $message->channel_type)
                    ->where('provider_message_id', $message->idempotency_key)
                    ->first();

                return $existing ? (string) $existing->_id : '';
            }
            throw $e;
        }
    }

    /**
     * Simpan pesan outbound ke MongoDB (status awal: pending).
     *
     * @return string MongoDB _id
     */
    public function persistOutbound(
        Conversation $conv,
        ?string      $senderId,
        string       $contentType,
        array        $content,
        string       $senderType = 'agent'
    ): string {
        // sender_type used to be hardcoded 'agent'. Bot and broadcast messages
        // filed as agent messages skew ConversationResolvedAnalyticsJob's bot
        // counts, was_bot_handled and bot_containment_pct.
        $doc = Message::create([
            'company_id'      => $conv->company_id,
            'conversation_id' => $conv->id,
            'channel_id'      => $conv->channel_id,
            'channel_type'    => $conv->channel->type,
            'direction'       => 'outbound',
            'sender_type'     => $senderType,
            'sender_id'       => $senderId,
            'content_type'    => $contentType,
            'content'         => $content,
            'status'          => 'pending',
            'is_deleted'      => false,
            'is_automated'    => $senderType !== 'agent',
        ]);

        return (string) $doc->_id;
    }

    /**
     * Update status pesan outbound setelah dikirim ke provider.
     */
    public function updateStatus(string $mongoId, string $status, ?string $errorCode = null): void
    {
        Message::where('_id', $mongoId)->update([
            'status'     => $status,
            'error_code' => $errorCode,
            'updated_at' => now(),
        ]);
    }
}
