<?php

namespace Tests\Feature;

use App\Models\Channel;
use App\Models\Company;
use App\Models\Contact;
use App\Models\Conversation;
use App\Models\Message;
use App\Models\User;
use App\Services\Channels\AdapterRegistry;
use App\Services\OutboundMessageService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\Concerns\RefreshesMongo;
use Tests\Support\StubChannelAdapter;
use Tests\TestCase;

/**
 * Bot flows, CSAT surveys and broadcasts used to call a 6-argument send() with
 * 2 arguments — an ArgumentCountError. Fixing only the arity would not have been
 * enough: persistOutbound hardcoded sender_type 'agent', so every bot message
 * would have been filed as an agent message and skewed bot_messages,
 * was_bot_handled and bot_containment_pct.
 *
 * That is the difference between "no analytics" and "wrong analytics", so the
 * sender attribution is what these tests pin down.
 */
class OutboundSenderTypeTest extends TestCase
{
    use RefreshDatabase;
    use RefreshesMongo;

    private Company $company;
    private Conversation $conversation;
    private StubChannelAdapter $adapter;

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
        ])->load('channel', 'contact');

        $this->adapter = new StubChannelAdapter();
        $this->app->instance(AdapterRegistry::class, new AdapterRegistry([$this->adapter]));
    }

    public function test_a_bot_message_is_attributed_to_the_bot_not_an_agent(): void
    {
        app(OutboundMessageService::class)
            ->sendSystemMessage($this->conversation, 'text', ['body' => 'halo dari bot']);

        $msg = Message::where('conversation_id', $this->conversation->id)->firstOrFail();

        $this->assertSame('bot', $msg->sender_type);
        $this->assertTrue((bool) $msg->is_automated);
        $this->assertNull($msg->sender_id);
        $this->assertSame('outbound', $msg->direction);
    }

    public function test_a_broadcast_message_carries_its_own_sender_type(): void
    {
        app(OutboundMessageService::class)
            ->sendSystemMessage($this->conversation, 'text', ['body' => 'promo'], 'broadcast');

        $msg = Message::where('conversation_id', $this->conversation->id)->firstOrFail();

        $this->assertSame('broadcast', $msg->sender_type);
        $this->assertTrue((bool) $msg->is_automated);
    }

    public function test_an_agent_message_is_still_attributed_to_that_agent(): void
    {
        $agent = User::factory()->for($this->company)->agent()->create();

        app(OutboundMessageService::class)->send(
            $this->conversation,
            $this->conversation->contact,
            $agent->id,
            'text',
            ['body' => 'halo dari agent'],
        );

        $msg = Message::where('conversation_id', $this->conversation->id)->firstOrFail();

        $this->assertSame('agent', $msg->sender_type);
        $this->assertFalse((bool) $msg->is_automated);
        $this->assertSame($agent->id, $msg->sender_id);
    }

    public function test_the_adapter_receives_the_body_key_the_contract_expects(): void
    {
        app(OutboundMessageService::class)
            ->sendSystemMessage($this->conversation, 'text', ['body' => 'isi pesan']);

        // The old bot callers passed content.text; every adapter and the preview
        // builder read content.body, so those messages would have gone out empty.
        $this->assertSame('isi pesan', $this->adapter->sent[0]['content']['body'] ?? null);
    }

    public function test_the_conversation_preview_is_updated_after_a_bot_send(): void
    {
        app(OutboundMessageService::class)
            ->sendSystemMessage($this->conversation, 'text', ['body' => 'isi pesan']);

        $fresh = $this->conversation->fresh();

        $this->assertSame('isi pesan', $fresh->last_message_preview);
        $this->assertSame('outbound', $fresh->last_message_direction);
    }

    public function test_sending_into_a_conversation_without_a_contact_is_a_send_exception(): void
    {
        $orphan = Conversation::factory()->create([
            'company_id' => $this->company->id,
            'channel_id' => $this->conversation->channel_id,
            'contact_id' => Contact::factory()->for($this->company)->create()->id,
        ]);
        $orphan->contact()->delete();

        $this->expectException(\App\Services\Channels\ChannelSendException::class);

        app(OutboundMessageService::class)
            ->sendSystemMessage($orphan->fresh()->load('contact'), 'text', ['body' => 'hi']);
    }
}
