<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Company;
use App\Models\User;
use App\Models\UserAuditLog;
use Carbon\CarbonImmutable;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Redis;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;
use Throwable;

class AgentController extends Controller
{
    /**
     * GET /api/agents
     *
     * Query params:
     *   status : online | offline | all (default: all)
     *
     * Gabungkan data SQL (profil agen) + Redis (presence state).
     */
    public function index(Request $request): JsonResponse
    {
        $companyId     = $request->user()->company_id;
        $statusFilter  = $request->input('status', 'all');
        $includeInactive = $request->boolean('include_inactive')
            && $request->user()->canOverrideAssignment();

        $query = User::where('company_id', $companyId)
            ->whereIn('role', ['agent', 'supervisor', 'admin', 'super_admin'])
            ->withTrashed();

        // Deactivated members: only visible to admins who opt in, and never
        // counted by the soft-delete guard (deleted_at IS NOT NULL).
        if (! $includeInactive) {
            $query->whereNull('deleted_at');
        }

        $agents = $query->get(['id', 'name', 'email', 'role', 'avatar_url', 'skill_tags', 'max_concurrent_chats', 'is_active', 'deleted_at']);

        // Ambil presence dari Redis untuk semua agen
        $result = $agents->map(function (User $agent) use ($companyId) {
            $presence = $this->presenceFor($companyId, $agent->id);

            return [
                'id'                  => $agent->id,
                'name'                => $agent->name,
                'email'               => $agent->email,
                'role'                => $agent->role,
                'avatar_url'          => $agent->avatar_url,
                'skill_tags'          => $agent->skill_tags ?? [],
                'max_concurrent_chats' => $agent->max_concurrent_chats ?? 5,
                'is_active'           => $agent->is_active && $agent->deleted_at === null,
                'status'              => $presence['status'],
                'last_seen'           => $presence['last_seen'],
            ];
        });

        // Filter berdasarkan status jika diminta
        if ($statusFilter !== 'all') {
            $result = $result->filter(fn ($a) => $a['status'] === $statusFilter)->values();
        }

        return response()->json(['data' => $result]);
    }

    /**
     * POST /api/agents
     * Create a team member. The set of grantable roles comes from the actor's
     * own role (User::assignableRoles), so super_admin can never be created
     * through the API regardless of who is asking.
     */
    public function store(Request $request): JsonResponse
    {
        $actor   = $request->user();
        $company = $actor->company;

        $assignable = $actor->assignableRoles();

        if (empty($assignable)) {
            return response()->json(['message' => 'Forbidden. Only admins can manage team members.'], 403);
        }

        $this->assertSeatAvailable($company);

        // A soft-deleted member still occupies the email (the unique rule below
        // sees trashed rows), and is hidden from the list by default — so tell
        // the caller to restore instead of leaving them with "email taken".
        $this->assertEmailNotHeldByDeactivatedMember($request->input('email'), $company->id);

        $data = $request->validate([
            'name'                 => 'required|string|max:100',
            'email'                => ['required', 'email', 'max:150', Rule::unique('users')->where('company_id', $company->id)],
            'password'             => 'required|string|min:8',
            'role'                 => ['sometimes', Rule::in($assignable)],
            'skill_tags'           => 'nullable|array',
            'skill_tags.*'         => 'string|max:50',
            'max_concurrent_chats' => 'sometimes|integer|min:1|max:50',
        ]);

        $member = User::create([
            'company_id'           => $company->id,
            'name'                 => $data['name'],
            'email'                => $data['email'],
            'password'             => $data['password'], // hashed via 'password' => 'hashed' cast
            'role'                 => $data['role'] ?? 'agent',
            'skill_tags'           => $data['skill_tags'] ?? null,
            'max_concurrent_chats' => $data['max_concurrent_chats'] ?? 5,
            'is_active'            => true,
        ]);

        $this->audit($request, $actor, $member, 'created', null, $this->auditSnapshot($member));

        return response()->json($this->present($member, $company->id), 201);
    }

