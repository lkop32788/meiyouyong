<?php

namespace Tests\Feature;

use App\Jobs\BuildAudienceJob;
use App\Models\AudienceSnapshotRecipient;
use App\Models\BroadcastCampaign;
use App\Models\Channel;
use App\Models\Company;
use App\Models\Contact;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Queue;
use Tests\TestCase;

/**
 * BuildAudienceJob had two defects that made every broadcast fail:
 *
 *   - it read $channel->channel_type, but `channels` only has `type`, so the
 *     job always bailed out as "channel not found" and marked the campaign
 *     failed;
 *   - tag audiences used T-SQL OPENJSON, a hard error on MySQL.
 *
 * The replacement is JSON_CONTAINS(c.tags, ?), which matches only when EVERY
 * requested tag is present — the semantics the old COUNT(DISTINCT value) =
 * $tagCount was expressing. These tests pin that down.
 */
class BuildAudienceTagFilterTest extends TestCase
{
    use RefreshDatabase;

    private Company $company;
    private Channel $channel;

    protected function setUp(): void
    {
        parent::setUp();

        Queue::fake(); // stop the job from chaining into real sends

        $this->company = Company::factory()->create();
        $this->channel = Channel::factory()->for($this->company)->create(['type' => 'whatsapp']);
    }

    public function test_tag_audience_requires_every_requested_tag(): void
    {
        $both    = $this->seedContact('both', ['vip', 'refund']);
        $partial = $this->seedContact('partial', ['vip']);
        $extra   = $this->seedContact('extra', ['vip', 'refund', 'new']);
        $none    = $this->seedContact('none', []);
        $null    = $this->seedContact('null', null);

        $this->runAudienceBuild(['vip', 'refund']);

        $selected = AudienceSnapshotRecipient::pluck('contact_id')->all();

        $this->assertContains($both->id, $selected, '两个标签都有，应入选');
        $this->assertContains($extra->id, $selected, '标签是超集，应入选');
        $this->assertNotContains($partial->id, $selected, '只有一个标签，不应入选');
        $this->assertNotContains($none->id, $selected, '空标签数组，不应入选');
        $this->assertNotContains($null->id, $selected, 'tags 为 NULL，不应入选');
    }

    public function test_a_single_tag_audience_matches_any_contact_carrying_it(): void
    {
        $vip   = $this->seedContact('vip', ['vip']);
        $other = $this->seedContact('other', ['refund']);

        $this->runAudienceBuild(['vip']);

        $selected = AudienceSnapshotRecipient::pluck('contact_id')->all();

        $this->assertContains($vip->id, $selected);
        $this->assertNotContains($other->id, $selected);
    }

    public function test_audience_all_selects_every_contact_with_an_identity_on_the_channel(): void
    {
        $a = $this->seedContact('a', ['vip']);
        $b = $this->seedContact('b', null);

        $this->runAudienceBuild(tags: null, audienceType: 'all');

        $selected = AudienceSnapshotRecipient::pluck('contact_id')->all();

        $this->assertContains($a->id, $selected);
        $this->assertContains($b->id, $selected);
    }

    public function test_the_campaign_is_not_marked_failed_when_the_audience_resolves(): void
    {
        $this->seedContact('someone', ['vip']);

        $campaign = $this->runAudienceBuild(['vip']);

        // The channel_type column bug used to land every campaign here as
        // 'failed' with an empty audience.
        $this->assertSame('running', $campaign->fresh()->status);
        $this->assertSame(1, $campaign->fresh()->total_recipients);
    }

    public function test_contacts_without_an_identity_on_the_channel_are_excluded(): void
    {
        $withIdentity = $this->seedContact('has', ['vip']);

        // Same tag, but its identity is on a different channel type.
        $orphan = Contact::factory()->for($this->company)->create(['tags' => ['vip']]);
        DB::table('contact_channel_identities')->insert([
            'contact_id'   => $orphan->id,
            'company_id'   => $this->company->id,
            'channel_type' => 'telegram',
            'external_id'  => 'tg-1',
            'created_at'   => now(),
            'updated_at'   => now(),
        ]);

        $this->runAudienceBuild(['vip']);

        $selected = AudienceSnapshotRecipient::pluck('contact_id')->all();

        $this->assertContains($withIdentity->id, $selected);
        $this->assertNotContains($orphan->id, $selected);
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private function seedContact(string $name, ?array $tags): Contact
    {
        $contact = Contact::factory()->for($this->company)->create([
            'name' => $name,
            'tags' => $tags,
        ]);

        DB::table('contact_channel_identities')->insert([
            'contact_id'   => $contact->id,
            'company_id'   => $this->company->id,
            'channel_type' => $this->channel->type,
            'external_id'  => 'wa-' . $name,
            'created_at'   => now(),
            'updated_at'   => now(),
        ]);

        return $contact;
    }

    private function runAudienceBuild(?array $tags, string $audienceType = 'tag'): BroadcastCampaign
    {
        $campaign = BroadcastCampaign::create([
            'company_id'      => $this->company->id,
            'channel_id'      => $this->channel->id,
            'name'            => 'flowtest campaign',
            'status'          => 'scheduled',
            'message_content' => ['body' => 'hello'],
            'audience_type'   => $audienceType,
            'audience_config' => $tags === null ? [] : ['tags' => $tags],
        ]);

        (new BuildAudienceJob($campaign->id))->handle();

        return $campaign;
    }
}
