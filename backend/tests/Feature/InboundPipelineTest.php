<?php

namespace Tests\Feature;

use App\Data\CanonicalMessage;
use App\Jobs\ProcessInboundMessage;
use App\Models\Channel;
use App\Models\Company;
use App\Models\Conversation;
use App\Models\Message;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Tests\Concerns\RefreshesMongo;
use Tests\TestCase;

/**
 * Inbound had never completed a single message. Three independent defects
 * stacked on top of each other, each one hidden behind the previous:
 *
 *   1. the consumer could not start — its queue_declare arguments disagreed
 *      with the gateway's, so RabbitMQ answered PRECONDITION_FAILED;
 *   2. App\Models\ProcessedWebhookEvent did not exist, so the idempotency check
 *      on line one of the pipeline threw "Class not found";
 *   3. updateAfterMessage pushed DB::raw() into columns the model casts to
 *      'integer', which Eloquent cannot convert.
 *
 * This walks the job end to end so none of them can come back quietly.
 */
class InboundPipelineTest extends TestCase
{
    use RefreshDatabase;
    use RefreshesMongo;

    private Company $company;
    private Channel $channel;

    protected function setUp(): void
    {
        parent::setUp();
        $this->company = Company::factory()->create();
        $this->channel = Channel::factory()->for($this->company)->create(['type' => 'whatsapp_qr']);
    }

    public function test_an_inbound_message_creates_contact_conversation_and_stored_message(): void
    {
        $this->process($this->canonical(body: '你好'));

        $conv = Conversation::withoutGlobalScopes()->firstOrFail();
        $this->assertSame($this->channel->id, $conv->channel_id);
        $this->assertSame('pending', $conv->status);
        $this->assertSame('你好', $conv->last_message_preview);
        $this->assertSame('inbound', $conv->last_message_direction);

        $this->assertDatabaseHas('contact_channel_identities', [
            'company_id'   => $this->company->id,
            'channel_type' => 'whatsapp_qr',
            'external_id'  => '628999000111',
        ]);

        $msg = Message::where('conversation_id', $conv->id)->firstOrFail();
        $this->assertSame('inbound', $msg->direction);
        $this->assertSame('contact', $msg->sender_type);
        $this->assertSame('delivered', $msg->status);
        $this->assertSame('你好', $msg->content['body']);
    }

    public function test_one_message_counts_once(): void
    {
        $this->process($this->canonical());

        $conv = Conversation::withoutGlobalScopes()->firstOrFail();

        // createWithLock used to seed both counters at 1 and updateAfterMessage
        // then incremented them, so a brand-new conversation showed an unread
        // badge of 2 for a single message.
        $this->assertSame(1, $conv->unread_count);
        $this->assertSame(1, $conv->message_count);
    }

    public function test_further_messages_reuse_the_conversation_and_keep_counting(): void
    {
        $this->process($this->canonical(body: '第一条'));
        $this->process($this->canonical(body: '第二条'));

        $this->assertSame(1, Conversation::withoutGlobalScopes()->count());

        $conv = Conversation::withoutGlobalScopes()->firstOrFail();
        $this->assertSame(2, $conv->unread_count);
        $this->assertSame(2, $conv->message_count);
        $this->assertSame('第二条', $conv->last_message_preview);
    }

    public function test_the_same_event_id_is_only_processed_once(): void
    {
        $eventId = (string) Str::uuid();

        $this->process($this->canonical(eventId: $eventId));
        $this->process($this->canonical(eventId: $eventId, body: '重复投递'));

        $conv = Conversation::withoutGlobalScopes()->firstOrFail();

        // The broker redelivers on any unacked message; the ledger is what stops
        // a duplicate from becoming a second message.
        $this->assertSame(1, $conv->message_count);
        $this->assertSame(1, Message::where('conversation_id', $conv->id)->count());
    }

    public function test_the_event_is_written_to_the_idempotency_ledger(): void
    {
        $eventId = (string) Str::uuid();

        $this->process($this->canonical(eventId: $eventId));

        $this->assertDatabaseHas('processed_webhook_events', [
            'event_id'     => $eventId,
            'company_id'   => $this->company->id,
            'channel_type' => 'whatsapp_qr',
        ]);
    }

    public function test_a_second_contact_on_the_same_channel_gets_its_own_conversation(): void
    {
        $this->process($this->canonical(sender: '628111111111'));
        $this->process($this->canonical(sender: '628222222222'));

        $this->assertSame(2, Conversation::withoutGlobalScopes()->count());
        $this->assertSame(2, DB::table('contacts')->count());
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private function canonical(
        ?string $eventId = null,
        string $body = '测试消息',
        string $sender = '628999000111',
    ): CanonicalMessage {
        return CanonicalMessage::fromArray([
            'event_id'            => $eventId ?? (string) Str::uuid(),
            'company_id'          => $this->company->id,
            'channel_id'          => $this->channel->id,
            'channel_type'        => 'whatsapp_qr',
            'direction'           => 'inbound',
            'idempotency_key'     => 'test-' . Str::random(8),
            'sender_external_id'  => $sender,
            'sender_name'         => '测试联系人',
            'sender_avatar'       => null,
            'content_type'        => 'text',
            'content'             => ['body' => $body],
            'quoted_message_id'   => null,
            'conversation_ref_id' => null,
            'provider_timestamp'  => now()->toISOString(),
            'received_at'         => now()->toISOString(),
            'raw_payload'         => [],
        ]);
    }

    private function process(CanonicalMessage $msg): void
    {
        // Mirrors ConsumeRabbitMQ, which invokes the job through the container
        // rather than the queue.
        app()->call([new ProcessInboundMessage($msg), 'handle']);
    }
}