    /**
     * PUT /api/agents/{id}
     * Edit name / role / skill tags / concurrency limit / password reset.
     */
    public function update(Request $request, string $id): JsonResponse
    {
        $actor = $request->user();

        if (! $actor->canOverrideAssignment()) {
            return response()->json(['message' => 'Forbidden. Only admins can manage team members.'], 403);
        }

        $member = User::where('company_id', $actor->company_id)->findOrFail($id);

        if (! $actor->canManageMember($member)) {
            return response()->json(['message' => 'Forbidden. You cannot manage this member.'], 403);
        }

        // The member's current role is always accepted: the edit form resubmits
        // it unchanged, and re-sending it must not be treated as a role change.
        $allowedRoles = array_values(array_unique([...$actor->assignableRoles(), $member->role]));

        $data = $request->validate([
            'name'                 => 'sometimes|string|max:100',
            'role'                 => ['sometimes', Rule::in($allowedRoles)],
            'password'             => 'sometimes|nullable|string|min:8',
            'skill_tags'           => 'sometimes|nullable|array',
            'skill_tags.*'         => 'string|max:50',
            'max_concurrent_chats' => 'sometimes|integer|min:1|max:50',
        ]);

        // An empty password field means "leave it alone", not "set it to empty".
        if (empty($data['password'])) {
            unset($data['password']);
        }

        // Only an actual change counts: the edit form always submits the current
        // role, so comparing against $member->role keeps idempotent PUTs working.
        if (isset($data['role']) && $data['role'] !== $member->role) {
            // Changing your own role is always someone else's job — this is what
            // stops a supervisor from promoting themselves.
            if ($member->id === $actor->id) {
                throw ValidationException::withMessages([
                    'role' => ['不能修改自己的角色。请让其他管理员操作。'],
                ]);
            }

            if (! in_array($data['role'], ['admin', 'super_admin'], true)) {
                $this->assertNotLastAdmin($member, '不能降级本公司最后一位管理员。请先指定另一位管理员。');
            }
        }

        $before = $this->auditSnapshot($member);
        $passwordChanged = isset($data['password']);

        $member->update($data);

        $after = $this->auditSnapshot($member);

        // auditSnapshot deliberately never carries the hash, but a password reset
        // has to leave a trace — otherwise a takeover is invisible in the log.
        if ($passwordChanged) {
            $after['password_changed'] = true;
        }

        $this->audit($request, $actor, $member, 'updated', $before, $after);

        return response()->json($this->present($member, $actor->company_id));
    }

    /**
     * DELETE /api/agents/{id}
     * Deactivate (soft) rather than destroy: keeps assignment history intact.
     * Also revokes all API tokens so the member loses access immediately.
     */
    public function destroy(Request $request, string $id): JsonResponse
    {
        $actor = $request->user();

        if (! $actor->canOverrideAssignment()) {
            return response()->json(['message' => 'Forbidden. Only admins can manage team members.'], 403);
        }

        $member = User::where('company_id', $actor->company_id)->findOrFail($id);

        if (! $actor->canManageMember($member)) {
            return response()->json(['message' => 'Forbidden. You cannot manage this member.'], 403);
        }

        if ($member->id === $actor->id) {
            throw ValidationException::withMessages([
                'id' => ['不能停用自己的账号。请让其他管理员操作。'],
            ]);
        }

        $this->assertNotLastAdmin($member, '不能停用本公司最后一位管理员。请先指定另一位管理员。');

        $before = $this->auditSnapshot($member);

        $member->update(['is_active' => false]);
        $member->delete();            // soft delete — assignment history intact
        $member->tokens()->delete();  // revoke API access immediately

        $this->audit($request, $actor, $member, 'deactivated', $before, $this->auditSnapshot($member));

        return response()->json(['message' => 'deactivated', 'id' => $member->id]);
    }

    /**
     * POST /api/agents/{id}/restore
     * Reverse of destroy(). Both is_active and deleted_at have to be cleared —
     * login checks is_active and the soft-delete scope independently.
     *
     * agent_channels rows survive the soft delete, so channel assignments come
     * back with the member.
     */
    public function restore(Request $request, string $id): JsonResponse
    {
        $actor = $request->user();

        if (! $actor->canOverrideAssignment()) {
            return response()->json(['message' => 'Forbidden. Only admins can manage team members.'], 403);
        }

        $member = User::withTrashed()
            ->where('company_id', $actor->company_id)
            ->findOrFail($id);

        if (! $actor->canManageMember($member)) {
            return response()->json(['message' => 'Forbidden. You cannot manage this member.'], 403);
        }

        if (! $member->trashed()) {
            throw ValidationException::withMessages([
                'id' => ['该成员未处于停用状态。'],
            ]);
        }

        // Deactivated members do not count against max_agents, so restoring one
        // has to re-check the plan limit — otherwise deactivate/hire/restore
        // walks straight past it.
        $this->assertSeatAvailable($actor->company);

        $before = $this->auditSnapshot($member);

        $member->restore();
        $member->update(['is_active' => true]);

        $this->audit($request, $actor, $member, 'restored', $before, $this->auditSnapshot($member));

        return response()->json($this->present($member, $actor->company_id));
    }

