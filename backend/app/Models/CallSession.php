<?php

namespace App\Models;

use App\Models\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Model;

class CallSession extends Model
{
    use HasUuids, BelongsToTenant;

    protected $fillable = [
        'company_id', 'channel_id', 'voice_agent_id', 'call_id',
        'from_number', 'to_number', 'direction', 'status',
        'duration_seconds', 'transcript', 'summary', 'disposition',
        'recording_url', 'error', 'started_at', 'ended_at',
    ];

    protected $casts = [
        'transcript'       => 'array',
        'duration_seconds' => 'integer',
        'started_at'      => 'datetime',
        'ended_at'        => 'datetime',
    ];

    /** Human-readable call status. */
    public static function statusLabel(string $status): string
    {
        return match ($status) {
            'initiating'   => '发起中',
            'incoming'      => '来电',
            'ringing'       => '响铃中',
            'ai-connected'  => 'AI 通话中',
            'connecting'    => '连接中',
            'accepted'      => '已接通',
            'completed'     => '已完成',
            'missed'       => '未接',
            'failed'       => '失败',
            'rejected'     => '已拒接',
            'terminated'   => '已挂断',
            default         => $status,
        };
    }

    /** Direction label. */
    public static function directionLabel(string $direction): string
    {
        return $direction === 'business_initiated' ? '外呼' : '呼入';
    }

    /** Formatted duration string. */
    public function getDurationFormattedAttribute(): string
    {
        $s = $this->duration_seconds ?? 0;
        if ($s === 0) return '—';
        $m = floor($s / 60);
        $sec = $s % 60;
        return "{$m}分{$sec}秒";
    }

    public function voiceAgent()
    {
        return $this->belongsTo(VoiceAgent::class, 'voice_agent_id');
    }

    public function channel()
    {
        return $this->belongsTo(Channel::class);
    }
}
