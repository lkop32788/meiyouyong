<?php

namespace Tests\Feature;

use App\Models\AgentChannel;
use App\Models\Channel;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class AgentChannelAssignmentTest extends TestCase
{
    use RefreshDatabase;

    // ── index ────────────────────────────────────────────────────────────────

    public function test_index_exposes_the_channel_phone_number(): void
    {
        [, $company] = $this->actingAsRole('admin');
        $agent   = User::factory()->for($company)->agent()->create();
        $channel = Channel::factory()->for($company)->create([
            'settings' => ['display_phone_number' => '+6281234567890'],
        ]);
        AgentChannel::create([
            'agent_id' => $agent->id, 'channel_id' => $channel->id, 'company_id' => $company->id,
        ]);

        $row = $this->getJson('/api/agent-channels')->assertOk()->json('0');

        $this->assertSame('+6281234567890', $row['display_phone_number']);
        $this->assertSame($channel->name, $row['channel_name']);
    }

    public function test_index_returns_null_phone_for_a_channel_without_one(): void
    {
        [, $company] = $this->actingAsRole('admin');
        $agent   = User::factory()->for($company)->agent()->create();
        $channel = Channel::factory()->for($company)->withoutPhone()->create();
        AgentChannel::create([
            'agent_id' => $agent->id, 'channel_id' => $channel->id, 'company_id' => $company->id,
        ]);

        $row = $this->getJson('/api/agent-channels')->assertOk()->json('0');

        $this->assertNull($row['display_phone_number']);
    }

    public function test_index_is_scoped_to_the_callers_company(): void
    {
        [, $company] = $this->actingAsRole('admin');
        $mineAgent   = User::factory()->for($company)->agent()->create();
        $mineChannel = Channel::factory()->for($company)->create();
        AgentChannel::create([
            'agent_id' => $mineAgent->id, 'channel_id' => $mineChannel->id, 'company_id' => $company->id,
        ]);

        $otherAgent   = User::factory()->agent()->create();
        $otherChannel = Channel::factory()->for($otherAgent->company)->create();
        AgentChannel::create([
            'agent_id' => $otherAgent->id, 'channel_id' => $otherChannel->id, 'company_id' => $otherAgent->company_id,
        ]);

        $rows = $this->getJson('/api/agent-channels')->assertOk()->json();

        $this->assertCount(1, $rows);
        $this->assertSame($mineAgent->id, $rows[0]['agent_id']);
    }

    public function test_agent_cannot_list_assignments(): void
    {
        $this->actingAsRole('agent');

        $this->getJson('/api/agent-channels')->assertForbidden();
    }

    public function test_supervisor_may_still_list_assignments(): void
    {
        $this->actingAsRole('supervisor');

        $this->getJson('/api/agent-channels')->assertOk();
    }

    // ── store ────────────────────────────────────────────────────────────────

    public function test_admin_can_assign_a_channel_to_an_agent(): void
    {
        [, $company] = $this->actingAsRole('admin');
        $agent   = User::factory()->for($company)->agent()->create();
        $channel = Channel::factory()->for($company)->create();

        $this->postJson('/api/agent-channels', [
            'agent_id' => $agent->id, 'channel_id' => $channel->id,
        ])->assertCreated()->assertJsonPath('agent_id', $agent->id);

        $this->assertDatabaseHas('agent_channels', [
            'agent_id' => $agent->id, 'channel_id' => $channel->id, 'company_id' => $company->id,
        ]);
    }

    public function test_assigning_the_same_channel_twice_is_idempotent(): void
    {
        [, $company] = $this->actingAsRole('admin');
        $agent   = User::factory()->for($company)->agent()->create();
        $channel = Channel::factory()->for($company)->create();
        $payload = ['agent_id' => $agent->id, 'channel_id' => $channel->id];

        $this->postJson('/api/agent-channels', $payload)->assertCreated();
        $this->postJson('/api/agent-channels', $payload)->assertOk();

        $this->assertSame(1, AgentChannel::where('agent_id', $agent->id)->count());
    }

    public function test_cannot_assign_an_inactive_channel(): void
    {
        [, $company] = $this->actingAsRole('admin');
        $agent   = User::factory()->for($company)->agent()->create();
        $channel = Channel::factory()->for($company)->inactive()->create();

        $this->postJson('/api/agent-channels', [
            'agent_id' => $agent->id, 'channel_id' => $channel->id,
        ])->assertStatus(422);
    }

    public function test_cannot_assign_a_channel_belonging_to_another_company(): void
    {
        [, $company] = $this->actingAsRole('admin');
        $agent   = User::factory()->for($company)->agent()->create();
        $foreign = Channel::factory()->create();

        $this->postJson('/api/agent-channels', [
            'agent_id' => $agent->id, 'channel_id' => $foreign->id,
        ])->assertStatus(422);

        $this->assertDatabaseCount('agent_channels', 0);
    }

    public function test_cannot_assign_to_a_member_of_another_company(): void
    {
        [, $company] = $this->actingAsRole('admin');
        $channel  = Channel::factory()->for($company)->create();
        $outsider = User::factory()->agent()->create();

        $this->postJson('/api/agent-channels', [
            'agent_id' => $outsider->id, 'channel_id' => $channel->id,
        ])->assertStatus(422);

        $this->assertDatabaseCount('agent_channels', 0);
    }

    public function test_supervisor_cannot_assign_channels_for_an_admin(): void
    {
        [, $company] = $this->actingAsRole('supervisor');
        $admin   = User::factory()->for($company)->admin()->create();
        $channel = Channel::factory()->for($company)->create();

        $this->postJson('/api/agent-channels', [
            'agent_id' => $admin->id, 'channel_id' => $channel->id,
        ])->assertForbidden();

        $this->assertDatabaseCount('agent_channels', 0);
    }

    public function test_supervisor_can_assign_channels_for_an_agent(): void
    {
        [, $company] = $this->actingAsRole('supervisor');
        $agent   = User::factory()->for($company)->agent()->create();
        $channel = Channel::factory()->for($company)->create();

        $this->postJson('/api/agent-channels', [
            'agent_id' => $agent->id, 'channel_id' => $channel->id,
        ])->assertCreated();
    }

    public function test_agent_cannot_assign_channels(): void
    {
        [, $company] = $this->actingAsRole('agent');
        $agent   = User::factory()->for($company)->agent()->create();
        $channel = Channel::factory()->for($company)->create();

        $this->postJson('/api/agent-channels', [
            'agent_id' => $agent->id, 'channel_id' => $channel->id,
        ])->assertForbidden();
    }

    // ── destroy ──────────────────────────────────────────────────────────────

    public function test_admin_can_remove_an_assignment(): void
    {
        [, $company] = $this->actingAsRole('admin');
        $agent   = User::factory()->for($company)->agent()->create();
        $channel = Channel::factory()->for($company)->create();
        $ac = AgentChannel::create([
            'agent_id' => $agent->id, 'channel_id' => $channel->id, 'company_id' => $company->id,
        ]);

        $this->deleteJson("/api/agent-channels/{$ac->id}")->assertOk();

        $this->assertDatabaseCount('agent_channels', 0);
    }

    public function test_removing_the_assignment_of_a_deactivated_agent_still_works(): void
    {
        [, $company] = $this->actingAsRole('admin');
        $agent   = User::factory()->for($company)->agent()->create();
        $channel = Channel::factory()->for($company)->create();
        $ac = AgentChannel::create([
            'agent_id' => $agent->id, 'channel_id' => $channel->id, 'company_id' => $company->id,
        ]);
        $agent->delete(); // assignments survive the soft delete

        // The agent relation resolves to null for a trashed member — this must
        // not blow up on the authorization check.
        $this->deleteJson("/api/agent-channels/{$ac->id}")->assertOk();

        $this->assertDatabaseCount('agent_channels', 0);
    }

    public function test_supervisor_cannot_remove_an_admins_assignment(): void
    {
        [, $company] = $this->actingAsRole('supervisor');
        $admin   = User::factory()->for($company)->admin()->create();
        $channel = Channel::factory()->for($company)->create();
        $ac = AgentChannel::create([
            'agent_id' => $admin->id, 'channel_id' => $channel->id, 'company_id' => $company->id,
        ]);

        $this->deleteJson("/api/agent-channels/{$ac->id}")->assertForbidden();

        $this->assertDatabaseCount('agent_channels', 1);
    }

    public function test_destroy_is_scoped_to_the_callers_company(): void
    {
        $this->actingAsRole('admin');

        $outsider = User::factory()->agent()->create();
        $channel  = Channel::factory()->for($outsider->company)->create();
        $ac = AgentChannel::create([
            'agent_id' => $outsider->id, 'channel_id' => $channel->id, 'company_id' => $outsider->company_id,
        ]);

        $this->deleteJson("/api/agent-channels/{$ac->id}")->assertNotFound();

        $this->assertDatabaseCount('agent_channels', 1);
    }
}
