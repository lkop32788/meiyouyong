<?php

namespace App\Jobs;

use App\Models\Conversation;
use App\Services\OutboundMessageService;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Support\Facades\DB;

class SendCsatSurveyJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable;

    public function __construct(private readonly string $conversationId) {}

    public function handle(OutboundMessageService $outbound): void
    {
        // Idempotency — don't send if already sent
        $exists = DB::table('csat_surveys')
            ->where('conversation_id', $this->conversationId)
            ->exists();

        if ($exists) {
            return;
        }

        $conv = Conversation::find($this->conversationId);
        if (! $conv) {
            return;
        }

        $surveyText = "Terima kasih telah menghubungi kami. Bagaimana pengalaman Anda hari ini?\n" .
                      "Berikan nilai 1-5 (1=Sangat Buruk, 5=Sangat Baik)";

        // Claim the idempotency row BEFORE sending. The other order meant a
        // failed send left no guard behind, so the retry would send a second
        // survey to a real customer.
        DB::table('csat_surveys')->insert([
            'company_id'      => $conv->company_id,
            'conversation_id' => $this->conversationId,
            'contact_id'      => $conv->contact_id,
            'sent_at'         => now(),
        ]);

        $outbound->sendSystemMessage($conv, 'text', ['body' => $surveyText]);
    }
}
