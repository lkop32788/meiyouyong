<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('message_templates', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->uuid('company_id');
            $table->uuid('channel_id')->nullable();
            $table->string('name', 100);
            $table->string('channel_type', 30);
            $table->string('category', 50)->nullable();
            $table->string('language', 10)->default('id');
            $table->string('status', 20)->default('pending');
            $table->string('wa_template_name', 100)->nullable();
            $table->string('wa_template_id', 100)->nullable();
            $table->longText('components'); // JSON: header, body, footer, buttons
            $table->text('variables_schema')->nullable(); // JSON
            $table->longText('preview_text')->nullable();
            $table->string('rejection_reason', 500)->nullable();
            $table->timestamps();

            $table->foreign('company_id')->references('id')->on('companies');
            $table->index(['company_id', 'channel_type', 'status']);
        });

        Schema::create('broadcast_campaigns', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->uuid('company_id');
            $table->uuid('channel_id');
            $table->string('name', 150);
            $table->string('status', 20)->default('draft');
            $table->uuid('template_id')->nullable();
            $table->longText('message_content')->nullable(); // JSON
            $table->string('audience_type', 20); // all | tag | segment | upload
            $table->text('audience_config')->nullable(); // JSON
            $table->uuid('audience_snapshot_id')->nullable();
            $table->dateTime('scheduled_at')->nullable();
            $table->dateTime('started_at')->nullable();
            $table->dateTime('completed_at')->nullable();
            $table->dateTime('paused_at')->nullable();
            $table->integer('total_recipients')->default(0);
            $table->integer('sent_count')->default(0);
            $table->integer('delivered_count')->default(0);
            $table->integer('read_count')->default(0);
            $table->integer('failed_count')->default(0);
            $table->integer('opted_out_count')->default(0);
            $table->integer('rate_limit_per_minute')->default(60);
            $table->uuid('created_by')->nullable();
            $table->timestamps();

            $table->foreign('company_id')->references('id')->on('companies');
            $table->foreign('channel_id')->references('id')->on('channels');
            $table->index(['company_id', 'status']);
        });

        Schema::create('audience_snapshots', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->uuid('campaign_id');
            $table->uuid('company_id');
            $table->integer('total_count');
            $table->timestamp('created_at')->default(DB::raw('CURRENT_TIMESTAMP'));

            $table->foreign('campaign_id')->references('id')->on('broadcast_campaigns');
        });

        Schema::create('audience_snapshot_recipients', function (Blueprint $table) {
            $table->bigIncrements('id');
            $table->uuid('snapshot_id');
            $table->uuid('contact_id');
            $table->string('channel_identity', 200);
            $table->text('variables')->nullable(); // JSON
            $table->string('status', 20)->default('pending');
            $table->string('error_code', 50)->nullable();
            $table->dateTime('processed_at')->nullable();

            $table->foreign('snapshot_id')->references('id')->on('audience_snapshots');
            $table->index(['snapshot_id', 'status']);
            $table->index(['snapshot_id', 'status', 'id']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('audience_snapshot_recipients');
        Schema::dropIfExists('audience_snapshots');
        Schema::dropIfExists('broadcast_campaigns');
        Schema::dropIfExists('message_templates');
    }
};
