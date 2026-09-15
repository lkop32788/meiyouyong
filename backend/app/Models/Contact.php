<?php

namespace App\Models;

use App\Models\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\SoftDeletes;

class Contact extends Model
{
    use BelongsToTenant, HasFactory, HasUuids, SoftDeletes;

    protected $fillable = [
        'company_id',
        'name',
        'name_is_manual',
        'email',
        'phone',
        'avatar_url',
        'locale',
        'timezone',
        'custom_attributes',
        'tags',
        'lifetime_conversation_count',
        'last_contacted_at',
    ];

    protected $casts = [
        'name_is_manual'              => 'boolean',
        'custom_attributes'           => 'array',
        'tags'                        => 'array',
        'last_contacted_at'           => 'datetime',
        'lifetime_conversation_count' => 'integer',
    ];

    public function company(): BelongsTo
    {
        return $this->belongsTo(Company::class);
    }

    public function channelIdentities(): HasMany
    {
        return $this->hasMany(ContactChannelIdentity::class);
    }

    public function conversations(): HasMany
    {
        return $this->hasMany(Conversation::class);
    }
}
