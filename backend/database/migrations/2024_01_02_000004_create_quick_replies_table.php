<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('quick_replies', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->uuid('company_id');
            $table->string('title', 100);
            $table->string('shortcut', 50)->nullable();
            $table->text('message');
            $table->integer('sort_order')->default(0);
            $table->timestamps();

            $table->foreign('company_id')->references('id')->on('companies')->onDelete('cascade');
            $table->unique(['company_id', 'shortcut']);
            $table->index('company_id');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('quick_replies');
    }
};
