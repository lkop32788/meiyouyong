'use strict';

/**
 * Signature Verification Middleware
 *
 * KENAPA KRITIS: tanpa ini, endpoint bisa di-spam dengan request palsu.
 * Semua perbandingan signature HARUS pakai timingSafeEqual — bukan ===.
 * Perbandingan string biasa rentan timing side-channel attack.
 *
 * Channel secret di-cache di Redis (TTL 5 menit) sebelum ke SQL Server,
 * agar signature check tidak menambah latency per-request.
 */

const crypto = require('crypto');
const { channelSecretKey } = require('../lib/redisKeys');
const { getSqlPool } = require('../lib/sqlPool');

// ── Secret Resolution (Redis cache → SQL Server) ──────────────────────────

/**
 * Ambil secret channel dari Redis cache. Jika cache miss, query SQL Server.
 * Secret disimpan ter-decrypt di Redis dengan TTL 5 menit.
 *
 * @param {string} channelType
 * @param {string} channelId  - UUID internal channel
 * @param {import('redis').RedisClientType} redis
 * @returns {Promise<string|null>}
 */
async function getChannelSecret(channelType, channelId, redis) {
    const key = channelSecretKey(channelType, channelId);

    // 1. Redis cache
    const cached = await redis.get(key);
    if (cached) return cached;

    // 2. MySQL fallback
    const pool = getSqlPool();
    const [rows] = await pool.query(
        `
            SELECT credentials_encrypted
            FROM   channels
            WHERE  id          = ?
              AND  type        = ?
              AND  is_active   = 1
              AND  deleted_at  IS NULL
            LIMIT 1
        `,
        [channelId, channelType]
    );

    if (!rows.length) return null;

    // Decrypt credentials (AES-256-CBC via Laravel's Crypt facade format)
    // Di gateway kita cukup ambil field 'app_secret' atau 'channel_secret' dari JSON
    const decrypted = decryptLaravelCrypt(rows[0].credentials_encrypted);
    if (!decrypted) return null;

    const secret = decrypted.app_secret || decrypted.channel_secret || null;
    if (!secret) return null;

    // Cache 5 menit
    await redis.set(key, secret, { EX: 300 });
    return secret;
}

/**
 * Decrypt string yang di-encrypt oleh Laravel's Crypt::encryptString().
 * Laravel menggunakan AES-256-CBC dengan format JSON payload:
 * { iv: base64, value: base64, mac: hex }
 *
 * @param {string} laravelEncrypted
 * @returns {Object|null} parsed JSON credential
 */
function decryptLaravelCrypt(laravelEncrypted) {
    try {
        const appKey = Buffer.from(
            (process.env.APP_KEY || '').replace('base64:', ''),
            'base64'
        );
        const payload = JSON.parse(
            Buffer.from(laravelEncrypted, 'base64').toString('utf8')
        );
        const iv = Buffer.from(payload.iv, 'base64');
        const encrypted = Buffer.from(payload.value, 'base64');
        const decipher = crypto.createDecipheriv('AES-256-CBC', appKey, iv);
        const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
        return JSON.parse(decrypted.toString('utf8'));
    } catch {
        return null;
    }
}

// ── WhatsApp Cloud API (Meta) ─────────────────────────────────────────────

/**
 * Middleware async untuk verifikasi WhatsApp webhook.
 *
 * GET  → challenge verification (saat setup channel di Meta Dashboard)
 * POST → HMAC-SHA256 dari raw body, header X-Hub-Signature-256
 */
function verifyWhatsApp(req, res, next) {
    if (req.method === 'GET') {
        const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
        if (mode === 'subscribe' && token === process.env.WA_VERIFY_TOKEN) {
            res.locals.logger.info('WhatsApp webhook challenge verified');
            return res.status(200).send(challenge);
        }
        return res.status(403).json({ error: 'Verification failed' });
    }

    return verifyWhatsAppPost(req, res, next);
}

