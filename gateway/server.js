'use strict';

// Load .env before anything reads process.env
require('dotenv').config();

/**
 * Webhook Gateway — Entry Point
 *
 * ARSITEKTUR: "Receive fast, process async"
 * - HTTP handler hanya: verify signature → dedup check → enqueue
 * - Semua business logic ada di consumer (Laravel), bukan di sini
 * - Node.js event loop non-blocking ideal untuk I/O-bound webhook flood
 */

const express = require('express');
const { raw, json } = require('express');
const pino = require('pino');

const { createRedisClient } = require('./lib/redisClient');
const { createAmqpConnection, setupBrokerTopology } = require('./lib/amqpClient');
const { healthCheck } = require('./handlers/health');

const whatsappRouter = require('./routes/whatsapp');
const lineRouter = require('./routes/line');
const emailRouter = require('./routes/email');
const telegramRouter = require('./routes/telegram');

const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    transport: process.env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty' }
        : undefined,
});

async function bootstrap() {
    // ── Redis ──────────────────────────────────────────────────────────────────
    const redis = await createRedisClient(logger);

    // ── RabbitMQ ───────────────────────────────────────────────────────────────
    // Satu connection, satu confirmChannel — reuse untuk semua publish
    const { conn: amqpConn, channel: amqpChannel } = await createAmqpConnection(logger);
    await setupBrokerTopology(amqpChannel);

    // ── Express ────────────────────────────────────────────────────────────────
    const app = express();

    // Raw body HARUS di-capture sebelum parse JSON — untuk HMAC verification.
    // WhatsApp & LINE memerlukan raw buffer (bukan parsed object) saat verifikasi.
    app.use(
        raw({
            type: ['application/json', 'application/x-www-form-urlencoded', 'application/octet-stream'],
            limit: '10mb',
            verify: (req, _res, buf) => {
                req.rawBody = buf;
            },
        })
    );
    app.use(json({ limit: '10mb' }));

    // Request logger
    app.use((req, res, next) => {
        const start = Date.now();
        res.on('finish', () => {
            logger.info({
                method: req.method,
                url:    req.url,
                status: res.statusCode,
                ms:     Date.now() - start,
            });
        });
        next();
    });

    // Inject shared deps ke semua route handlers via res.locals
    app.use((req, res, next) => {
        res.locals.redis       = redis;
        res.locals.amqpChannel = amqpChannel;
        res.locals.logger      = logger;
        next();
    });

    // ── Routes ─────────────────────────────────────────────────────────────────
    app.get('/health', healthCheck);

    app.use('/webhook/whatsapp', whatsappRouter);
    app.use('/webhook/line',     lineRouter);
    app.use('/webhook/email',    emailRouter);
    app.use('/webhook/telegram', telegramRouter);

    // 404
    app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

    // Global error handler — jangan expose stack trace ke provider
    app.use((err, req, res, _next) => {
        logger.error({ err, url: req.url }, 'Unhandled error in gateway');
        res.status(500).json({ error: 'Internal server error' });
    });

    const PORT = parseInt(process.env.PORT || '3001', 10);
    const server = app.listen(PORT, () => {
        logger.info({ port: PORT }, 'Webhook gateway started');
    });

    // ── Graceful shutdown ──────────────────────────────────────────────────────
    const shutdown = async (signal) => {
        logger.info({ signal }, 'Shutdown signal received');
        server.close(async () => {
            try {
                await amqpChannel.close();
                await amqpConn.close();
                await redis.quit();
                logger.info('Graceful shutdown complete');
            } catch (err) {
                logger.error({ err }, 'Error during shutdown');
            }
            process.exit(0);
        });
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT',  () => shutdown('SIGINT'));
}

bootstrap().catch((err) => {
    console.error('Fatal: gateway failed to start', err);
    process.exit(1);
});
