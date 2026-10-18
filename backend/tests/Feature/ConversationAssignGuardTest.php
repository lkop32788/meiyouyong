<?php

namespace Tests\Feature;

use App\Models\AgentChannel;
use App\Models\Channel;
use App\Models\Company;
use App\Models\Conversation;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * POST /api/conversations/{id}/assign must never create a "black hole":
 * the target has to be an active member of the same company, and an
 * agent-role target must actually be assigned to the conversation's channel —
 * otherwise the conversation would vanish from every inbox the target can see.
 * Agents themselves may only claim, never transfer.
 */
class ConversationAssignGuardTest extends TestCase
{
    use RefreshDatabase;

    private Company $company;
    private Channel $channel;
    private Conversation $conversation;

    protected function setUp(): void
    {
        parent::setUp();

        $this->company      = Company::factory()->create();
        $this->channel      = Channel::factory()->for($this->company)->create();
        $this->conversation = Conversation::factory()->onChannel($this->channel)->create();
    }

    private function grantChannel(User $agent): void
    {
        AgentChannel::create([
            'agent_id'   => $agent->id,
            'channel_id' => $this->channel->id,
            'company_id' => $this->company->id,
        ]);
    }

    private function assign(string $agentId)
    {
        return $this->postJson("/api/conversations/{$this->conversation->id}/assign", [
            'agent_id' => $agentId,
        ]);
    }

    private function assertUnassigned(): void
    {
        $this->assertNull(
            Conversation::withoutGlobalScopes()->find($this->conversation->id)->assigned_agent_id
        );
    }

    // ── Supervisor transfers ─────────────────────────────────────────────────

    public function test_supervisor_can_assign_to_an_agent_with_the_channel(): void
    {
        Sanctum::actingAs(User::factory()->for($this->company)->supervisor()->create(), ['*']);
        $agent = User::factory()->for($this->company)->agent()->create();
        $this->grantChannel($agent);

        $this->assign($agent->id)->assertOk();

        $this->assertSame(
            $agent->id,
            Conversation::withoutGlobalScopes()->find($this->conversation->id)->assigned_agent_id
        );
    }

    public function test_supervisor_cannot_assign_to_an_agent_without_the_channel(): void
    {
        Sanctum::actingAs(User::factory()->for($this->company)->supervisor()->create(), ['*']);
        $agent = User::factory()->for($this->company)->agent()->create();

        $this->assign($agent->id)->assertStatus(422);
        $this->assertUnassigned();
    }

    public function test_supervisor_can_assign_to_a_manager_without_channel_assignment(): void
    {
        Sanctum::actingAs(User::factory()->for($this->company)->supervisor()->create(), ['*']);
        $admin = User::factory()->for($this->company)->admin()->create();

        // Managers see every channel, so no agent_channels row is required.
        $this->assign($admin->id)->assertOk();
    }

    public function test_cannot_assign_to_a_user_of_another_company(): void
    {
        Sanctum::actingAs(User::factory()->for($this->company)->supervisor()->create(), ['*']);
        $outsider = User::factory()->for(Company::factory()->create())->agent()->create();

        $this->assign($outsider->id)->assertStatus(422);
        $this->assertUnassigned();
    }

    public function test_cannot_assign_to_a_deactivated_member(): void
    {
        Sanctum::actingAs(User::factory()->for($this->company)->supervisor()->create(), ['*']);
        $agent = User::factory()->for($this->company)->agent()->create(['is_active' => false]);
        $this->grantChannel($agent);

        $this->assign($agent->id)->assertStatus(422);
        $this->assertUnassigned();
    }

    // ── Agent claims ─────────────────────────────────────────────────────────

    public function test_agent_can_claim_a_conversation_for_themselves(): void
    {
        $agent = User::factory()->for($this->company)->agent()->create();
        $this->grantChannel($agent);
        Sanctum::actingAs($agent, ['*']);

        $this->assign($agent->id)->assertOk();
    }

    public function test_agent_cannot_transfer_to_someone_else(): void
    {
        $agent = User::factory()->for($this->company)->agent()->create();
        $other = User::factory()->for($this->company)->agent()->create();
        $this->grantChannel($agent);
        $this->grantChannel($other);
        Sanctum::actingAs($agent, ['*']);

        $this->assign($other->id)->assertStatus(403);
        $this->assertUnassigned();
    }
}
