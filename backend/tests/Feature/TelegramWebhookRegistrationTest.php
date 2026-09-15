<?php

namespace Tests\Feature;

use App\Models\Channel;
use App\Models\Company;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

/**
 * Telegram inbound had two independent breaks:
 *
 *   - nothing in the repo ever called setWebhook, so Telegram had no URL to
 *     deliver to;
 *   - the gateway's verifyTelegram demands an X-Telegram-Bot-Api-Secret-Token
 *     header, which Telegram only sends when the webhook was registered WITH a
 *     secret_token, and reads the expected value from credentials as
 *     app_secret / channel_secret — while the UI only ever wrote bot_token.
 *
 * Registering mints the secret and stores it under the key the gateway looks
 * for, closing both.
 */
class TelegramWebhookRegistrationTest extends TestCase
{
    use RefreshDatabase;

    private Company $company;
    private Channel $channel;

    protected function setUp(): void
    {
        parent::setUp();

        $this->company = Company::factory()->create();
        $this->actingAsRole('admin', $this->company);

        $this->channel = Channel::factory()->for($this->company)->create(['type' => 'telegram']);
        $this->channel->setCredentials(['bot_token' => '123456:TEST-TOKEN']);
        $this->channel->save();
    }

    public function test_registering_stores_a_secret_the_gateway_can_verify_against(): void
    {
        $this->fakeTelegram();

        $this->postJson("/api/channels/{$this->channel->id}/telegram/register-webhook")
            ->assertOk()
            ->assertJsonPath('bot', 'omniclick_test_bot');

        $creds = $this->channel->fresh()->getCredentials();
        $this->assertNotEmpty($creds['channel_secret'] ?? null);
        // bot_token must survive — it is what the outbound adapter sends with.
        $this->assertSame('123456:TEST-TOKEN', $creds['bot_token']);

        Http::assertSent(function (Request $r) use ($creds) {
            return str_contains($r->url(), '/setWebhook')
                && $r['secret_token'] === $creds['channel_secret']
                && str_contains($r['url'], "/webhook/telegram/{$this->channel->id}");
        });
    }

    public function test_re_registering_keeps_the_existing_secret(): void
    {
        $this->fakeTelegram();

        $this->postJson("/api/channels/{$this->channel->id}/telegram/register-webhook")->assertOk();
        $first = $this->channel->fresh()->getCredentials()['channel_secret'];

        $this->postJson("/api/channels/{$this->channel->id}/telegram/register-webhook")->assertOk();
        $second = $this->channel->fresh()->getCredentials()['channel_secret'];

        // Rotating on every click would 401 deliveries the gateway is still
        // verifying against the old value.
        $this->assertSame($first, $second);
    }

    public function test_a_channel_without_a_bot_token_is_rejected(): void
    {
        $this->channel->setCredentials(['mode' => 'telegram']);
        $this->channel->save();
        $this->fakeTelegram();

        $this->postJson("/api/channels/{$this->channel->id}/telegram/register-webhook")
            ->assertStatus(422);

        Http::assertNothingSent();
    }

    public function test_a_rejection_from_telegram_is_surfaced_not_swallowed(): void
    {
        Http::fake([
            '*/setWebhook' => Http::response([
                'ok'          => false,
                'error_code'  => 401,
                'description' => 'Unauthorized',
            ], 200),
        ]);

        $this->postJson("/api/channels/{$this->channel->id}/telegram/register-webhook")
            ->assertStatus(502);

        // Nothing was stored, so the gateway keeps rejecting rather than
        // verifying against a secret Telegram never accepted.
        $this->assertArrayNotHasKey('channel_secret', $this->channel->fresh()->getCredentials());
    }

    public function test_a_non_telegram_channel_is_not_found(): void
    {
        $other = Channel::factory()->for($this->company)->create(['type' => 'whatsapp']);
        $this->fakeTelegram();

        $this->postJson("/api/channels/{$other->id}/telegram/register-webhook")->assertNotFound();
    }

    public function test_registration_is_scoped_to_the_callers_company(): void
    {
        $outsider = Channel::factory()->create(['type' => 'telegram']);
        $this->fakeTelegram();

        $this->postJson("/api/channels/{$outsider->id}/telegram/register-webhook")->assertNotFound();
    }

    private function fakeTelegram(): void
    {
        Http::fake([
            '*/setWebhook' => Http::response(['ok' => true, 'result' => true], 200),
            '*/getMe'      => Http::response(['ok' => true, 'result' => ['username' => 'omniclick_test_bot']], 200),
        ]);
    }
}
