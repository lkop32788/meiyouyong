<?php

namespace Database\Factories;

use App\Models\Company;
use App\Models\User;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<User>
 *
 * The stock Laravel factory did not fit this schema (UUID PKs, required
 * company_id, no email_verified_at column) — see DatabaseSeeder.
 */
class UserFactory extends Factory
{
    protected $model = User::class;

    /** Plain password every factory user gets, so tests can log in as them. */
    public const PASSWORD = 'password123';

    public function definition(): array
    {
        return [
            'company_id'           => Company::factory(),
            'name'                 => fake()->name(),
            'email'                => fake()->unique()->safeEmail(),
            'password'             => self::PASSWORD, // hashed by the 'hashed' cast
            'role'                 => 'agent',
            'skill_tags'           => null,
            'max_concurrent_chats' => 5,
            'locale'               => 'id',
            'timezone'             => 'Asia/Jakarta',
            'is_active'            => true,
        ];
    }

    public function superAdmin(): static
    {
        return $this->state(fn () => ['role' => 'super_admin']);
    }

    public function admin(): static
    {
        return $this->state(fn () => ['role' => 'admin']);
    }

    public function supervisor(): static
    {
        return $this->state(fn () => ['role' => 'supervisor']);
    }

    public function agent(): static
    {
        return $this->state(fn () => ['role' => 'agent']);
    }

    /**
     * Mirrors AgentController::destroy — is_active false AND soft-deleted.
     * deleted_at is not fillable, so it has to be set after creation.
     */
    public function deactivated(): static
    {
        return $this->state(fn () => ['is_active' => false])
            ->afterCreating(fn (User $user) => $user->delete());
    }
}
