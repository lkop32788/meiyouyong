<?php

namespace Database\Factories;

use App\Models\Channel;
use App\Models\Company;
use Illuminate\Database\Eloquent\Factories\Factory;
use Illuminate\Support\Facades\Crypt;

/**
 * @extends Factory<Channel>
 */
class ChannelFactory extends Factory
{
    protected $model = Channel::class;

    public function definition(): array
    {
        return [
            'company_id'            => Company::factory(),
            'name'                  => fake()->words(2, true),
            'type'                  => 'whatsapp',
            'provider'              => 'cloud',
            // Column is NOT NULL; nothing here decrypts it, but keep it real.
            'credentials_encrypted' => Crypt::encryptString(json_encode(['mode' => 'test'])),
            'settings'              => ['display_phone_number' => fake()->numerify('+62###########')],
            'is_active'             => true,
            'is_inbox_enabled'      => true,
        ];
    }

    public function inactive(): static
    {
        return $this->state(fn () => ['is_active' => false]);
    }

    /** A channel type that carries no phone number. */
    public function withoutPhone(): static
    {
        return $this->state(fn () => ['type' => 'telegram', 'settings' => null]);
    }
}
