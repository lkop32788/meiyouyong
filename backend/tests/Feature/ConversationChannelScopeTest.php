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
 * Agents may only touch conversations from the channels a supervisor assigned
 * to them. Supervisors and admins see the whole company inbox.
 */
class ConversationChannelScopeTest extends TestCase
{
    use RefreshDatabase;

    private Company $company;
    private Channel $assignedChannel;
    private Channel $otherChannel;
    private Conversation $assignedConversation;
    private Conversation $otherConversation;

    protected function setUp(): void
    {
        parent::setUp();

        $this->company         = Company::factory()->create();
        $this->assignedChannel = Channel::factory()->for($this->company)->create();
        $this->otherChannel    = Channel::factory()->for($this->company)->create();

        $this->assignedConversation = Conversation::factory()->onChannel($this->assignedChannel)->create();
        $this->otherConversation    = Conversation::factory()->onChannel($this->otherChannel)->create();
    }

    /** An agent with $this->assignedChannel granted. */
    private function actingAsAssignedAgent(): User
    {
        $agent = User::factory()->for($this->company)->agent()->create();

        AgentChannel::create([
            'agent_id'   => $agent->id,
            'channel_id' => $this->assignedChannel->id,
            'company_id' => $this->company->id,
        ]);

        Sanctum::actingAs($agent, ['*']);

        return $agent;
    }

    private function listedIds(): array
    {
        return collect($this->getJson('/api/conversations?filter=all')->assertOk()->json('data'))
            ->pluck('id')
            ->all();
    }

    // ── Listing ──────────────────────────────────────────────────────────────

    public function test_agent_only_lists_conversations_from_assigned_channels(): void
    {
        $this->actingAsAssignedAgent();

        $ids = $this->listedIds();

        $this->assertContains($this->assignedConversation->id, $ids);
        $this->assertNotContains($this->otherConversation->id, $ids);
    }

    public function test_agent_without_any_assignment_lists_nothing(): void
    {
        $agent = User::factory()->for($this->company)->agent()->create();
        Sanctum::actingAs($agent, ['*']);

        $this->assertSame([], $this->listedIds());
    }

    public function test_supervisor_lists_conversations_from_every_channel(): void
    {
        Sanctum::actingAs(User::factory()->for($this->company)->supervisor()->create(), ['*']);

        $ids = $this->listedIds();

        $this->assertContains($this->assignedConversation->id, $ids);
        $this->assertContains($this->otherConversation->id, $ids);
    }

    public function test_admin_lists_conversations_from_every_channel(): void
    {
        Sanctum::actingAs(User::factory()->for($this->company)->admin()->create(), ['*']);

        $ids = $this->listedIds();

        $this->assertContains($this->assignedConversation->id, $ids);
        $this->assertContains($this->otherConversation->id, $ids);
    }

    // ── Direct access by UUID ────────────────────────────────────────────────

    public function test_agent_can_open_a_conversation_from_an_assigned_channel(): void
    {
        $this->actingAsAssignedAgent();

        $this->getJson("/api/conversations/{$this->assignedConversation->id}")->assertOk();
    }

    public function test_agent_cannot_open_a_conversation_from_an_unassigned_channel(): void
    {
        $this->actingAsAssignedAgent();

        $this->getJson("/api/conversations/{$this->otherConversation->id}")->assertNotFound();
    }

    public function test_supervisor_can_open_a_conversation_from_any_channel(): void
    {
        Sanctum::actingAs(User::factory()->for($this->company)->supervisor()->create(), ['*']);

        $this->getJson("/api/conversations/{$this->otherConversation->id}")->assertOk();
    }

    // ── Mutating endpoints ───────────────────────────────────────────────────

    public function test_agent_cannot_resolve_a_conversation_from_an_unassigned_channel(): void
    {
        $this->actingAsAssignedAgent();

        $this->postJson("/api/conversations/{$this->otherConversation->id}/resolve")->assertNotFound();

        $this->assertSame('open', Conversation::withoutGlobalScopes()->find($this->otherConversation->id)->status);
    }

    public function test_agent_cannot_reopen_a_conversation_from_an_unassigned_channel(): void
    {
        $this->actingAsAssignedAgent();

        $this->postJson("/api/conversations/{$this->otherConversation->id}/reopen")->assertNotFound();
    }

    public function test_agent_cannot_snooze_a_conversation_from_an_unassigned_channel(): void
    {
        $this->actingAsAssignedAgent();

        $this->postJson("/api/conversations/{$this->otherConversation->id}/snooze", [
            'until' => now()->addHour()->toIso8601String(),
        ])->assertNotFound();
    }

    public function test_agent_cannot_assign_a_conversation_from_an_unassigned_channel(): void
    {
        $agent = $this->actingAsAssignedAgent();

        $this->postJson("/api/conversations/{$this->otherConversation->id}/assign", [
            'agent_id' => $agent->id,
        ])->assertNotFound();
    }

    public function test_agent_cannot_read_messages_of_an_unassigned_conversation(): void
    {
        $this->actingAsAssignedAgent();

        // findOwned runs before anything touches MongoDB, so this 404s without
        // a Mongo server in the loop.
        $this->getJson("/api/conversations/{$this->otherConversation->id}/messages")->assertNotFound();
    }

    public function test_agent_cannot_send_a_message_to_an_unassigned_conversation(): void
    {
        $this->actingAsAssignedAgent();

        $this->postJson("/api/conversations/{$this->otherConversation->id}/messages", [
            'content_type' => 'text',
            'text'         => 'hello',
        ])->assertNotFound();
    }
}
