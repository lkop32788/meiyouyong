<?php

return [
    'host'     => env('RABBITMQ_HOST', 'localhost'),
    'port'     => (int) env('RABBITMQ_PORT', 5672),
    'user'     => env('RABBITMQ_USER', 'guest'),
    'password' => env('RABBITMQ_PASSWORD', 'guest'),
    'vhost'    => env('RABBITMQ_VHOST', '/'),

    // Exchange names — harus sinkron dengan Phase 2 gateway (amqpClient.js)
    'exchange' => 'messages',
    'dlx'      => 'messages.dlx',

    // Queue names per channel type.
    // MUST match the channelTypes array in gateway/lib/amqpClient.js — the
    // gateway publishes to inbound.{channel_type} for all seven, but only four
    // were listed here, so whatsapp_qr / facebook / sms messages had no
    // consumer and silently expired against the 5-minute TTL.
    'queues' => [
        'whatsapp'    => 'inbound.whatsapp',
        'whatsapp_qr' => 'inbound.whatsapp_qr',
        'facebook'    => 'inbound.facebook',
        'line'        => 'inbound.line',
        'email'       => 'inbound.email',
        'telegram'    => 'inbound.telegram',
        'sms'         => 'inbound.sms',
    ],
];
