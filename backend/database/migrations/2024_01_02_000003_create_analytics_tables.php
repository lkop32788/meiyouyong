<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('sla_configs', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->uuid('company_id');
            $table->uuid('channel_id')->nullable();
            $table->integer('first_response_seconds')->default(300);
            $table->integer('resolution_seconds')->default(86400);
            $table->boolean('business_hours_only')->default(true);
            $table->longText('business_hours_config')->nullable(); // JSON
            $table->boolean('is_active')->default(true);
            $table->timestamp('created_at')->default(DB::raw('CURRENT_TIMESTAMP'));

            $table->foreign('company_id')->references('id')->on('companies');
            $table->unique(['company_id', 'channel_id']);
        });

        Schema::create('analytics_conversation_facts', function (Blueprint $table) {
            $table->bigIncrements('id');
            $table->uuid('company_id');
            $table->uuid('conversation_id');
            $table->uuid('channel_id');
            $table->string('channel_type', 30);
            $table->uuid('contact_id');
            $table->uuid('assigned_agent_id')->nullable();
            $table->integer('first_response_seconds')->nullable();
            $table->integer('resolution_seconds')->nullable();
            $table->integer('handle_seconds')->nullable();
            $table->integer('total_messages')->default(0);
            $table->integer('inbound_messages')->default(0);
            $table->integer('outbound_messages')->default(0);
            $table->integer('bot_messages')->default(0);
            $table->boolean('was_bot_handled')->default(false);
            $table->boolean('had_bot_handoff')->default(false);
            $table->integer('reassignment_count')->default(0);
            $table->tinyInteger('csat_score')->nullable();
            $table->dateTime('csat_responded_at')->nullable();
            $table->date('resolved_date');
            $table->tinyInteger('resolved_hour');
            $table->integer('resolved_week')->nullable();
            $table->string('resolved_month', 7)->nullable();
            $table->boolean('met_first_response_sla')->nullable();
            $table->boolean('met_resolution_sla')->nullable();
            $table->timestamp('created_at')->default(DB::raw('CURRENT_TIMESTAMP'));

            $table->unique(['company_id', 'conversation_id']);
            $table->index(['company_id', 'resolved_date']);
            // explicit names: auto-generated ones exceed MySQL's 64-char identifier limit
            $table->index(['company_id', 'assigned_agent_id', 'resolved_date'], 'acf_company_agent_date_index');
            $table->index(['company_id', 'channel_id', 'resolved_date'], 'acf_company_channel_date_index');
        });

        Schema::create('analytics_hourly_volume', function (Blueprint $table) {
            $table->bigIncrements('id');
            $table->uuid('company_id');
            $table->uuid('channel_id');
            $table->string('channel_type', 30);
            $table->dateTime('hour_bucket');
            $table->integer('inbound_count')->default(0);
            $table->integer('outbound_count')->default(0);
            $table->integer('new_conv_count')->default(0);
            $table->integer('resolved_count')->default(0);

            $table->unique(['company_id', 'channel_id', 'hour_bucket']);
            $table->index(['company_id', 'hour_bucket']);
        });

        Schema::create('analytics_agent_daily', function (Blueprint $table) {
            $table->bigIncrements('id');
            $table->uuid('company_id');
            $table->uuid('agent_id');
            $table->date('date_bucket');
            $table->integer('conversations_handled')->default(0);
            $table->integer('conversations_resolved')->default(0);
            $table->integer('messages_sent')->default(0);
            $table->integer('avg_first_response_seconds')->nullable();
            $table->integer('avg_resolution_seconds')->nullable();
            $table->decimal('avg_csat_score', 3, 2)->nullable();
            $table->integer('online_seconds')->default(0);

            $table->unique(['company_id', 'agent_id', 'date_bucket']);
            $table->index(['company_id', 'date_bucket']);
        });

        Schema::create('agent_presence_log', function (Blueprint $table) {
            $table->bigIncrements('id');
            $table->uuid('company_id');
            $table->uuid('agent_id');
            $table->string('event', 10); // online | offline | busy | away
            $table->dateTime('logged_at')->default(DB::raw('CURRENT_TIMESTAMP'));

            $table->index(['company_id', 'agent_id', 'logged_at']);
        });

        Schema::create('csat_surveys', function (Blueprint $table) {
            $table->bigIncrements('id');
            $table->uuid('company_id');
            $table->uuid('conversation_id');
            $table->uuid('contact_id');
            $table->dateTime('sent_at');
            $table->tinyInteger('score')->nullable();
            $table->dateTime('responded_at')->nullable();
            $table->string('raw_response', 50)->nullable();

            $table->unique(['conversation_id']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('csat_surveys');
        Schema::dropIfExists('agent_presence_log');
        Schema::dropIfExists('analytics_agent_daily');
        Schema::dropIfExists('analytics_hourly_volume');
        Schema::dropIfExists('analytics_conversation_facts');
        Schema::dropIfExists('sla_configs');
    }
};
