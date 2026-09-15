<?php

namespace Tests\Feature;

use App\Models\Company;
use App\Models\User;
use Database\Factories\UserFactory;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class AgentManagementTest extends TestCase
{
    use RefreshDatabase;

    // ── index ────────────────────────────────────────────────────────────────

    public function test_index_only_returns_members_of_the_callers_company(): void
    {
        [$admin, $company] = $this->actingAsRole('admin');
        $mine    = User::factory()->for($company)->create();
        $theirs  = User::factory()->create(); // its own company

        $response = $this->getJson('/api/agents')->assertOk();

        $ids = collect($response->json('data'))->pluck('id');
        $this->assertTrue($ids->contains($admin->id));
        $this->assertTrue($ids->contains($mine->id));
        $this->assertFalse($ids->contains($theirs->id));
    }

    public function test_index_hides_deactivated_members_by_default(): void
    {
        [, $company] = $this->actingAsRole('admin');
        $gone = User::factory()->for($company)->deactivated()->create();

        $response = $this->getJson('/api/agents')->assertOk();

        $this->assertFalse(collect($response->json('data'))->pluck('id')->contains($gone->id));
    }

    public function test_admin_can_opt_into_seeing_deactivated_members(): void
    {
        [, $company] = $this->actingAsRole('admin');
        $gone = User::factory()->for($company)->deactivated()->create();

        $response = $this->getJson('/api/agents?include_inactive=1')->assertOk();

        $row = collect($response->json('data'))->firstWhere('id', $gone->id);
        $this->assertNotNull($row);
        $this->assertFalse($row['is_active']);
    }

    public function test_agent_cannot_opt_into_seeing_deactivated_members(): void
    {
        [, $company] = $this->actingAsRole('agent');
        $gone = User::factory()->for($company)->deactivated()->create();

        $response = $this->getJson('/api/agents?include_inactive=1')->assertOk();

        $this->assertFalse(collect($response->json('data'))->pluck('id')->contains($gone->id));
    }

    public function test_index_filters_by_presence_status(): void
    {
        $this->actingAsRole('admin');

        $this->fakePresence(['status' => 'online']);
        $this->assertNotEmpty($this->getJson('/api/agents?status=online')->assertOk()->json('data'));

        $this->fakePresence(['status' => 'online']);
        $this->assertEmpty($this->getJson('/api/agents?status=offline')->assertOk()->json('data'));
    }

    public function test_index_normalises_realtime_last_heartbeat_into_last_seen(): void
    {
        $this->actingAsRole('admin');

        // The realtime server writes last_heartbeat (epoch ms); only Laravel's
        // own heartbeat endpoint writes last_seen.
        $this->fakePresence(['status' => 'online', 'last_heartbeat' => '1700000000000']);

        $row = $this->getJson('/api/agents')->assertOk()->json('data.0');

        $this->assertNotNull($row['last_seen']);
        $this->assertStringStartsWith('2023-11-14T', $row['last_seen']);
    }

    // ── store ────────────────────────────────────────────────────────────────

    public function test_admin_can_create_a_member(): void
    {
        [, $company] = $this->actingAsRole('admin');

        $this->postJson('/api/agents', [
            'name'       => '张三',
            'email'      => 'zhangsan@example.com',
            'password'   => 'secret1234',
            'role'       => 'supervisor',
            'skill_tags' => ['vip', 'refund'],
        ])->assertCreated()
            ->assertJsonPath('role', 'supervisor')
            ->assertJsonPath('skill_tags', ['vip', 'refund']);

        $this->assertDatabaseHas('users', [
            'email'      => 'zhangsan@example.com',
            'company_id' => $company->id,
            'role'       => 'supervisor',
        ]);
    }

    public function test_supervisor_can_only_create_agents(): void
    {
        $this->actingAsRole('supervisor');

        $this->postJson('/api/agents', [
            'name' => 'A', 'email' => 'a@example.com', 'password' => 'secret1234', 'role' => 'admin',
        ])->assertStatus(422)->assertJsonValidationErrors('role');

        $this->postJson('/api/agents', [
            'name' => 'B', 'email' => 'b@example.com', 'password' => 'secret1234', 'role' => 'agent',
        ])->assertCreated();
    }

    public function test_admin_cannot_create_a_super_admin(): void
    {
        $this->actingAsRole('admin');

        $this->postJson('/api/agents', [
            'name' => 'Root', 'email' => 'root@example.com', 'password' => 'secret1234', 'role' => 'super_admin',
        ])->assertStatus(422)->assertJsonValidationErrors('role');
    }

    public function test_agent_cannot_create_members(): void
    {
        $this->actingAsRole('agent');

        $this->postJson('/api/agents', [
            'name' => 'X', 'email' => 'x@example.com', 'password' => 'secret1234',
        ])->assertForbidden();
    }

    public function test_store_enforces_the_plan_seat_limit(): void
    {
        $company = Company::factory()->seats(1)->create();
        $this->actingAsRole('admin', $company); // that is the one seat

        $this->postJson('/api/agents', [
            'name' => 'Y', 'email' => 'y@example.com', 'password' => 'secret1234',
        ])->assertStatus(422)->assertJsonValidationErrors('seats');
    }

    public function test_store_points_at_the_deactivated_member_holding_the_email(): void
    {
        [, $company] = $this->actingAsRole('admin');
        User::factory()->for($company)->deactivated()->create([
            'name' => '李四', 'email' => 'lisi@example.com',
        ]);

        $response = $this->postJson('/api/agents', [
            'name' => '李四', 'email' => 'lisi@example.com', 'password' => 'secret1234',
        ])->assertStatus(422)->assertJsonValidationErrors('email');

        $this->assertStringContainsString('李四', $response->json('errors.email.0'));
    }

    public function test_store_rejects_a_duplicate_email_within_the_company(): void
    {
        [, $company] = $this->actingAsRole('admin');
        User::factory()->for($company)->create(['email' => 'dup@example.com']);

        $this->postJson('/api/agents', [
            'name' => 'Dup', 'email' => 'dup@example.com', 'password' => 'secret1234',
        ])->assertStatus(422)->assertJsonValidationErrors('email');
    }

    public function test_the_same_email_may_exist_in_another_company(): void
    {
        User::factory()->create(['email' => 'shared@example.com']);
        $this->actingAsRole('admin');

        $this->postJson('/api/agents', [
            'name' => 'Shared', 'email' => 'shared@example.com', 'password' => 'secret1234',
        ])->assertCreated();
    }

    // ── update: privilege escalation ─────────────────────────────────────────

    public function test_supervisor_cannot_edit_an_admin(): void
    {
        [, $company] = $this->actingAsRole('supervisor');
        $admin = User::factory()->for($company)->admin()->create();

        $this->putJson("/api/agents/{$admin->id}", ['name' => 'hijacked'])->assertForbidden();

        $this->assertNotSame('hijacked', $admin->fresh()->name);
    }

    public function test_supervisor_cannot_reset_an_admins_password(): void
    {
        [, $company] = $this->actingAsRole('supervisor');
        $admin = User::factory()->for($company)->admin()->create();
        $before = $admin->password;

        $this->putJson("/api/agents/{$admin->id}", ['password' => 'takeover123'])->assertForbidden();

        $this->assertSame($before, $admin->fresh()->password);
    }

    public function test_supervisor_cannot_promote_themselves(): void
    {
        [$supervisor] = $this->actingAsRole('supervisor');

        $this->putJson("/api/agents/{$supervisor->id}", ['role' => 'admin'])->assertForbidden();

        $this->assertSame('supervisor', $supervisor->fresh()->role);
    }

    public function test_supervisor_cannot_promote_an_agent_above_agent(): void
    {
        [, $company] = $this->actingAsRole('supervisor');
        $agent = User::factory()->for($company)->agent()->create();

        $this->putJson("/api/agents/{$agent->id}", ['role' => 'supervisor'])
            ->assertStatus(422)->assertJsonValidationErrors('role');

        $this->assertSame('agent', $agent->fresh()->role);
    }

    public function test_supervisor_can_edit_an_agent(): void
    {
        [, $company] = $this->actingAsRole('supervisor');
        $agent = User::factory()->for($company)->agent()->create();

        $this->putJson("/api/agents/{$agent->id}", ['name' => '小王'])->assertOk();

        $this->assertSame('小王', $agent->fresh()->name);
    }

    public function test_nobody_can_change_their_own_role(): void
    {
        [$admin] = $this->actingAsRole('admin');

        $this->putJson("/api/agents/{$admin->id}", ['role' => 'supervisor'])
            ->assertStatus(422)->assertJsonValidationErrors('role');

        $this->assertSame('admin', $admin->fresh()->role);
    }

    public function test_submitting_your_own_unchanged_role_is_allowed(): void
    {
        [$admin] = $this->actingAsRole('admin');

        // The edit form always submits the current role.
        $this->putJson("/api/agents/{$admin->id}", ['name' => '我', 'role' => 'admin'])->assertOk();

        $this->assertSame('我', $admin->fresh()->name);
    }

    public function test_admin_can_reset_a_members_password_and_it_is_audited(): void
    {
        [$admin, $company] = $this->actingAsRole('admin');
        $agent = User::factory()->for($company)->agent()->create();
        $before = $agent->password;

        $this->putJson("/api/agents/{$agent->id}", ['password' => 'brandnew123'])->assertOk();

        $this->assertNotSame($before, $agent->fresh()->password);
        $this->assertDatabaseHas('user_audit_logs', [
            'actor_id'       => $admin->id,
            'target_user_id' => $agent->id,
            'action'         => 'updated',
        ]);
    }

    public function test_update_is_scoped_to_the_callers_company(): void
    {
        $this->actingAsRole('admin');
        $outsider = User::factory()->create();

        $this->putJson("/api/agents/{$outsider->id}", ['name' => 'nope'])->assertNotFound();
    }

    // ── destroy ──────────────────────────────────────────────────────────────

    public function test_destroy_deactivates_soft_deletes_and_revokes_tokens(): void
    {
        [, $company] = $this->actingAsRole('admin');
        $agent = User::factory()->for($company)->agent()->create();
        $agent->createToken('test');

        $this->deleteJson("/api/agents/{$agent->id}")->assertOk();

        $fresh = User::withTrashed()->find($agent->id);
        $this->assertFalse((bool) $fresh->is_active);
        $this->assertTrue($fresh->trashed());
        $this->assertSame(0, $fresh->tokens()->count());
    }

    public function test_cannot_deactivate_yourself(): void
    {
        [$admin] = $this->actingAsRole('admin');

        $this->deleteJson("/api/agents/{$admin->id}")->assertStatus(422);

        $this->assertFalse($admin->fresh()->trashed());
    }

    public function test_supervisor_cannot_deactivate_an_admin(): void
    {
        [, $company] = $this->actingAsRole('supervisor');
        $admin = User::factory()->for($company)->admin()->create();

        $this->deleteJson("/api/agents/{$admin->id}")->assertForbidden();

        $this->assertFalse($admin->fresh()->trashed());
    }

    // ── restore ──────────────────────────────────────────────────────────────

    public function test_admin_can_restore_a_deactivated_member(): void
    {
        [, $company] = $this->actingAsRole('admin');
        $gone = User::factory()->for($company)->deactivated()->create();

        $this->postJson("/api/agents/{$gone->id}/restore")
            ->assertOk()
            ->assertJsonPath('is_active', true);

        $fresh = User::withTrashed()->find($gone->id);
        $this->assertFalse($fresh->trashed());
        $this->assertTrue((bool) $fresh->is_active);
    }

    public function test_a_restored_member_can_log_in_again(): void
    {
        [, $company] = $this->actingAsRole('admin');
        $gone = User::factory()->for($company)->deactivated()->create([
            'email' => 'back@example.com',
        ]);

        $credentials = [
            'company_slug' => $company->slug,
            'email'        => 'back@example.com',
            'password'     => UserFactory::PASSWORD,
        ];

        $this->postJson('/api/auth/login', $credentials)->assertStatus(422);

        $this->postJson("/api/agents/{$gone->id}/restore")->assertOk();

        $this->postJson('/api/auth/login', $credentials)->assertOk();
    }

    public function test_restore_rejects_a_member_who_is_not_deactivated(): void
    {
        [, $company] = $this->actingAsRole('admin');
        $active = User::factory()->for($company)->create();

        $this->postJson("/api/agents/{$active->id}/restore")->assertStatus(422);
    }

    public function test_restore_re_checks_the_plan_seat_limit(): void
    {
        $company = Company::factory()->seats(2)->create();
        $this->actingAsRole('admin', $company);                 // seat 1
        User::factory()->for($company)->create();               // seat 2
        $gone = User::factory()->for($company)->deactivated()->create(); // frees no seat

        $this->postJson("/api/agents/{$gone->id}/restore")
            ->assertStatus(422)->assertJsonValidationErrors('seats');

        $this->assertTrue(User::withTrashed()->find($gone->id)->trashed());
    }

    public function test_supervisor_cannot_restore_an_admin(): void
    {
        [, $company] = $this->actingAsRole('supervisor');
        $gone = User::factory()->for($company)->admin()->deactivated()->create();

        $this->postJson("/api/agents/{$gone->id}/restore")->assertForbidden();

        $this->assertTrue(User::withTrashed()->find($gone->id)->trashed());
    }

    public function test_agent_cannot_restore_anyone(): void
    {
        [, $company] = $this->actingAsRole('agent');
        $gone = User::factory()->for($company)->deactivated()->create();

        $this->postJson("/api/agents/{$gone->id}/restore")->assertForbidden();
    }

    public function test_restore_is_scoped_to_the_callers_company(): void
    {
        $this->actingAsRole('admin');
        $outsider = User::factory()->deactivated()->create();

        $this->postJson("/api/agents/{$outsider->id}/restore")->assertNotFound();
    }
}
