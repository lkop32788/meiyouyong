<?php

namespace Tests\Support;

use App\Models\Channel;
use App\Models\Contact;
use App\Models\Conversation;
use App\Services\Channels\ChannelAdapterInterface;
use App\Services\Channels\ChannelSendException;

/**
 * Adapter that records what it was asked to send instead of talking to a
 * provider, so outbound tests never leave the box.
 */
class StubChannelAdapter implements ChannelAdapterInterface
{
    /** @var array<int, array{content_type: string, content: array, channel_id: string}> */
    public array $sent = [];

    public function __construct(
        private readonly string $type = 'whatsapp',
        private readonly string $providerMessageId = 'stub-provider-id',
        private readonly bool $shouldFail = false,
    ) {}

    public function send(
        Conversation $conv,
        Contact      $contact,
        Channel      $channel,
        string       $contentType,
        array        $content,
        ?string      $replyToProviderMsgId = null
    ): string {
        if ($this->shouldFail) {
            throw new ChannelSendException('stub failure', channelType: $this->type);
        }

        $this->sent[] = [
            'content_type' => $contentType,
            'content'      => $content,
            'channel_id'   => $channel->id,
        ];

        return $this->providerMessageId;
    }

    public function supports(string $channelType): bool
    {
        return $channelType === $this->type;
    }
}
