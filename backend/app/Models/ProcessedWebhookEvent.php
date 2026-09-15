<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Idempotency ledger for inbound webhooks: ProcessInboundMessage checks
 * event_id here before doing any work, and records it after.
 *
 * The table and the sibling FailedWebhookEvent model both existed; this class
 * did not, so every inbound message died on the very first line of the pipeline
 * with "Class App\Models\ProcessedWebhookEvent not found".
 */
class ProcessedWebhookEvent extends Model
{
    public $timestamps = false;

    protected $fillable = [
        'event_id',
        'company_id',
        'channel_type',
        'processed_at',
    ];

    protected $casts = [
        'processed_at' => 'datetime',
    ];
}
