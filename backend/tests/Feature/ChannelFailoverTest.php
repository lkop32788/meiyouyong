<?php

namespace Tests\Feature;

use App\Models\Channel;
use App\Models\Company;
use App\Models\Contact;
use App\Models\Conversation;
use App\Services\Channels\AdapterRegistry;
use App\Services\Channels\ChannelAdapterInterface;
use App\Services\Channels\ChannelRoutingService;
use App\Services\Channels\ChannelSendException;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * AdapterRegistry::forChannel() throws \InvalidArgumentException for a channel
 * type with no registered adapter, but ChannelRoutingService only caught
 * ChannelSendException — so an unregistered type (telegram) or an adapter that
 * threw a raw Error (the Facebook withToken() bug) blew straight past the
 * failover loop and out of the whole outbound stack.
 *
 * A channel with no adapter should behave like a dead channel, not a crash.
 */
class ChannelFailoverTest extends TestCase
{
    use RefreshDatabase;

    private Company $company;

    protected function setUp(): void
    {
        parent::setUp();
        $this->company = Company::factory()->create();
    }

    public function test_an_unregistered_channel_type_raises_a_send_exception_not_a_type_error(): void
    {
        // telegram has an inbound normalizer in the gateway but no outbound
        // adapter registered in AppServiceProvider.
        $conv = $this->conversationOn('telegram');

        $this->expectException(ChannelSendException::class);

        app(ChannelRoutingService::class)->send(
            $conv, $conv->contact, 'text', ['body' => 'hi']
        );
    }

    public function test_an_unregistered_primary_falls_over_to_a_working_channel(): void
    {
        $backup = Channel::factory()->for($this->company)->create(['type' => 'whatsapp']);

        $conv = $this->conversationOn('telegram');
        $conv->channel->update(['failover_channel_ids' => [$backup->id]]);

        // Stand in for WhatsAppCloudAdapter so nothing leaves the box.
        $this->swapRegistryWithStub('whatsapp', 'stub-provider-id');

        $result = app(ChannelRoutingService::class)->send(
            $conv, $conv->contact, 'text', ['body' => 'hi']
        );

        $this->assertSame($backup->id, $result['channel_id']);
        $this->assertSame('stub-provider-id', $result['provider_message_id']);
    }

    public function test_an_inactive_primary_channel_is_reported_as_a_send_exception(): void
    {
        $conv = $this->conversationOn('whatsapp');
        $conv->channel->update(['is_active' => false]);

        $this->expectException(ChannelSendException::class);

        app(ChannelRoutingService::class)->send(
            $conv, $conv->contact, 'text', ['body' => 'hi']
        );
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private function conversationOn(string $type): Conversation
    {
        $channel = Channel::factory()->for($this->company)->create(['type' => $type]);
        $contact = Contact::factory()->for($this->company)->create();

        return Conversation::factory()->create([
            'company_id' => $this->company->id,
            'channel_id' => $channel->id,
            'contact_id' => $contact->id,
        ])->load('channel', 'contact');
    }

    /** Register a single no-op adapter for $type and nothing else. */
    private function swapRegistryWithStub(string $type, string $providerMessageId): void
    {
        $adapter = new class($type, $providerMessageId) implements ChannelAdapterInterface
        {
            public function __construct(
                private readonly string $type,
                private readonly string $providerMessageId,
            ) {}

            public function send(
                Conversation $conv,
                Contact $contact,
                Channel $channel,
                string $contentType,
                array $content,
                ?string $replyToProviderMsgId = null
            ): string {
                return $this->providerMessageId;
            }

            public function supports(string $channelType): bool
            {
                return $channelType === $this->type;
            }
        };

        $this->app->instance(AdapterRegistry::class, new AdapterRegistry([$adapter]));
    }
}
