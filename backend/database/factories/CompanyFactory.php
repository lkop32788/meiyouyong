<?php

namespace Database\Factories;

use App\Models\Company;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<Company>
 */
class CompanyFactory extends Factory
{
    protected $model = Company::class;

    public function definition(): array
    {
        return [
            'name'         => fake()->company(),
            'slug'         => fake()->unique()->slug(2),
            'timezone'     => 'Asia/Jakarta',
            'locale'       => 'id',
            'plan'         => 'starter',
            'max_agents'   => 50,
            'max_channels' => 10,
            'is_active'    => true,
        ];
    }

    /** A plan with only $seats seats, for exercising the seat-limit guard. */
    public function seats(int $seats): static
    {
        return $this->state(fn () => ['max_agents' => $seats]);
    }
}