async function verifyWhatsAppPost(req, res, next) {
    const { redis, logger } = res.locals;
    const { channelId } = req.params;
    const signature = req.headers['x-hub-signature-256'];

    if (!signature) return res.status(401).json({ error: 'Missing signature' });

    const secret = await getChannelSecret('whatsapp', channelId, redis);
    if (!secret) {
        logger.warn({ channelId }, 'WhatsApp channel not found or inactive');
        return res.status(401).json({ error: 'Unknown channel' });
    }

    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
    const receivedBuf = Buffer.from(signature);
    const expectedBuf = Buffer.from(expected);

    if (receivedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(receivedBuf, expectedBuf)) {
        logger.warn({ channelId }, 'WhatsApp signature mismatch');
        return res.status(401).json({ error: 'Invalid signature' });
    }

    next();
}

// ── LINE Messaging API ────────────────────────────────────────────────────

async function verifyLine(req, res, next) {
    const { redis, logger } = res.locals;
    const { channelId } = req.params;
    const signature = req.headers['x-line-signature'];

    if (!signature) return res.status(401).json({ error: 'Missing signature' });

    const secret = await getChannelSecret('line', channelId, redis);
    if (!secret) {
        logger.warn({ channelId }, 'LINE channel not found or inactive');
        return res.status(401).json({ error: 'Unknown channel' });
    }

    const expected    = crypto.createHmac('sha256', secret).update(req.rawBody).digest('base64');
    const expectedBuf = Buffer.from(expected);
    const receivedBuf = Buffer.from(signature);

    if (expectedBuf.length !== receivedBuf.length || !crypto.timingSafeEqual(expectedBuf, receivedBuf)) {
        logger.warn({ channelId }, 'LINE signature mismatch');
        return res.status(401).json({ error: 'Invalid signature' });
    }

    next();
}

// ── Telegram ─────────────────────────────────────────────────────────────

async function verifyTelegram(req, res, next) {
    const { redis, logger } = res.locals;
    const { channelId } = req.params;
    const token = req.headers['x-telegram-bot-api-secret-token'];

    if (!token) return res.status(401).json({ error: 'Missing token' });

    const expected = await getChannelSecret('telegram', channelId, redis);
    if (!expected) {
        logger.warn({ channelId }, 'Telegram channel not found or inactive');
        return res.status(401).json({ error: 'Unknown channel' });
    }

    const receivedBuf = Buffer.from(token);
    const expectedBuf = Buffer.from(expected);

    if (receivedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(receivedBuf, expectedBuf)) {
        return res.status(401).json({ error: 'Invalid token' });
    }

    next();
}

// ── Email (Mailgun HMAC) ──────────────────────────────────────────────────

/**
 * Verifikasi Mailgun webhook signature.
 * Mailgun mengirim: timestamp, token, signature (HMAC-SHA256 dari timestamp+token).
 */
async function verifyMailgun(req, res, next) {
    const { redis, logger } = res.locals;
    const { channelId } = req.params;
    const { timestamp, token, signature } = req.body || {};

    if (!timestamp || !token || !signature) {
        return res.status(401).json({ error: 'Missing Mailgun signature fields' });
    }

    // Tolak webhook yang terlalu lama (replay attack)
    const age = Math.abs(Date.now() / 1000 - parseInt(timestamp, 10));
    if (age > 300) {
        logger.warn({ channelId, age }, 'Mailgun webhook timestamp too old');
        return res.status(401).json({ error: 'Webhook expired' });
    }

    const secret = await getChannelSecret('email', channelId, redis);
    if (!secret) return res.status(401).json({ error: 'Unknown channel' });

    const expected    = crypto.createHmac('sha256', secret).update(timestamp + token).digest('hex');
    const expectedBuf = Buffer.from(expected);
    const receivedBuf = Buffer.from(signature);

    if (expectedBuf.length !== receivedBuf.length || !crypto.timingSafeEqual(expectedBuf, receivedBuf)) {
        logger.warn({ channelId }, 'Mailgun signature mismatch');
        return res.status(401).json({ error: 'Invalid signature' });
    }

    next();
}

module.exports = { verifyWhatsApp, verifyLine, verifyTelegram, verifyMailgun };
