<?php

namespace Database\Seeders;

use Illuminate\Database\Seeder;

class DatabaseSeeder extends Seeder
{
    /**
     * Seed the application's database.
     *
     * The stock Laravel User factory does not fit this schema (UUID PKs,
     * company_id, no email_verified_at), so bootstrap the first company +
     * admin via AdminUserSeeder instead. Credentials come from env:
     * ADMIN_EMAIL / ADMIN_PASSWORD (see that seeder for all options).
     */
    public function run(): void
    {
        $this->call([
            AdminUserSeeder::class,
        ]);
    }
}
