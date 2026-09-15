<?php

namespace Database\Factories;

use App\Models\Channel;
use App\Models\Company;
use App\Models\Contact;
use App\Models\Conversation;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<Conversation>
 */
class ConversationFactory extends Factory
{
    protected $model = Conversation::class;

    public function definition(): array
    {
        return [
            'company_id'      => Company::factory(),
            'channel_id'      => Channel::factory(),
            'contact_id'      => Contact::factory(),
            'status'          => 'open',
            'priority'        => 'normal',
            'last_message_at' => now(),
        ];
    }

    /** Put the conversation on an existing channel, keeping the company aligned. */
    public function onChannel(Channel $channel): static
    {
        return $this->state(fn () => [
            'channel_id' => $channel->id,
            'company_id' => $channel->company_id,
            'contact_id' => Contact::factory()->state(['company_id' => $channel->company_id]),
        ]);
    }
}
