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
 * PUT /conversations/{id}/read did not exist, yet AgentChatPage has been calling
 * it and swallowing the 404 with .catch(() => {}) — so unread badges never
 * cleared for a message arriving in an already-open conversation.
 *
 * POST /conversations/{id}/assign did exist but had no UI and no coverage; the
 * transfer modal now depends on it.
 */
class ConversationReadAndAssignTest extends TestCase
{
    use RefreshDatabase;

    private Company $company;
    private Channel $channel;

    protected function setUp(): void
    {
        parent::setUp();
        $this->company = Company::factory()->create();
        $this->channel = Channel::factory()->for($this->company)->create();
    }

    // ── read ─────────────────────────────────────────────────────────────────

    public function test_marking_read_clears_the_unread_counter(): void
    {
        $this->actingAsRole('admin', $this->company);
        $conv = $this->conversation(['unread_count' => 7]);

        $this->putJson("/api/conversations/{$conv->id}/read")
            ->assertOk()
            ->assertJsonPath('unread_count', 0);

        $this->assertSame(0, $conv->fresh()->unread_count);
    }

    public function test_marking_read_twice_is_harmless(): void
    {
        $this->actingAsRole('admin', $this->company);
        $conv = $this->conversation(['unread_count' => 3]);

        $this->putJson("/api/conversations/{$conv->id}/read")->assertOk();
        $this->putJson("/api/conversations/{$conv->id}/read")->assertOk();

        $this->assertSame(0, $conv->fresh()->unread_count);
    }

    public function test_an_agent_cannot_mark_read_a_conversation_on_an_unassigned_channel(): void
    {
        $conv = $this->conversation(['unread_count' => 5]);
        $this->actingAsAgentWithoutChannels();

        $this->putJson("/api/conversations/{$conv->id}/read")->assertNotFound();

        $this->assertSame(5, $conv->fresh()->unread_count);
    }

    public function test_marking_read_is_scoped_to_the_callers_company(): void
    {
        $outsiderConv = $this->conversation(['unread_count' => 4]);
        $this->actingAsRole('admin'); // different company

        $this->putJson("/api/conversations/{$outsiderConv->id}/read")->assertNotFound();

        $this->assertSame(4, $outsiderConv->fresh()->unread_count);
    }

    // ── assign ───────────────────────────────────────────────────────────────

    public function test_assigning_sets_the_agent_and_records_the_handover(): void
    {
        [$actor] = $this->actingAsRole('supervisor', $this->company);
        $target  = User::factory()->for($this->company)->agent()->create();
        $conv    = $this->conversation(['status' => 'pending', 'assigned_agent_id' => null]);

        $this->postJson("/api/conversations/{$conv->id}/assign", ['agent_id' => $target->id])
            ->assertOk()
            ->assertJsonPath('assigned_agent_id', $target->id);

        $fresh = $conv->fresh();
        $this->assertSame($target->id, $fresh->assigned_agent_id);

        // pending → open: somebody now owns it.
        $this->assertSame('open', $fresh->status);

        $this->assertDatabaseHas('conversation_assignments', [
            'conversation_id' => $conv->id,
            'assigned_to'     => $target->id,
            'assigned_by'     => $actor->id,
            'reason'          => 'manual',
        ]);
    }

    public function test_reassigning_an_open_conversation_keeps_it_open(): void
    {
        $this->actingAsRole('supervisor', $this->company);
        $first  = User::factory()->for($this->company)->agent()->create();
        $second = User::factory()->for($this->company)->agent()->create();
        $conv   = $this->conversation(['status' => 'open', 'assigned_agent_id' => $first->id]);

        $this->postJson("/api/conversations/{$conv->id}/assign", ['agent_id' => $second->id])->assertOk();

        $fresh = $conv->fresh();
        $this->assertSame($second->id, $fresh->assigned_agent_id);
        $this->assertSame('open', $fresh->status);
    }

    public function test_an_agent_cannot_assign_a_conversation_on_an_unassigned_channel(): void
    {
        $conv   = $this->conversation();
        $target = User::factory()->for($this->company)->agent()->create();
        $this->actingAsAgentWithoutChannels();

        $this->postJson("/api/conversations/{$conv->id}/assign", ['agent_id' => $target->id])
            ->assertNotFound();

        $this->assertNull($conv->fresh()->assigned_agent_id);
    }

    public function test_an_agent_can_hand_off_a_conversation_on_their_own_channel(): void
    {
        $conv  = $this->conversation();
        $agent = User::factory()->for($this->company)->agent()->create();
        AgentChannel::create([
            'agent_id'   => $agent->id,
            'channel_id' => $this->channel->id,
            'company_id' => $this->company->id,
        ]);
        Sanctum::actingAs($agent, ['*']);

        $colleague = User::factory()->for($this->company)->agent()->create();

        $this->postJson("/api/conversations/{$conv->id}/assign", ['agent_id' => $colleague->id])
            ->assertOk();

        $this->assertSame($colleague->id, $conv->fresh()->assigned_agent_id);
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private function conversation(array $attributes = []): Conversation
    {
        return Conversation::factory()->onChannel($this->channel)->create($attributes);
    }

    /** An agent of the same company with no channel assignments at all. */
    private function actingAsAgentWithoutChannels(): User
    {
        $agent = User::factory()->for($this->company)->agent()->create();
        Sanctum::actingAs($agent, ['*']);

        return $agent;
    }
}
