<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // Voice agents — configurable AI phone assistants (inbound auto-answer + outbound dial)
        Schema::create('voice_agents', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->uuid('company_id')->index();
            $table->uuid('channel_id')->nullable()->index();
            $table->string('name', 120);
            $table->string('description', 500)->nullable();
            // openai (Realtime API) | groq_sarvam (budget STT+LLM+TTS pipeline)
            $table->string('engine', 30)->default('openai');
            $table->text('system_prompt')->nullable();
            $table->string('greeting', 500)->default('您好！请问有什么可以帮您？');

            // Voice settings
            $table->string('voice', 40)->default('alloy');       // OpenAI voice name
            $table->string('voice_id', 60)->default('priya');    // Sarvam voice id
            $table->string('language', 20)->default('zh-CN');     // TTS language hint
            $table->float('voice_speed', 4, 2)->default(1.0);   // 0.5-2.0
            $table->float('voice_pitch', 4, 2)->default(1.0);   // 0.5-2.0

            // Encrypted API keys (per-agent override; falls back to company AI config)
            $table->text('realtime_api_key')->nullable();
            $table->text('groq_api_key')->nullable();
            $table->text('sarvam_api_key')->nullable();

            // Call behaviour
            $table->unsignedInteger('max_duration_seconds')->default(300);
            $table->string('transfer_number', 30)->nullable();
            $table->boolean('summary_enabled')->default(true);
            $table->boolean('is_active')->default(false);
            $table->boolean('is_default')->default(false);

            $table->timestamps();

            $table->index(['company_id', 'is_active']);
            $table->index(['company_id', 'is_default']);
        });

        // Call sessions — one row per Meta call, linked to a voice agent
        Schema::create('call_sessions', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->uuid('company_id')->index();
            $table->uuid('channel_id')->nullable()->index();
            $table->uuid('voice_agent_id')->nullable()->index();
            $table->string('call_id', 80)->index();  // Meta call id (unique per session)
            $table->string('from_number', 30)->nullable();
            $table->string('to_number', 30)->nullable();
            // inbound (user_initiated) | outbound (business_initiated)
            $table->string('direction', 24)->default('user_initiated');
            // initiating -> incoming -> ringing -> ai-connected -> accepted -> completed
            // failed | rejected | terminated | missed
            $table->string('status', 24)->default('initiating');
            $table->unsignedInteger('duration_seconds')->default(0);
            $table->json('transcript')->nullable();   // [{role, text}]
            $table->text('summary')->nullable();       // AI-generated call summary
            $table->string('disposition', 40)->nullable();
            $table->string('recording_url', 500)->nullable();
            $table->text('error')->nullable();
            $table->timestamp('started_at')->nullable();
            $table->timestamp('ended_at')->nullable();
            $table->timestamps();

            $table->index(['company_id', 'created_at']);
            $table->index(['call_id', 'company_id']);
            $table->index(['voice_agent_id', 'status']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('call_sessions');
        Schema::dropIfExists('voice_agents');
    }
};
