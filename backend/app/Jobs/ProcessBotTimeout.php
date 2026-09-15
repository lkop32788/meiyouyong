<?php

namespace App\Jobs;

use App\Models\BotSession;
use App\Models\Conversation;
use App\Services\OutboundMessageService;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;

class ProcessBotTimeout implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable;

    public function __construct(
        private readonly string $conversationId,
        private readonly int    $expectedVersion,
    ) {}

    public function handle(OutboundMessageService $outbound): void
    {
        $session = BotSession::where('conversation_id', $this->conversationId)
            ->where('is_active', true)
            ->first();

        // Version mismatch means bot advanced or session was reset — no-op
        if (! $session || $session->bot_flow_version !== $this->expectedVersion) {
            return;
        }

        // Only trigger if still waiting for input
        if (! $session->waiting_for_input) {
            return;
        }

        $conversation = Conversation::find($this->conversationId);
        if ($conversation) {
            $outbound->sendSystemMessage($conversation, 'text', [
                'body' => 'Maaf, kami tidak menerima balasan Anda. Sesi bot telah berakhir.',
            ]);
        }

        $session->is_active = false;
        $session->save();
    }
}
