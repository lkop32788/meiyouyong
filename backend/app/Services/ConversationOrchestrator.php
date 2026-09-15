<?php

namespace App\Services;

use App\Data\CanonicalMessage;
use App\Models\Contact;
use App\Models\Conversation;
use App\Models\ConversationAssignment;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

class ConversationOrchestrator
{
    public function __construct(private readonly IntentTagger $tagger) {}

    /**
     * Temukan conversation aktif atau buat yang baru.
     *
     * Algoritma:
     * 1. Cari pending/open → return (update stats)
     * 2. Cari snoozed → reopen ke 'open'
     * 3. Buat conversation baru dengan Redis distributed lock
     */
    public function findOrCreate(
        string           $companyId,
        string           $channelId,
        string           $contactId,
        CanonicalMessage $message
    ): Conversation {
        // STEP 1 — Active conversation
        $conv = Conversation::withoutGlobalScopes()
            ->where('company_id', $companyId)
            ->where('channel_id', $channelId)
            ->where('contact_id', $contactId)
            ->whereIn('status', ['pending', 'open'])
            ->orderByDesc('last_message_at')
            ->first();

        if ($conv) {
            return $conv;
        }

        // STEP 2 — Snoozed conversation
        $snoozed = Conversation::withoutGlobalScopes()
            ->where('company_id', $companyId)
            ->where('channel_id', $channelId)
            ->where('contact_id', $contactId)
            ->where('status', 'snoozed')
            ->orderByDesc('last_message_at')
            ->first();

        if ($snoozed) {
            $snoozed->update([
                'status'        => 'open',
                'snoozed_until' => null,
            ]);
            return $snoozed->fresh();
        }

        // STEP 3 — Create new (dengan distributed lock untuk cegah race condition)
        return $this->createWithLock($companyId, $channelId, $contactId, $message);
    }

    /**
     * Same reuse rules as findOrCreate(), but for a conversation we are about to
     * SEND into (broadcast, bot outreach) rather than one opened by an inbound
     * message — so there is no CanonicalMessage to derive a preview or intent
     * tags from.
     *
     * Without this, an outbound-first flow has nowhere to put the message and no
     * thread for the contact's reply to land in.
     */
    public function findOrCreateForOutbound(
        string $companyId,
        string $channelId,
        string $contactId
    ): Conversation {
        $existing = Conversation::withoutGlobalScopes()
            ->where('company_id', $companyId)
            ->where('channel_id', $channelId)
            ->where('contact_id', $contactId)
            ->whereIn('status', ['pending', 'open', 'snoozed'])
            ->orderByDesc('last_message_at')
            ->first();

        if ($existing) {
            if ($existing->status === 'snoozed') {
                $existing->update(['status' => 'open', 'snoozed_until' => null]);

                return $existing->fresh();
            }

            return $existing;
        }

        $lockKey = "conv_create:{$companyId}:{$channelId}:{$contactId}";
        $lock    = Cache::lock($lockKey, 5);

        try {
            $lock->block(5);

            // Re-check inside the lock — another worker may have won the race.
            $won = Conversation::withoutGlobalScopes()
                ->where('company_id', $companyId)
                ->where('channel_id', $channelId)
                ->where('contact_id', $contactId)
                ->whereIn('status', ['pending', 'open'])
                ->first();

            if ($won) {
                return $won;
            }

            // 'open', not 'pending': we are the ones starting the exchange, so
            // there is nothing waiting on an agent yet. unread_count stays 0 —
            // our own outbound message is not unread for us.
            return Conversation::create([
                'id'                     => Str::uuid()->toString(),
                'company_id'             => $companyId,
                'channel_id'             => $channelId,
                'contact_id'             => $contactId,
                'status'                 => 'open',
                'last_message_direction' => 'outbound',
                'last_message_at'        => now(),
                'message_count'          => 0,
                'unread_count'           => 0,
            ]);
        } finally {
            $lock->release();
        }
    }

    /**
     * Update conversation header setiap ada pesan masuk baru.
     */
    public function updateAfterMessage(Conversation $conv, CanonicalMessage $message): void
    {
        $conv->update([
            'last_message_preview'   => $message->getPreview(),
            'last_message_at'        => $message->provider_timestamp,
            'last_message_direction' => 'inbound',
            'message_count'          => DB::raw('message_count + 1'),
            'unread_count'           => DB::raw('unread_count + 1'),
        ]);
    }

    // ── Private ──────────────────────────────────────────────────────────────

    private function createWithLock(
        string           $companyId,
        string           $channelId,
        string           $contactId,
        CanonicalMessage $message
    ): Conversation {
        $lockKey = "conv_create:{$companyId}:{$channelId}:{$contactId}";
        $lock    = Cache::lock($lockKey, 5);

        try {
            $lock->block(5); // tunggu max 5 detik

            // Re-check di dalam lock (mungkin sudah dibuat oleh worker lain)
            $existing = Conversation::withoutGlobalScopes()
                ->where('company_id', $companyId)
                ->where('channel_id', $channelId)
                ->where('contact_id', $contactId)
                ->whereIn('status', ['pending', 'open'])
                ->first();

            if ($existing) return $existing;

            $tags    = $this->tagger->tag($message->content['body'] ?? '');
            $preview = $message->getPreview();

            $conv = Conversation::create([
                'id'                     => Str::uuid()->toString(),
                'company_id'             => $companyId,
                'channel_id'             => $channelId,
                'contact_id'             => $contactId,
                'status'                 => 'pending',
                'intent_tags'            => $tags,
                'last_message_preview'   => $preview,
                'last_message_at'        => $message->provider_timestamp,
                'last_message_direction' => 'inbound',
                'message_count'          => 1,
                'unread_count'           => 1,
            ]);

            // Catat assignment awal (unassigned)
            ConversationAssignment::create([
                'conversation_id' => $conv->id,
                'company_id'      => $companyId,
                'assigned_to'     => null,
                'assigned_by'     => null,
                'reason'          => 'auto_dispatch',
                'created_at'      => now(),
            ]);

            return $conv;
        } finally {
            $lock->release();
        }
    }
}
