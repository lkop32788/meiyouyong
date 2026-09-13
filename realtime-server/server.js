// Load .env before anything reads process.env
import 'dotenv/config';

/**
 * Phase 4A — OmniClick Realtime Server
 *
 * Tanggung jawab: distribusi event saja — TIDAK ada business logic di sini.
 * Business logic ada di Laravel (Phase 3).
 *
 * Port: 3002 (gateway = 3001, laravel = 8000)
 */

import { createServer } from 'node:http';
import { createClient } from 'redis';
import { Server } from 'socket.io';
import pino from 'pino';
import { config } from './config/index.js';
import { setupSocketio } from './socket/index.js';
import { RedisEventSubscriber } from './redis/subscriber.js';

const log = pino({
  level: config.log.level,
  transport: config.nodeEnv !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
});

// ── Bootstrap ─────────────────────────────────────────────────────────────────

async function bootstrap() {
  // 1. HTTP server
  const httpServer = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, uptime: process.uptime() }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  // 2. Socket.io server
  const io = new Server(httpServer, {
    cors: {
      origin:      config.cors.origins,
      credentials: true,
    },
    pingTimeout:  config.socket.pingTimeout,
    pingInterval: config.socket.pingInterval,
  });

  // 3. Redis — DUA client: satu untuk general, satu dedicated untuk subscribe
  const redisGeneral = createClient({ url: config.redis.url });
  const redisSub     = createClient({ url: config.redis.url });

  redisGeneral.on('error', (err) => log.error({ err }, 'Redis (general) error'));
  redisSub.on('error',     (err) => log.error({ err }, 'Redis (sub) error'));

  await redisGeneral.connect();
  await redisSub.connect();
  log.info('Redis connected (general + subscriber)');

  // 4. Redis event subscriber (forward events dari Laravel ke Socket.io)
  const subscriber = new RedisEventSubscriber(redisSub, io, log);

  // 5. Setup Socket.io middleware + handlers
  setupSocketio(io, redisGeneral, subscriber, log);

  // 6. Start server
  httpServer.listen(config.port, () => {
    log.info({ port: config.port }, 'Realtime server listening');
  });

  // ── Graceful shutdown ──────────────────────────────────────────────────────

  const shutdown = async (signal) => {
    log.info({ signal }, 'Shutting down gracefully...');

    // Stop menerima koneksi baru
    io.close(() => log.info('Socket.io closed'));

    // Close Redis
    await redisGeneral.quit().catch(() => {});
    await redisSub.quit().catch(() => {});

    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

bootstrap().catch((err) => {
  log.fatal({ err }, 'Fatal: realtime server failed to start');
  process.exit(1);
});
