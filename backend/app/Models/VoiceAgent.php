<?php

namespace App\Models;

use App\Models\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\DB;

class VoiceAgent extends Model
{
    use HasUuids, BelongsToTenant;

    protected $fillable = [
        'company_id', 'channel_id', 'name', 'description', 'engine',
        'system_prompt', 'greeting',
        'voice', 'voice_id', 'language', 'voice_speed', 'voice_pitch',
        'realtime_api_key', 'groq_api_key', 'sarvam_api_key',
        'max_duration_seconds', 'transfer_number', 'summary_enabled',
        'is_active', 'is_default',
    ];

    protected $hidden = [
        'realtime_api_key', 'groq_api_key', 'sarvam_api_key',
    ];

    protected $casts = [
        'max_duration_seconds' => 'integer',
        'voice_speed'          => 'float',
        'voice_pitch'         => 'float',
        'summary_enabled'      => 'boolean',
        'is_active'           => 'boolean',
        'is_default'          => 'boolean',
    ];

    /** Appended JSON — never expose raw secrets. */
    protected $appends = [
        'has_realtime_key',
        'has_groq_key',
        'has_sarvam_key',
    ];

    public function getHasRealtimeKeyAttribute(): bool
    {
        return ! empty($this->realtime_api_key);
    }

    public function getHasGroqKeyAttribute(): bool
    {
        return ! empty($this->groq_api_key);
    }

    public function getHasSarvamKeyAttribute(): bool
    {
        return ! empty($this->sarvam_api_key);
    }

    /**
     * Computed statistics from call_sessions.
     * Returns an array: [total, completed, missed, failed, avg_duration, success_rate]
     */
    public function getStatsAttribute(): array
    {
        $rows = DB::table('call_sessions')
            ->where('voice_agent_id', $this->id)
            ->selectRaw("
                COUNT(*)                                                   AS total,
                SUM(status = 'completed')                                  AS completed,
                SUM(status = 'missed')                                    AS missed,
                SUM(status = 'failed')                                    AS failed,
                AVG(CASE WHEN status = 'completed' THEN duration_seconds END) AS avg_duration
            ")
            ->first();

        $total     = (int) ($rows->total ?? 0);
        $completed = (int) ($rows->completed ?? 0);
        $missed    = (int) ($rows->missed ?? 0);
        $failed    = (int) ($rows->failed ?? 0);

        return [
            'total_calls'    => $total,
            'completed'      => $completed,
            'missed'         => $missed,
            'failed'         => $failed,
            'avg_duration'   => $total > 0 ? round($rows->avg_duration ?? 0) : 0,
            'success_rate'   => $total > 0 ? round(($completed / $total) * 100, 1) : 0,
        ];
    }

    public function callSessions()
    {
        return $this->hasMany(CallSession::class);
    }

    public function channel()
    {
        return $this->belongsTo(Channel::class);
    }
}
