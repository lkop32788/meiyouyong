<?php

namespace App\Models;

use App\Models\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\SoftDeletes;

class Conversation extends Model
{
    use BelongsToTenant, HasFactory, HasUuids, SoftDeletes;

    protected $fillable = [
        'company_id',
        'channel_id',
        'contact_id',
        'assigned_agent_id',
        'assigned_team_id',
        'status',
        'priority',
        'intent_tags',
        'subject',
        'last_message_preview',
        'last_message_direction',
        'last_message_at',
        'first_response_at',
        'resolved_at',
        'snoozed_until',
        'message_count',
        'unread_count',
        'custom_attributes',
    ];

    protected $casts = [
        'intent_tags'        => 'array',
        'custom_attributes'  => 'array',
        'last_message_at'    => 'datetime',
        'first_response_at'  => 'datetime',
        'resolved_at'        => 'datetime',
        'snoozed_until'      => 'datetime',
        'message_count'      => 'integer',
        'unread_count'       => 'integer',
    ];

    public function company(): BelongsTo
    {
        return $this->belongsTo(Company::class);
    }

    public function channel(): BelongsTo
    {
        return $this->belongsTo(Channel::class);
    }

    public function contact(): BelongsTo
    {
        return $this->belongsTo(Contact::class);
    }

    public function assignedAgent(): BelongsTo
    {
        return $this->belongsTo(User::class, 'assigned_agent_id');
    }

    public function assignments(): HasMany
    {
        return $this->hasMany(ConversationAssignment::class);
    }

    public function isPending(): bool   { return $this->status === 'pending'; }
    public function isOpen(): bool      { return $this->status === 'open'; }
    public function isSnoozed(): bool   { return $this->status === 'snoozed'; }
    public function isResolved(): bool  { return $this->status === 'resolved'; }

    public function scopeForCompany(Builder $query, string $companyId): Builder
    {
        return $query->where('company_id', $companyId);
    }

    public function scopeActive(Builder $query): Builder
    {
        return $query->whereIn('status', ['pending', 'open']);
    }

    /**
     * Restrict to the channels an agent has been assigned.
     *
     * Agents only handle the numbers a supervisor gave them; supervisors and
     * admins are never channel-filtered and see the whole company inbox.
     * Fail-closed: an agent with no assignments sees nothing.
     *
     * Apply this to EVERY conversation lookup, not just listings — otherwise a
     * conversation from an unassigned channel is reachable by its UUID.
     */
    public function scopeVisibleToAgent(Builder $query, User $user): Builder
    {
        if ($user->role !== 'agent') {
            return $query;
        }

        $allowedChannelIds = AgentChannel::where('agent_id', $user->id)->pluck('channel_id');

        return $allowedChannelIds->isEmpty()
            ? $query->whereRaw('1 = 0')
            : $query->whereIn('channel_id', $allowedChannelIds);
    }
}
