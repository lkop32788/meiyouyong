<?php

namespace Tests\Feature;

use App\Jobs\SendCsatSurveyJob;
use App\Models\Channel;
use App\Models\Company;
use App\Models\Contact;
use App\Models\Conversation;
use App\Services\Channels\AdapterRegistry;
use App\Services\Channels\ChannelSendException;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\Concerns\RefreshesMongo;
use Tests\Support\StubChannelAdapter;
use Tests\TestCase;

/**
 * The job used to send first and write its csat_surveys guard row second. A
 * failed send left no guard behind, so the retry sent a SECOND survey to a real
 * customer. It was masked only because the job could not run at all — the queue
 * connection was unconfigured and the send() call had the wrong arity.
 *
 * Claiming the guard first trades a possible missed survey for never
 * double-messaging a customer, which is the right way round.
 */
class CsatSurveyGuardTest extends TestCase
{
    use RefreshDatabase;
    use RefreshesMongo;

    private Company $company;
    private Conversation $conversation;

    protected function setUp(): void
    {
        parent::setUp();

        $this->company = Company::factory()->create();
        $channel = Channel::factory()->for($this->company)->create(['type' => 'whatsapp']);
        $contact = Contact::factory()->for($this->company)->create();

        $this->conversation = Conversation::factory()->create([
            'company_id' => $this->company->id,
            'channel_id' => $channel->id,
            'contact_id' => $contact->id,
            'status'     => 'resolved',
        ])->load('channel', 'contact');
    }

    public function test_a_survey_is_sent_and_recorded(): void
    {
        $adapter = $this->stubAdapter();

        $this->runJob();

        $this->assertCount(1, $adapter->sent);
        $this->assertDatabaseHas('csat_surveys', [
            'conversation_id' => $this->conversation->id,
            'company_id'      => $this->company->id,
        ]);
    }

    public function test_a_failed_send_still_leaves_the_guard_row_behind(): void
    {
        $this->stubAdapter(shouldFail: true);

        try {
            $this->runJob();
        } catch (ChannelSendException) {
            // expected — the send failed
        }

        // This is the whole point: the retry must find the guard and stop.
        $this->assertDatabaseHas('csat_surveys', [
            'conversation_id' => $this->conversation->id,
        ]);
    }

    public function test_a_retry_after_a_failed_send_does_not_message_the_customer_again(): void
    {
        $this->stubAdapter(shouldFail: true);

        try {
            $this->runJob();
        } catch (ChannelSendException) {
        }

        // Second attempt, this time with a working channel.
        $adapter = $this->stubAdapter();
        $this->runJob();

        $this->assertCount(0, $adapter->sent, '守卫行已存在，重试不应再次发送');
        $this->assertSame(1, DB::table('csat_surveys')
            ->where('conversation_id', $this->conversation->id)->count());
    }

    public function test_it_does_nothing_when_a_survey_was_already_sent(): void
    {
        DB::table('csat_surveys')->insert([
            'company_id'      => $this->company->id,
            'conversation_id' => $this->conversation->id,
            'contact_id'      => $this->conversation->contact_id,
            'sent_at'         => now()->subHour(),
        ]);

        $adapter = $this->stubAdapter();

        $this->runJob();

        $this->assertCount(0, $adapter->sent);
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private function stubAdapter(bool $shouldFail = false): StubChannelAdapter
    {
        $adapter = new StubChannelAdapter(shouldFail: $shouldFail);
        $this->app->instance(AdapterRegistry::class, new AdapterRegistry([$adapter]));

        return $adapter;
    }

    private function runJob(): void
    {
        (new SendCsatSurveyJob($this->conversation->id))
            ->handle(app(\App\Services\OutboundMessageService::class));
    }
}
