<?php

namespace Tests\Feature;

use App\Models\AgentChannel;
use App\Models\Channel;
use App\Models\Company;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * GET /internal/agent/{id}/channels — the Realtime Server uses this to decide
 * which channel rooms an agent socket may join. Must be key-guarded and
 * fail-closed for deactivated members.
 */
class InternalAgentChannelsTest extends TestCase
{
    use RefreshDatabase;

    private const KEY = 'test-internal-key';

    protected function setUp(): void
    {
        parent::setUp();
        config(['app.internal_api_key' => self::KEY]);
    }

    public function test_rejects_requests_without_internal_key(): void
    {
        $agent = User::factory()->for(Company::factory()->create())->agent()->create();

        $this->getJson("/internal/agent/{$agent->id}/channels")->assertStatus(401);
    }

    public function test_returns_assigned_channel_ids(): void
    {
        $company = Company::factory()->create();
        $agent   = User::factory()->for($company)->agent()->create();
        $channel = Channel::factory()->for($company)->create();

        AgentChannel::create([
            'agent_id'   => $agent->id,
            'channel_id' => $channel->id,
            'company_id' => $company->id,
        ]);

        $this->getJson("/internal/agent/{$agent->id}/channels", ['X-Internal-Key' => self::KEY])
            ->assertOk()
            ->assertJson([
                'agent_id'    => $agent->id,
                'company_id'  => $company->id,
                'channel_ids' => [$channel->id],
            ]);
    }

    public function test_agent_without_assignments_gets_empty_list(): void
    {
        $agent = User::factory()->for(Company::factory()->create())->agent()->create();

        $this->getJson("/internal/agent/{$agent->id}/channels", ['X-Internal-Key' => self::KEY])
            ->assertOk()
            ->assertJson(['channel_ids' => []]);
    }

    public function test_deactivated_agent_is_not_found(): void
    {
        $agent = User::factory()->for(Company::factory()->create())->agent()
            ->create(['is_active' => false]);

        $this->getJson("/internal/agent/{$agent->id}/channels", ['X-Internal-Key' => self::KEY])
            ->assertStatus(404);
    }
}
