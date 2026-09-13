<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\User;
use App\Models\UserAuditLog;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Hash;
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
            $presenceKey = "agent:presence:{$companyId}:{$agent->id}";
            $presence    = Redis::hGetAll($presenceKey);

            return [
                'id'                  => $agent->id,
                'name'                => $agent->name,
                'email'               => $agent->email,
                'role'                => $agent->role,
                'avatar_url'          => $agent->avatar_url,
                'skill_tags'          => $agent->skill_tags ?? [],
                'max_concurrent_chats' => $agent->max_concurrent_chats ?? 5,
                'is_active'           => $agent->is_active && $agent->deleted_at === null,
                'status'              => $presence['status'] ?? 'offline',
                'last_seen'           => $presence['last_seen'] ?? null,
            ];
        });

        // Filter berdasarkan status jika diminta
        if ($statusFilter !== 'all') {
            $result = $result->filter(fn($a) => $a['status'] === $statusFilter)->values();
        }

        return response()->json(['data' => $result]);
    }

    /**
     * POST /api/agents
     * Create a team member (agent/supervisor/admin). Never allows creating a
     * super_admin — that role is reserved for direct DB bootstrap.
     */
    public function store(Request $request): JsonResponse
    {
        $actor   = $request->user();
        $company = $actor->company;

        // Admins can create any role; supervisors can add agents only.
        if ($actor->isSuperAdmin() || $actor->isAdmin()) {
            // any role allowed below
        } elseif ($actor->isSupervisor()) {
            $requestedRole = $request->input('role', 'agent');
            if ($requestedRole !== 'agent') {
                return response()->json(['message' => 'Forbidden. Supervisors can only add agents.'], 403);
            }
        } else {
            return response()->json(['message' => 'Forbidden. Only admins can manage team members.'], 403);
        }

        // Plan limit: companies.max_agents
        $existing = User::where('company_id', $company->id)->count();
        if ($existing >= $company->max_agents) {
            return response()->json([
                'message' => "已达到套餐客服人数上限（最多 {$company->max_agents} 人）。请升级套餐。",
            ], 422);
        }

        $data = $request->validate([
            'name'                 => 'required|string|max:100',
            'email'                => ['required', 'email', 'max:150', Rule::unique('users')->where('company_id', $company->id)],
            'password'             => 'required|string|min:8',
            'role'                 => 'sometimes|in:super_admin,admin,supervisor,agent',
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
     * Role changes require admin+; nobody can demote themselves below admin.
     */
    public function update(Request $request, string $id): JsonResponse
    {
        $actor = $request->user();

        if (! $actor->canOverrideAssignment()) {
            return response()->json(['message' => 'Forbidden. Only admins can manage team members.'], 403);
        }

        $member = User::where('company_id', $actor->company_id)->findOrFail($id);

        $data = $request->validate([
            'name'                 => 'sometimes|string|max:100',
            'role'                 => 'sometimes|in:super_admin,admin,supervisor,agent',
            'password'             => 'sometimes|nullable|min:8',
            'skill_tags'           => 'sometimes|nullable|array',
            'skill_tags.*'         => 'string|max:50',
            'max_concurrent_chats' => 'sometimes|integer|min:1|max:50',
            'password'             => 'sometimes|string|min:8',
        ]);

        $before = $this->auditSnapshot($member);

        if (isset($data['role'])
            && $member->id === $actor->id
            && ! in_array($data['role'], ['admin', 'super_admin'], true)) {
            throw ValidationException::withMessages([
                'role' => ['不能将自己的角色降级。请让其他管理员操作。'],
            ]);
        }

        $member->update($data);

        $this->audit($request, $actor, $member, 'updated', $before, $this->auditSnapshot($member));

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

        if ($member->id === $actor->id) {
            throw ValidationException::withMessages([
                'id' => ['不能停用自己的账号。请让其他管理员操作。'],
            ]);
        }

        $before = $this->auditSnapshot($member);

        $member->update(['is_active' => false]);
        $member->delete();            // soft delete — assignment history intact
        $member->tokens()->delete();  // revoke API access immediately

        $this->audit($request, $actor, $member, 'deactivated', $before, $this->auditSnapshot($member));

        return response()->json(['message' => 'deactivated', 'id' => $member->id]);
    }

    // ── Private ───────────────────────────────────────────────────────────────

    private function present(User $u, string $companyId): array
    {
        $presence = Redis::hGetAll("agent:presence:{$companyId}:{$u->id}");

        return [
            'id'                   => $u->id,
            'name'                 => $u->name,
            'email'                => $u->email,
            'role'                 => $u->role,
            'avatar_url'           => $u->avatar_url,
            'skill_tags'           => $u->skill_tags ?? [],
            'max_concurrent_chats' => $u->max_concurrent_chats ?? 5,
            'is_active'            => $u->is_active,
            'status'               => $presence['status'] ?? 'offline',
            'last_seen'            => $presence['last_seen'] ?? null,
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
