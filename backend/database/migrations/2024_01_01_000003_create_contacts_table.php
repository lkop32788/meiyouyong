<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('contacts', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->uuid('company_id');
            $table->string('name', 150)->nullable();
            $table->boolean('name_is_manual')->default(false);
            $table->string('email', 150)->nullable();
            $table->string('phone', 30)->nullable();
            $table->string('avatar_url', 500)->nullable();
            $table->string('locale', 10)->nullable();
            $table->string('timezone', 50)->nullable();
            $table->json('custom_attributes')->nullable();
            $table->json('tags')->nullable();
            $table->unsignedBigInteger('lifetime_conversation_count')->default(0);
            $table->timestamp('last_contacted_at')->nullable();
            $table->timestamps();
            $table->softDeletes();

            $table->foreign('company_id')->references('id')->on('companies');
            $table->index(['company_id', 'email']);
            $table->index(['company_id', 'phone']);
            $table->index(['company_id', 'last_contacted_at']);
        });

        Schema::create('contact_channel_identities', function (Blueprint $table) {
            $table->bigIncrements('id');
            $table->uuid('contact_id');
            $table->uuid('company_id');
            $table->string('channel_type', 30);
            $table->string('external_id', 200);
            $table->string('display_name', 150)->nullable();
            $table->string('avatar_url', 500)->nullable();
            $table->json('raw_profile')->nullable();
            $table->timestamps();

            $table->foreign('contact_id')->references('id')->on('contacts');

            // CRITICAL: enforce uniqueness for identity resolution
            // (explicit name: MySQL caps identifiers at 64 chars and the
            //  auto-generated name exceeds it)
            $table->unique(['company_id', 'channel_type', 'external_id'], 'cci_company_channel_external_unique');
            $table->index(['contact_id', 'channel_type']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('contact_channel_identities');
        Schema::dropIfExists('contacts');
    }
};
