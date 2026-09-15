<?php

namespace Tests\Feature;

use App\Models\Channel;
use App\Models\Company;
use App\Models\Contact;
use App\Models\ContactChannelIdentity;
use App\Models\Conversation;
use App\Services\Channels\ChannelSendException;
use App\Services\Channels\TelegramAdapter;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

/**
 * Telegram inbound already worked (gateway route + normalizer), but there was
 * no outbound adapter — AdapterRegistry::forChannel('telegram') threw
 * \InvalidArgumentException, which ChannelRoutingService did not catch, so a
 * reply did not merely fail: it tore through the whole outbound stack.
 *
 * Request shapes mirror wabapanel's telegramService.js.
 */
class TelegramAdapterTest extends TestCase
{
    use RefreshDatabase;

    private Company $company;
    private Channel $channel;
    private Contact $contact;
    private Conversation $conversation;

    protected function setUp(): void
    {
        parent::setUp();

        $this->company = Company::factory()->create();
        $this->channel = Channel::factory()->for($this->company)->create(['type' => 'telegram']);
        $this->channel->setCredentials(['bot_token' => '123456:TEST-TOKEN']);
        $this->channel->save();

        $this->contact = Contact::factory()->for($this->company)->create();
        ContactChannelIdentity::create([
            'contact_id'   => $this->contact->id,
            'company_id'   => $this->company->id,
            'channel_type' => 'telegram',
            'external_id'  => '987654321',
        ]);

        $this->conversation = Conversation::factory()->create([
            'company_id' => $this->company->id,
            'channel_id' => $this->channel->id,
            'contact_id' => $this->contact->id,
        ]);
    }

    public function test_a_text_message_goes_to_sendmessage_with_the_chat_id(): void
    {
        $this->fakeOk(messageId: 4242);

        $providerId = $this->send('text', ['body' => '你好']);

        $this->assertSame('4242', $providerId);

        Http::assertSent(function (Request $r) {
            return str_contains($r->url(), '/bot123456:TEST-TOKEN/sendMessage')
                && $r['chat_id'] === '987654321'
                && $r['text'] === '你好';
        });
    }

    public function test_media_maps_to_the_matching_bot_api_method(): void
    {
        foreach ([
            'image' => ['sendPhoto', 'photo'],
            'audio' => ['sendAudio', 'audio'],
            'video' => ['sendVideo', 'video'],
            'file'  => ['sendDocument', 'document'],
        ] as $contentType => [$method, $field]) {
            $this->fakeOk();

            $this->send($contentType, ['url' => 'https://cdn.example/a.bin', 'caption' => '说明']);

            Http::assertSent(fn (Request $r) => str_contains($r->url(), "/{$method}")
                && $r[$field] === 'https://cdn.example/a.bin'
                && $r['caption'] === '说明');
        }
    }

    public function test_a_quoted_message_is_translated_into_reply_to_message_id(): void
    {
        $this->fakeOk();

        // The gateway normalizer stores quoted ids as tg_{message_id}_{sender}.
        $this->send('text', ['body' => '回复'], replyTo: 'tg_555_987654321');

        Http::assertSent(fn (Request $r) => $r['reply_to_message_id'] === 555);
    }

    public function test_an_unquoted_message_carries_no_reply_field(): void
    {
        $this->fakeOk();

        $this->send('text', ['body' => '普通消息']);

        Http::assertSent(fn (Request $r) => ! isset($r['reply_to_message_id']));
    }

    public function test_a_missing_bot_token_is_a_send_exception(): void
    {
        $this->channel->setCredentials(['mode' => 'telegram']);
        $this->channel->save();
        $this->fakeOk();

        $this->expectException(ChannelSendException::class);
        $this->send('text', ['body' => 'hi']);
    }

    public function test_a_contact_without_a_telegram_identity_is_a_send_exception(): void
    {
        ContactChannelIdentity::where('contact_id', $this->contact->id)->delete();
        $this->fakeOk();

        $this->expectException(ChannelSendException::class);
        $this->send('text', ['body' => 'hi']);
    }

    public function test_an_ok_false_body_is_a_failure_even_with_http_200(): void
    {
        // Telegram answers 200 with ok=false for blocked bots and unknown chats,
        // so the status code alone would report a delivered message.
        Http::fake([
            'api.telegram.org/*' => Http::response([
                'ok'          => false,
                'error_code'  => 403,
                'description' => 'Forbidden: bot was blocked by the user',
            ], 200),
        ]);

        try {
            $this->send('text', ['body' => 'hi']);
            $this->fail('expected ChannelSendException');
        } catch (ChannelSendException $e) {
            $this->assertSame('telegram', $e->channelType);
            $this->assertSame('403', $e->providerErrorCode);
            $this->assertStringContainsString('blocked', $e->getMessage());
        }
    }

    public function test_a_transport_failure_is_a_send_exception(): void
    {
        Http::fake(['api.telegram.org/*' => Http::response(['description' => 'Bad Gateway'], 502)]);

        $this->expectException(ChannelSendException::class);
        $this->send('text', ['body' => 'hi']);
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private function fakeOk(int $messageId = 1): void
    {
        Http::fake([
            'api.telegram.org/*' => Http::response(['ok' => true, 'result' => ['message_id' => $messageId]], 200),
        ]);
    }

    private function send(string $contentType, array $content, ?string $replyTo = null): string
    {
        return (new TelegramAdapter())->send(
            $this->conversation,
            $this->contact,
            $this->channel,
            $contentType,
            $content,
            $replyTo,
        );
    }
}
