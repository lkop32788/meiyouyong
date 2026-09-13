<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('bot_flows', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->uuid('company_id');
            $table->uuid('channel_id')->nullable();
            $table->string('name', 150);
            $table->string('trigger_type', 30); // keyword | any_message | intent | event
            $table->text('trigger_config')->nullable(); // JSON
            $table->longText('flow_graph'); // JSON: { nodes: [...], edges: [...] }
            $table->boolean('is_active')->default(false);
            $table->integer('version')->default(1);
            $table->timestamps();

            $table->foreign('company_id')->references('id')->on('companies');
            $table->index(['company_id', 'is_active']);
            $table->index(['company_id', 'channel_id', 'trigger_type']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('bot_flows');
    }
};
