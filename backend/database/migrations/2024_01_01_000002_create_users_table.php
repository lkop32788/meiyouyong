<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('users', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->uuid('company_id');
            $table->string('name', 100);
            $table->string('email', 150);
            $table->string('password')->nullable();
            $table->string('role', 30)->default('agent'); // super_admin | admin | supervisor | agent
            $table->json('skill_tags')->nullable();
            $table->unsignedSmallInteger('max_concurrent_chats')->default(5);
            $table->string('avatar_url', 500)->nullable();
            $table->string('locale', 10)->default('id');
            $table->string('timezone', 50)->default('Asia/Jakarta');
            $table->boolean('is_active')->default(true);
            $table->timestamp('last_seen_at')->nullable();
            $table->rememberToken();
            $table->timestamps();
            $table->softDeletes();

            $table->foreign('company_id')->references('id')->on('companies');

            $table->unique(['company_id', 'email']);
            $table->index(['company_id', 'role', 'is_active']);
        });

        Schema::create('user_audit_logs', function (Blueprint $table) {
            $table->bigIncrements('id');
            $table->uuid('company_id');
            $table->uuid('actor_id');
            $table->uuid('target_user_id');
            $table->string('action', 50);
            $table->json('before')->nullable();
            $table->json('after')->nullable();
            $table->string('ip_address', 45)->nullable();
            $table->timestamp('created_at');

            $table->index(['company_id', 'target_user_id', 'created_at']);
        });

        // Personal access tokens for Sanctum
        Schema::create('personal_access_tokens', function (Blueprint $table) {
            $table->id();
            // uuidMorphs: User ids are UUIDs (HasUuids); plain morphs() would
            // create a bigint tokenable_id and token inserts would truncate.
            $table->uuidMorphs('tokenable');
            $table->string('name');
            $table->string('token', 64)->unique();
            $table->text('abilities')->nullable();
            $table->timestamp('last_used_at')->nullable();
            $table->timestamp('expires_at')->nullable();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('personal_access_tokens');
        Schema::dropIfExists('user_audit_logs');
        Schema::dropIfExists('users');
    }
};