    // ── Private ───────────────────────────────────────────────────────────────

    /**
     * Presence hash written by two different services with different field
     * names: the realtime server writes last_heartbeat (epoch ms), Laravel's
     * own /internal/agent/heartbeat writes last_seen (ISO-8601). Read both.
     */
    private function presenceFor(string $companyId, string $userId): array
    {
        $presence = Redis::hGetAll("agent:presence:{$companyId}:{$userId}");

        $lastSeen = $presence['last_seen'] ?? null;

        if (! $lastSeen && ! empty($presence['last_heartbeat'])) {
            $lastSeen = CarbonImmutable::createFromTimestampMs((int) $presence['last_heartbeat'])->toISOString();
        }

        return [
            'status'    => $presence['status'] ?? 'offline',
            'last_seen' => $lastSeen,
        ];
    }

    private function assertSeatAvailable(Company $company): void
    {
        // Soft-deleted members are excluded by the global scope, so deactivated
        // seats are free seats.
        $existing = User::where('company_id', $company->id)->count();

        if ($existing >= $company->max_agents) {
            throw ValidationException::withMessages([
                'seats' => ["已达到套餐客服人数上限（最多 {$company->max_agents} 人）。请升级套餐。"],
            ]);
        }
    }

    private function assertEmailNotHeldByDeactivatedMember(mixed $email, string $companyId): void
    {
        if (! is_string($email) || $email === '') {
            return;
        }

        $deactivated = User::onlyTrashed()
            ->where('company_id', $companyId)
            ->where('email', $email)
            ->first();

        if ($deactivated) {
            throw ValidationException::withMessages([
                'email' => ["该邮箱属于已停用成员「{$deactivated->name}」，请改为恢复该账号。"],
            ]);
        }
    }

    /**
     * Guard against a company losing its last admin — otherwise nobody inside
     * the tenant can manage members any more and it takes a /system call to
     * recover. Mirrors SystemUserController's last-super_admin check, scoped to
     * one company.
     *
     * Defence in depth: single-threaded this cannot currently fire, because the
     * actor is always an active admin who is barred from acting on themselves.
     * It does not close the concurrent case (two admins demoting each other at
     * once) — that needs a row lock, which SQLite compiles away, so it would be
     * untestable here.
     */
    private function assertNotLastAdmin(User $member, string $message): void
    {
        if (! in_array($member->role, ['admin', 'super_admin'], true)) {
            return;
        }

        $othersRemain = User::where('company_id', $member->company_id)
            ->whereIn('role', ['admin', 'super_admin'])
            ->where('is_active', true)
            ->where('id', '!=', $member->id)
            ->exists();

        if (! $othersRemain) {
            throw ValidationException::withMessages(['role' => [$message]]);
        }
    }

    private function present(User $u, string $companyId): array
    {
        $presence = $this->presenceFor($companyId, $u->id);

        return [
            'id'                   => $u->id,
            'name'                 => $u->name,
            'email'                => $u->email,
            'role'                 => $u->role,
            'avatar_url'           => $u->avatar_url,
            'skill_tags'           => $u->skill_tags ?? [],
            'max_concurrent_chats' => $u->max_concurrent_chats ?? 5,
            'is_active'            => $u->is_active && $u->deleted_at === null,
            'status'               => $presence['status'],
            'last_seen'            => $presence['last_seen'],
            'created_at'           => $u->created_at?->toISOString(),
        ];
    }

    private function auditSnapshot(User $u): array
    {
        return [
            'name'                 => $u->name,
            'email'                => $u->email,
            'role'                 => $u->role,
            'skill_tags'           => $u->skill_tags,
            'max_concurrent_chats' => $u->max_concurrent_chats,
            'is_active'            => $u->is_active,
        ];
    }

    private function audit(Request $request, User $actor, User $target, string $action, ?array $before, ?array $after): void
    {
        try {
            UserAuditLog::create([
                'company_id'     => $actor->company_id,
                'actor_id'       => $actor->id,
                'target_user_id' => $target->id,
                'action'         => $action,
                'before'         => $before,
                'after'          => $after,
                'ip_address'     => $request->ip(),
                'created_at'     => now(),
            ]);
        } catch (Throwable) {
            // Audit logging must never break member management itself.
        }
    }
}
