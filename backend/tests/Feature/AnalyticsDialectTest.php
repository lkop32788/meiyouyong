<?php

namespace Tests\Feature;

use App\Models\Channel;
use App\Models\Company;
use App\Models\Contact;
use App\Models\Conversation;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Tests\TestCase;

/**
 * AnalyticsController was written in T-SQL (DATEPART / GETUTCDATE / DATEDIFF
 * with a unit argument) but runs on MySQL, so two endpoints 500'd and — because
 * the frontend batched all six with Promise.all and no .catch — every analytics
 * tab rendered blank.
 *
 * These tests assert the rewritten queries produce the RIGHT values, not just a
 * 200: a dialect port that returns the wrong weekday or the wrong age would
 * pass a smoke test and still be broken.
 */
class AnalyticsDialectTest extends TestCase
{
    use RefreshDatabase;

    private Company $company;

    protected function setUp(): void
    {
        parent::setUp();
        $this->company = Company::factory()->create();
        $this->actingAsRole('admin', $this->company);
    }

    public function test_every_analytics_endpoint_responds(): void
    {
        $from = now()->subDays(7)->toDateString();
        $to   = now()->toDateString();

        $this->getJson("/api/analytics/overview?date_from={$from}&date_to={$to}")->assertOk();
        $this->getJson("/api/analytics/volume-trend?date_from={$from}&date_to={$to}")->assertOk();
        $this->getJson("/api/analytics/channel-breakdown?date_from={$from}&date_to={$to}")->assertOk();
        $this->getJson("/api/analytics/agent-performance?date={$to}")->assertOk();
        $this->getJson('/api/analytics/sla-breaches')->assertOk();
        $this->getJson('/api/analytics/hourly-heatmap?weeks=4')->assertOk();
    }

    // ── hourlyHeatmap: DAYOFWEEK() - 1 and HOUR() ────────────────────────────

    public function test_heatmap_buckets_land_on_the_right_weekday_and_hour(): void
    {
        $channel = Channel::factory()->for($this->company)->create();

        // Most recent Sunday (Carbon dayOfWeek: 0 = Sunday) at 14:00, which is
        // inside the 4-week window the endpoint queries.
        $sunday = now()->subDays(now()->dayOfWeek)->setTime(14, 0);

        DB::table('analytics_hourly_volume')->insert([
            'company_id'     => $this->company->id,
            'channel_id'     => $channel->id,
            'channel_type'   => 'whatsapp',
            'hour_bucket'    => $sunday,
            'inbound_count'  => 7,
            'outbound_count' => 0,
            'new_conv_count' => 0,
            'resolved_count' => 0,
        ]);

        $rows = $this->getJson('/api/analytics/hourly-heatmap?weeks=4')->assertOk()->json();

        // The frontend indexes ['周日','周一',…,'周六'] by this first element,
        // so 0 must mean Sunday.
        $this->assertContains([0, 14, 7], $rows);
    }

    public function test_heatmap_sums_volume_across_channels_in_the_same_bucket(): void
    {
        $a = Channel::factory()->for($this->company)->create();
        $b = Channel::factory()->for($this->company)->create();
        $bucket = now()->subDays(now()->dayOfWeek)->setTime(9, 0);

        foreach ([[$a, 3], [$b, 4]] as [$channel, $count]) {
            DB::table('analytics_hourly_volume')->insert([
                'company_id'     => $this->company->id,
                'channel_id'     => $channel->id,
                'channel_type'   => 'whatsapp',
                'hour_bucket'    => $bucket,
                'inbound_count'  => $count,
                'outbound_count' => 0,
                'new_conv_count' => 0,
                'resolved_count' => 0,
            ]);
        }

        $rows = $this->getJson('/api/analytics/hourly-heatmap?weeks=4')->assertOk()->json();

        $this->assertContains([0, 9, 7], $rows);
    }

    public function test_heatmap_is_scoped_to_the_callers_company(): void
    {
        $other = Company::factory()->create();
        $channel = Channel::factory()->for($other)->create();

        DB::table('analytics_hourly_volume')->insert([
            'company_id'     => $other->id,
            'channel_id'     => $channel->id,
            'channel_type'   => 'whatsapp',
            'hour_bucket'    => now()->subDays(now()->dayOfWeek)->setTime(11, 0),
            'inbound_count'  => 99,
            'outbound_count' => 0,
            'new_conv_count' => 0,
            'resolved_count' => 0,
        ]);

        $this->assertSame([], $this->getJson('/api/analytics/hourly-heatmap?weeks=4')->assertOk()->json());
    }

    // ── slaBreaches: TIMESTAMPDIFF(SECOND, …, UTC_TIMESTAMP()) ───────────────

    public function test_sla_breaches_reports_conversations_past_the_threshold(): void
    {
        $channel = $this->seedSlaConfig(threshold: 300);
        $breaching = $this->seedUnansweredConversation($channel, createdSecondsAgo: 900);

        $rows = $this->getJson('/api/analytics/sla-breaches')->assertOk()->json();

        $row = collect($rows)->firstWhere('conversation_id', $breaching->id);
        $this->assertNotNull($row, 'a 900s-old conversation should breach a 300s SLA');
        $this->assertSame(300, (int) $row['threshold_seconds']);

        // TIMESTAMPDIFF returns seconds; a unit mix-up (MySQL's 2-arg DATEDIFF
        // returns days) would land nowhere near 900.
        $this->assertEqualsWithDelta(900, (int) $row['age_seconds'], 30);
    }

    public function test_sla_breaches_excludes_conversations_inside_the_threshold(): void
    {
        $channel = $this->seedSlaConfig(threshold: 3600);
        $fresh   = $this->seedUnansweredConversation($channel, createdSecondsAgo: 60);

        $rows = $this->getJson('/api/analytics/sla-breaches')->assertOk()->json();

        $this->assertNull(collect($rows)->firstWhere('conversation_id', $fresh->id));
    }

    public function test_sla_breaches_ignores_conversations_that_were_answered(): void
    {
        $channel = $this->seedSlaConfig(threshold: 60);
        $answered = $this->seedUnansweredConversation($channel, createdSecondsAgo: 900);
        $answered->update(['first_response_at' => now()->subMinutes(10)]);

        $rows = $this->getJson('/api/analytics/sla-breaches')->assertOk()->json();

        $this->assertNull(collect($rows)->firstWhere('conversation_id', $answered->id));
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private function seedSlaConfig(int $threshold): Channel
    {
        $channel = Channel::factory()->for($this->company)->create();

        DB::table('sla_configs')->insert([
            'id'                     => Str::uuid()->toString(),
            'company_id'             => $this->company->id,
            'channel_id'             => $channel->id,
            'first_response_seconds' => $threshold,
            'resolution_seconds'     => $threshold * 10,
            'business_hours_only'    => 0,
            'is_active'              => 1,
            'created_at'             => now(),
        ]);

        return $channel;
    }

    private function seedUnansweredConversation(Channel $channel, int $createdSecondsAgo): Conversation
    {
        $conv = Conversation::factory()->onChannel($channel)->create([
            'status'            => 'open',
            'first_response_at' => null,
        ]);

        // created_at is not fillable through the factory state.
        DB::table('conversations')
            ->where('id', $conv->id)
            ->update(['created_at' => now()->subSeconds($createdSecondsAgo)]);

        return $conv->fresh();
    }
}
