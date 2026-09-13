<?php

namespace Database\Seeders;

use App\Models\Company;
use App\Models\User;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\Hash;

/**
 * Bootstraps the first company and its admin account.
 *
 * Credentials come from env so nothing sensitive is committed:
 *   COMPANY_NAME      (default: OmniClick)
 *   COMPANY_SLUG      (default: demo)
 *   ADMIN_NAME        (default: Admin)
 *   ADMIN_EMAIL       (required)
 *   ADMIN_PASSWORD    (required)
 *   ADMIN_ROLE        (default: super_admin)
 *
 * Idempotent: re-running updates the existing admin's password/role
 * instead of duplicating (users are unique per company+email).
 */
class AdminUserSeeder extends Seeder
{
    public function run(): void
    {
        $email = env('ADMIN_EMAIL');
        $password = env('ADMIN_PASSWORD');

        if (! $email || ! $password) {
            $this->command?->warn('ADMIN_EMAIL / ADMIN_PASSWORD not set — skipping AdminUserSeeder.');

            return;
        }

        $company = Company::firstOrCreate(
            ['slug' => env('COMPANY_SLUG', 'demo')],
            [
                'name'      => env('COMPANY_NAME', 'OmniClick'),
                'timezone'  => 'Asia/Jakarta',
                'locale'    => 'id',
                'is_active' => true,
            ]
        );

        User::updateOrCreate(
            [
                'company_id' => $company->id,
                'email'      => $email,
            ],
            [
                'name'       => env('ADMIN_NAME', 'Admin'),
                'password'   => Hash::make($password),
                'role'       => env('ADMIN_ROLE', 'super_admin'),
                'is_active'  => true,
            ]
        );

        $this->command?->info("Admin ready: {$email} @ company '{$company->slug}'");
    }
}
