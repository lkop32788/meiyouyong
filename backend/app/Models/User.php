<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\SoftDeletes;
use Illuminate\Foundation\Auth\User as Authenticatable;
use Illuminate\Notifications\Notifiable;
use Laravel\Sanctum\HasApiTokens;

class User extends Authenticatable
{
    use HasApiTokens, HasFactory, HasUuids, Notifiable, SoftDeletes;

    protected $fillable = [
        'company_id',
        'name',
        'email',
        'password',
        'role',
        'skill_tags',
        'max_concurrent_chats',
        'avatar_url',
        'locale',
        'timezone',
        'is_active',
        'last_seen_at',
    ];

    protected $hidden = [
        'password',
        'remember_token',
    ];

    protected $casts = [
        'skill_tags'   => 'array',
        'is_active'    => 'boolean',
        'last_seen_at' => 'datetime',
        'password'     => 'hashed',
    ];

    public function company(): BelongsTo
    {
        return $this->belongsTo(Company::class);
    }

    public function assignedConversations(): HasMany
    {
        return $this->hasMany(Conversation::class, 'assigned_agent_id');
    }

    public function auditLogs(): HasMany
    {
        return $this->hasMany(UserAuditLog::class, 'target_user_id');
    }

    public function isSuperAdmin(): bool { return $this->role === 'super_admin'; }
    public function isAdmin(): bool      { return $this->role === 'admin'; }
    public function isSupervisor(): bool { return $this->role === 'supervisor'; }
    public function isAgent(): bool      { return $this->role === 'agent'; }

    public function canOverrideAssignment(): bool
    {
        return in_array($this->role, ['super_admin', 'admin', 'supervisor']);
    }

    /**
     * Roles this user is allowed to grant when creating or editing a member.
     * super_admin is never grantable through the API — it is reserved for
     * direct DB bootstrap (see AdminUserSeeder).
     */
    public function assignableRoles(): array
    {
        return match ($this->role) {
            'super_admin', 'admin' => ['admin', 'supervisor', 'agent'],
            'supervisor'           => ['agent'],
            default                => [],
        };
    }

    /**
     * Whether this user may edit / deactivate / restore $target.
     *
     * Supervisors are deliberately limited to agents: they may create agents
     * (see AgentController::store), so letting them edit higher roles would
     * hand them a password-reset path into an admin account.
     *
     * Nullable because callers resolve the target through a relation that can
     * come back null (e.g. AgentChannel::agent for a soft-deleted member).
     */
    public function canManageMember(?self $target): bool
    {
        if ($target === null || $this->company_id !== $target->company_id) {
            return false;
        }

        return match ($this->role) {
            'super_admin' => true,
            'admin'       => $target->role !== 'super_admin',
            'supervisor'  => $target->role === 'agent',
            default       => false,
        };
    }
}
