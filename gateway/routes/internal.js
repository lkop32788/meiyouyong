'use strict';

/**
 * Internal API — called by the Laravel backend only (X-Internal-Api-Key).
 *
 * Bridges the backend to gateway-managed drivers:
 * - whatsapp_qr : Baileys QR sessions (start / status / send / disconnect / sync)
 *
 * Auth: static shared secret (INTERNAL_API_KEY), compared timing-safe.
 */

const { Router } = require('express');
const crypto = require('crypto');

const baileys = require('../services/baileysManager');

const router = Router();

function requireInternalKey(req, res, next) {
    const provided = req.get('X-Internal-Api-Key') || '';
    const expected = process.env.INTERNAL_API_KEY || '';

    if (!expected) {
        return res.status(503).json({ error: 'Internal API not configured' });
    }

    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return res.status(401).json({ error: 'Invalid internal API key' });
    }
    next();
}

router.use(requireInternalKey);

// ── WhatsApp QR (Baileys) ─────────────────────────────────────────────────────

// Start (or resume) a QR pairing session for a channel
router.post('/waqr/:channelId/start', async (req, res) => {
    const { logger, redis, amqpChannel } = res.locals;
    try {
        const state = await baileys.startSession(req.params.channelId, logger);
        baileys.bindDeps(req.params.channelId, {
            redis,
            amqpChannel,
            companyId: req.body?.company_id || null,
        });
        const status = await baileys.getStatus(req.params.channelId, logger);
        res.json({ ok: true, data: status });
    } catch (e) {
        logger.error({ err: e.message }, '[internal] waqr start failed');
        res.status(500).json({ ok: false, error: e.message });
    }
});

// Poll connection status + QR image (data URL)
router.get('/waqr/:channelId/status', async (req, res) => {
    const { logger } = res.locals;
    try {
        const status = await baileys.getStatus(req.params.channelId, logger);
        res.json({ ok: true, data: status });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// Send an outbound message through the QR socket
router.post('/waqr/:channelId/send', async (req, res) => {
    const { logger } = res.locals;
    try {
        const { phone, type, text, media } = req.body || {};
        if (!phone) return res.status(400).json({ ok: false, error: 'phone required' });
        const result = await baileys.sendMessage(
            req.params.channelId, phone, { type: type || 'text', text, media }, logger
        );
        res.json({ ok: true, data: result });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// Disconnect + wipe the session
router.post('/waqr/:channelId/disconnect', async (req, res) => {
    const { logger } = res.locals;
    try {
        await baileys.disconnect(req.params.channelId, logger);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// Re-sync (pull messages received while offline)
router.post('/waqr/:channelId/sync', async (req, res) => {
    const { logger } = res.locals;
    try {
        await baileys.syncSession(req.params.channelId, logger);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

module.exports = router;
