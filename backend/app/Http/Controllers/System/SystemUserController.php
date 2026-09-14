<?php

namespace App\Http\Controllers\System;

use App\Http\Controllers\Controller;
use App\Models\Company;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Hash;

class SystemUserController extends Controller
{
    /** Global user list across all companies. */
    public function index(Request $request): JsonResponse
    {
        $query = User::withoutGlobalScope(\App\Models\Scopes\TenantScope::class)
            ->with('company')
            ->orderByDesc('created_at');

        if ($request->query('company_id')) {
            $query->where('company_id', $request->query('company_id'));
        }

        if ($request->query('role')) {
            $query->where('role', $request->query('role'));
        }

        if ($request->query('search')) {
            $q = $request->query('search');
            $query->where(function ($sub) use ($q) {
                $sub->where('name', 'like', "%{$q}%")
                    ->orWhere('email', 'like', "%{$q}%");
            });
        }

        $users = $query->paginate(20);

        // Append company name
        $users->getCollection()->transform(fn ($u) => [
            'id'                 => $u->id,
            'company_id'         => $u->company_id,
            'company_name'       => $u->company?->name,
            'name'               => $u->name,
            'email'              => $u->email,
            'role'               => $u->role,
            'is_active'          => $u->is_active,
            'max_concurrent_chats' => $u->max_concurrent_chats,
            'created_at'         => $u->created_at?->toIso8601String(),
        ]);

        return response()->json($users);
    }

    /** Single user. */
    public function show(string $id): JsonResponse
    {
        $user = User::withoutGlobalScope(\App\Models\Scopes\TenantScope::class)
            ->with('company')
            ->findOrFail($id);

        return response()->json([
            'id'                   => $user->id,
            'company_id'           => $user->company_id,
            'company_name'         => $user->company?->name,
            'name'                 => $user->name,
            'email'                => $user->email,
            'role'                 => $user->role,
            'is_active'            => $user->is_active,
            'max_concurrent_chats' => $user->max_concurrent_chats,
            'created_at'           => $user->created_at?->toIso8601String(),
        ]);
    }

    /** Create a user in any company. */
    public function store(Request $request): JsonResponse
    {
        $data = $request->validate([
            'company_id'          => 'required|uuid|exists:companies,id',
            'name'                => 'required|string|max:120',
            'email'               => 'required|email|unique:users,email',
            'password'            => 'required|string|min:8',
            'role'                => 'required|in:admin,supervisor,agent',
            'max_concurrent_chats' => 'nullable|integer|min:1|max:50',
        ]);

        $user = User::create([
            'company_id'          => $data['company_id'],
            'name'                => $data['name'],
            'email'               => $data['email'],
            'password'            => Hash::make($data['password']),
            'role'                => $data['role'],
            'max_concurrent_chats' => $data['max_concurrent_chats'] ?? 5,
            'is_active'           => true,
        ]);

        return response()->json([
            'id'       => $user->id,
            'company_id' => $user->company_id,
            'name'     => $user->name,
            'email'    => $user->email,
            'role'     => $user->role,
        ], 201);
    }

    /** Update a user. */
    public function update(Request $request, string $id): JsonResponse
    {
        $user = User::withoutGlobalScope(\App\Models\Scopes\TenantScope::class)->findOrFail($id);

        $data = $request->validate([
            'name'                => 'sometimes|string|max:120',
            'email'               => 'sometimes|email|unique:users,email,' . $id,
            'password'            => 'nullable|string|min:8',
            'role'                => 'sometimes|in:admin,supervisor,agent,super_admin',
            'is_active'           => 'nullable|boolean',
            'max_concurrent_chats' => 'nullable|integer|min:1|max:50',
        ]);

        // Prevent demoting the last super_admin
        if (isset($data['role']) && $data['role'] !== 'super_admin') {
            $superCount = User::withoutGlobalScope(\App\Models\Scopes\TenantScope::class)
                ->where('role', 'super_admin')->where('is_active', true)->count();
            if ($superCount <= 1 && $user->role === 'super_admin') {
                return response()->json(['message' => 'Cannot demote the last super_admin'], 422);
            }
        }

        if (isset($data['password']) && $data['password'] !== '') {
            $data['password'] = Hash::make($data['password']);
        } else {
            unset($data['password']);
        }

        $user->update($data);

        return response()->json([
            'id'       => $user->id,
            'name'     => $user->name,
            'email'    => $user->email,
            'role'     => $user->role,
            'is_active' => $user->is_active,
        ]);
    }

    /** Soft-delete a user. */
    public function destroy(string $id): JsonResponse
    {
        $user = User::withoutGlobalScope(\App\Models\Scopes\TenantScope::class)->findOrFail($id);

        if ($user->role === 'super_admin') {
            return response()->json(['message' => 'Cannot delete a super_admin'], 422);
        }

        $user->delete();

        return response()->json(['message' => 'deleted']);
    }
}
