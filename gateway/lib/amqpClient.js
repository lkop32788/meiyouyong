'use strict';

const amqplib = require('amqplib');

/**
 * Buat RabbitMQ connection + confirm channel.
 * Satu connection, satu channel — reuse untuk semua publish.
 * Jangan buat connection baru per request (sangat mahal).
 *
 * @param {import('pino').Logger} logger
 */
async function createAmqpConnection(logger) {
    const url = process.env.RABBITMQ_URL
        || `amqp://${process.env.RABBITMQ_USER || 'guest'}:${process.env.RABBITMQ_PASSWORD || 'guest'}@${process.env.RABBITMQ_HOST || 'localhost'}:${process.env.RABBITMQ_PORT || 5672}${process.env.RABBITMQ_VHOST || '/'}`;

    const conn = await amqplib.connect(url);

    conn.on('error', (err) => logger.error({ err }, 'RabbitMQ connection error'));
    conn.on('close', () => logger.warn('RabbitMQ connection closed'));

    const channel = await conn.createConfirmChannel();
    channel.on('error', (err) => logger.error({ err }, 'RabbitMQ channel error'));

    logger.info({ host: process.env.RABBITMQ_HOST || 'localhost' }, 'RabbitMQ connected');
    return { conn, channel };
}

/**
 * Declare exchanges dan queues (idempotent — aman dipanggil ulang).
 *
 * Topology:
 *   Exchange: messages (topic)     → routing key: inbound.{type}, status.{type}
 *   Exchange: messages.dlx (direct) → dead letter exchange
 *   Queues: inbound.whatsapp, inbound.line, inbound.email, inbound.telegram, inbound.sms
 *   Queue:  dead.letters
 *
 * @param {import('amqplib').ConfirmChannel} channel
 */
async function setupBrokerTopology(channel) {
    // Main topic exchange
    await channel.assertExchange('messages', 'topic', { durable: true });

    // Dead letter exchange
    await channel.assertExchange('messages.dlx', 'direct', { durable: true });

    // Status updates exchange (delivered, read, failed dari provider)
    await channel.assertExchange('message.status', 'topic', { durable: true });

    // Inbound queues per channel type
    const channelTypes = ['whatsapp', 'whatsapp_qr', 'facebook', 'line', 'email', 'telegram', 'sms'];
    for (const type of channelTypes) {
        const queueName = `inbound.${type}`;
        await channel.assertQueue(queueName, {
            durable: true,
            arguments: {
                'x-dead-letter-exchange':    'messages.dlx',
                'x-dead-letter-routing-key': `dead.${type}`,
                'x-message-ttl':              300_000,  // 5 menit
            },
        });
        await channel.bindQueue(queueName, 'messages', `inbound.${type}`);
    }

    // Status update queues
    for (const type of channelTypes) {
        const queueName = `status.${type}`;
        await channel.assertQueue(queueName, { durable: true });
        await channel.bindQueue(queueName, 'message.status', `status.${type}`);
    }

    // Dead letter queue — untuk monitoring & reprocessing manual
    await channel.assertQueue('dead.letters', { durable: true });
    await channel.bindQueue('dead.letters', 'messages.dlx', '#');
}

module.exports = { createAmqpConnection, setupBrokerTopology };
