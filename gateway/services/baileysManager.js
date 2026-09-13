'use strict';

/**
 * WhatsApp-by-QR session manager (unofficial WhatsApp Web protocol via Baileys).
 *
 * Adapted from wabapanel's waQrService to OmniClick's architecture:
 * - One socket per CHANNEL (channels table row, type = 'whatsapp_qr')
 * - Inbound messages are normalized to the canonical schema and published to
 *   RabbitMQ (inbound.whatsapp_qr) with the same idempotency rules as webhooks
 * - Outbound sends are requested by the Laravel backend over the internal API
 *   (routes/internal.js -> sendMessage here)
 * - Safety engine preserved from wabapanel: warm-up daily caps, human-like
 *   random delays + typing presence, decrypt-failure loop breaker
 *
 * NOTE: unofficial protocol — violates WhatsApp ToS, use with disposable numbers.
 */

const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const { ContentType } = require('../lib/canonicalSchema');
const { publishIfNotDuplicate, publishStatusUpdate } = require('./publisher');

const SESSIONS_DIR = path.join(__dirname, '..', 'wa_sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// Warm-up schedule: max outbound messages per day since first connect.
const WARMUP_CAPS = [25, 40, 60, 90, 130, 180, 250, 350, 450, 600, 750, 900, 1000, 1000];
const MIN_DELAY_MS = 5000;
const MAX_DELAY_MS = 15000;

const sessions = new Map(); // channelId -> { sock, status, qr, phone, queue, sending, ... }

function getState(channelId) {
    const id = String(channelId);
    if (!sessions.has(id)) {
        sessions.set(id, {
            sock: null, status: 'disconnected', qr: null, phone: '',
            queue: [], sending: false, msgStore: new Map(),
            decryptFailCount: 0, decryptFailFirst: 0, decryptFailLastLog: 0,
            rescanResetting: false,
        });
    }
    return sessions.get(id);
}

function dayCap(warmupStartedAt) {
    if (!warmupStartedAt) return WARMUP_CAPS[0];
    const days = Math.floor((Date.now() - new Date(warmupStartedAt).getTime()) / 86400000);
    return WARMUP_CAPS[Math.min(days, WARMUP_CAPS.length - 1)];
}

// ── MySQL helpers ─────────────────────────────────────────────────────────────

function getPool() {
    return require('../lib/sqlPool').getSqlPool();
}

async function markChannelConnected(channelId, phone) {
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    await getPool().query(
        `UPDATE channels
            SET is_active = 1,
                last_webhook_at = ?,
                settings = JSON_MERGE_PATCH(COALESCE(settings, JSON_OBJECT()),
                    JSON_OBJECT('phone', ?, 'warmup_started_at', COALESCE(JSON_UNQUOTE(JSON_EXTRACT(settings, '$.warmup_started_at')), ?)))
          WHERE id = ?`,
        [now, phone, now, channelId]
    ).catch(() => {});
}

async function markChannelDisconnected(channelId, status) {
    await getPool().query(
        `UPDATE channels SET settings = JSON_MERGE_PATCH(COALESCE(settings, JSON_OBJECT()), JSON_OBJECT('waqr_status', ?)) WHERE id = ?`,
        [status, channelId]
    ).catch(() => {});
}

async function getChannelSettings(channelId) {
    const [rows] = await getPool().query(
        `SELECT settings FROM channels WHERE id = ? LIMIT 1`,
        [channelId]
    ).catch(() => [[]]);
    const settings = rows[0]?.settings;
    if (!settings) return {};
    if (typeof settings === 'object') return settings;
    try { return JSON.parse(settings); } catch { return {}; }
}

// ── Decrypt-failure loop breaker (from wabapanel) ─────────────────────────────

async function resetSessionForRescan(id, state, logger) {
    if (state.rescanResetting) return;
    state.rescanResetting = true;
    logger.warn({ channelId: id }, `[waqr:${id}] decrypt-failure loop — clearing session keys, re-scan needed`);
    try { if (state.sock) { try { state.sock.ev.removeAllListeners(); } catch { /* noop */ } try { state.sock.end(); } catch { /* noop */ } } } catch { /* noop */ }
    state.sock = null;
    state.status = 'rescan_needed';
    state.qr = null;
    state.decryptFailCount = 0;
    state.decryptFailFirst = 0;
    try { fs.rmSync(path.join(SESSIONS_DIR, id), { recursive: true, force: true }); } catch { /* noop */ }
    markChannelDisconnected(id, 'rescan_needed');
    setTimeout(() => { state.rescanResetting = false; startSession(id, logger).catch(() => {}); }, 3000);
}

function noteDecryptFailure(id, state, logger) {
    const now = Date.now();
    if (!state.decryptFailFirst || now - state.decryptFailFirst > 2 * 60 * 1000) {
        state.decryptFailFirst = now;
        state.decryptFailCount = 0;
    }
    state.decryptFailCount += 1;
    if (now - state.decryptFailLastLog > 15000) {
        state.decryptFailLastLog = now;
        logger.warn({ channelId: id, count: state.decryptFailCount }, '[waqr] decrypt failures in window');
    }
    if (state.decryptFailCount >= 30 && !state.rescanResetting) {
        resetSessionForRescan(id, state, logger).catch(() => {});
    }
}

// ── Session lifecycle ─────────────────────────────────────────────────────────

async function startSession(channelId, logger) {
    const id = String(channelId);
    const state = getState(id);
    if (state.sock) return state;

    const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
    const pino = require('pino');

    const authDir = path.join(SESSIONS_DIR, id);
    const { state: authState, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

    const sock = makeWASocket({
        version,
        auth: authState,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ['OmniClick', 'Chrome', '120.0'],
        syncFullHistory: false, // CS platform: skip bulk history import (keep boot fast)
        markOnlineOnConnect: false, // stay "offline" device so the phone routes reliably
        retryRequestDelayMs: 250,
        getMessage: async (key) => state.msgStore.get(key?.id)?.message || undefined,
    });
    state.sock = sock;
    state.status = 'connecting';

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            state.qr = qr;
            state.status = 'qr';
        }
        if (connection === 'open') {
            state.qr = null;
            state.status = 'connected';
            state.decryptFailCount = 0;
            state.decryptFailFirst = 0;
            state.rescanResetting = false;
            state.phone = (sock.user?.id || '').split(':')[0].split('@')[0];
            logger.info({ channelId: id, phone: state.phone }, '[waqr] connected');
            await markChannelConnected(id, state.phone);
        }
        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            state.sock = null;
            if (code === DisconnectReason.loggedOut) {
                state.status = 'disconnected';
                state.qr = null;
                try { fs.rmSync(path.join(SESSIONS_DIR, id), { recursive: true, force: true }); } catch { /* noop */ }
                await markChannelDisconnected(id, 'logged_out');
                logger.info({ channelId: id }, '[waqr] logged out — session wiped');
            } else {
                state.status = 'reconnecting';
                setTimeout(() => startSession(id, logger).catch(() => {}), 5000);
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify' && type !== 'append') return;
        for (const m of messages) {
            if (m && m.messageStubType === 2) { noteDecryptFailure(id, state, logger); continue; }
            try { await handleIncoming(id, m, state, logger); } catch (e) {
                logger.warn({ channelId: id, err: e.message }, '[waqr] incoming handling error');
            }
        }
    });

    // Delivery/read receipts for outbound messages
    sock.ev.on('messages.update', async (updates) => {
        const STATUS = { 0: 'failed', 1: 'pending', 2: 'sent', 3: 'delivered', 4: 'read', 5: 'read' };
        for (const u of updates || []) {
            const st = u.update && u.update.status;
            if (st === undefined || st === null) continue;
            const label = STATUS[st] || String(st);
            try {
                await publishStatusUpdate({
                    event_type:          'STATUS_UPDATE',
                    channel_type:        'whatsapp_qr',
                    company_id:          state.companyId || null,
                    channel_id:          id,
                    provider_message_id: u.key?.id,
                    status:              label,
                    recipient_id:        (u.key?.remoteJid || '').split('@')[0],
                    timestamp:           new Date().toISOString(),
                    error:               null,
                }, state.amqpChannel);
            } catch { /* noop */ }
        }
    });

    return state;
}

// ── Inbound normalization ─────────────────────────────────────────────────────

function unwrapMsg(msg) {
    if (!msg || typeof msg !== 'object') return msg || {};
    return msg.ephemeralMessage?.message
        || msg.viewOnceMessage?.message
        || msg.viewOnceMessageV2?.message
        || msg.viewOnceMessageV2Extension?.message
        || msg.documentWithCaptionMessage?.message
        || msg.editedMessage?.message
        || msg;
}

function extractText(msg) {
    if (msg.pollCreationMessage || msg.pollCreationMessageV2 || msg.pollCreationMessageV3) return '[投票]';
    if (msg.locationMessage) {
        const l = msg.locationMessage;
        return `📍 Location${l.name ? ': ' + l.name : ''}${(l.degreesLatitude || l.degreesLongitude) ? ` (${l.degreesLatitude}, ${l.degreesLongitude})` : ''}`;
    }
    if (msg.liveLocationMessage) return '📍 Live location';
    if (msg.contactMessage) return '👤 ' + (msg.contactMessage.displayName || 'Contact');
    if (msg.contactsArrayMessage) return '👤 ' + ((msg.contactsArrayMessage.contacts || []).map(c => c.displayName).filter(Boolean).join(', ') || 'Contacts');
    return msg.conversation || msg.extendedTextMessage?.text || msg.imageMessage?.caption || msg.videoMessage?.caption
        || msg.documentMessage?.caption || msg.documentMessage?.fileName
        || msg.buttonsResponseMessage?.selectedDisplayText || msg.templateButtonReplyMessage?.selectedDisplayText
        || msg.listResponseMessage?.title || '';
}

function extractButtonId(msg) {
    if (msg.buttonsResponseMessage?.selectedButtonId) return msg.buttonsResponseMessage.selectedButtonId;
    if (msg.templateButtonReplyMessage?.selectedId) return msg.templateButtonReplyMessage.selectedId;
    if (msg.listResponseMessage?.singleSelectReply?.selectedRowId) return msg.listResponseMessage.singleSelectReply.selectedRowId;
    const params = msg.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;
    if (params) { try { return JSON.parse(params).id || ''; } catch { return ''; } }
    return '';
}

function normalizePhone(phone) {
    if (!phone) return phone;
    return '+' + phone.replace(/\D/g, '');
}

async function handleIncoming(channelId, m, state, logger) {
    const jid = m.key?.remoteJid || '';
    if (jid === 'status@broadcast') return;
    const isGroup = jid.endsWith('@g.us');
    const outbound = !!m.key?.fromMe;
    if (isGroup) return; // groups unsupported in v1 (CS platform = 1:1)
    if (outbound) return; // outbound 1:1 recorded by the send path

    const phone = (jid.split('@')[0] || '').split(':')[0];
    if (!phone || phone === '0' || phone.length < 7) return;

    const msg = unwrapMsg(m.message || {});
    const text = extractText(msg);
    const buttonId = extractButtonId(msg);
    if (!text && !buttonId) return;

    let profilePic = null;
    try { profilePic = await state.sock?.profilePictureUrl(jid, 'image').catch(() => null) || null; } catch { /* noop */ }

    const base = {
        event_id:            uuidv4(),
        company_id:          state.companyId,
        channel_id:          channelId,
        channel_type:        'whatsapp_qr',
        direction:           'inbound',
        idempotency_key:     `qr_${m.key.id}`,
        sender_external_id:  normalizePhone(phone),
        sender_name:         m.pushName || null,
        sender_avatar:       profilePic,
        quoted_message_id:   m.key?.participant ? null : null,
        conversation_ref_id: null,
        provider_timestamp:  new Date((Number(m.messageTimestamp) || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
        received_at:         new Date().toISOString(),
        raw_payload:         m,
    };

    let canonical;
    if (buttonId) {
        canonical = { ...base, content_type: ContentType.BUTTON_REPLY, content: { button_id: buttonId, button_text: text } };
    } else if (msg.locationMessage || msg.liveLocationMessage) {
        const l = msg.locationMessage || {};
        canonical = {
            ...base,
            content_type: ContentType.LOCATION,
            content: { latitude: l.degreesLatitude || 0, longitude: l.degreesLongitude || 0, name: l.name || null, address: l.address || null },
        };
    } else if (msg.contactMessage || msg.contactsArrayMessage) {
        canonical = { ...base, content_type: ContentType.CONTACT_CARD, content: { display_name: msg.contactMessage?.displayName || 'Contacts' } };
    } else if (msg.reactionMessage) {
        canonical = { ...base, content_type: ContentType.REACTION, content: { emoji: msg.reactionMessage.text || '', reacted_to_message_id: msg.reactionMessage.key?.id || null } };
    } else {
        canonical = { ...base, content_type: ContentType.TEXT, content: { body: text } };
    }

    try {
        await publishIfNotDuplicate(canonical, state.amqpChannel, state.redis, logger);
    } catch (e) {
        logger.error({ channelId, err: e.message }, '[waqr] publish failed');
    }
}

// ── Safety engine + outbound queue ────────────────────────────────────────────

async function checkAndCountSend(id, state, logger) {
    const settings = await getChannelSettings(id);
    const today = new Date().toISOString().slice(0, 10);
    const cap = settings.daily_limit > 0 ? settings.daily_limit : dayCap(settings.warmup_started_at);

    const key = `waqr:sent:${id}:${today}`;
    const sent = await state.redis.incr(key);
    if (sent === 1) await state.redis.expire(key, 172800);
    if (sent > cap) {
        await state.redis.decr(key);
        throw new Error(`Daily safety limit reached (${cap} messages) for this number`);
    }
}

function processQueue(id, logger) {
    const state = getState(id);
    if (state.sending || state.queue.length === 0) return;
    state.sending = true;
    const job = state.queue.shift();
    const run = async () => {
        try {
            const sock = state.sock;
            if (!sock || state.status !== 'connected') throw new Error('WhatsApp QR session is not connected');

            await checkAndCountSend(id, state, logger);

            const jid = String(job.phone).includes('@') ? String(job.phone) : (String(job.phone).replace(/\D/g, '') + '@s.whatsapp.net');

            // Human-like: show typing briefly before sending
            try {
                await sock.presenceSubscribe(jid);
                await sock.sendPresenceUpdate('composing', jid);
                await new Promise(r => setTimeout(r, 1500 + Math.random() * 2500));
                await sock.sendPresenceUpdate('paused', jid);
            } catch { /* noop */ }

            const result = await sock.sendMessage(jid, job.content, job.options || {});
            if (result?.key?.id && result.message) {
                state.msgStore.set(result.key.id, result);
                if (state.msgStore.size > 500) state.msgStore.delete(state.msgStore.keys().next().value);
            }
            job.resolve({ provider_message_id: result?.key?.id || null, raw: undefined });
        } catch (e) {
            job.reject(e);
        } finally {
            const delay = MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);
            setTimeout(() => { state.sending = false; processQueue(id, logger); }, state.queue.length > 0 ? delay : 0);
        }
    };
    run();
}

/**
 * Send an outbound message through the QR socket.
 * @returns {Promise<{provider_message_id: string|null}>}
 */
async function sendMessage(channelId, phone, { type = 'text', text, media }, logger) {
    const id = String(channelId);
    const state = getState(id);
    if (!state.sock || state.status !== 'connected') throw new Error('WhatsApp QR session is not connected');

    let content;
    switch (type) {
        case 'image':    content = { image: { url: media.url }, caption: media.caption || text || '' }; break;
        case 'video':    content = { video: { url: media.url }, caption: media.caption || text || '' }; break;
        case 'audio':    content = { audio: { url: media.url }, mimetype: 'audio/mp4' }; break;
        case 'document': content = { document: { url: media.url }, fileName: media.filename || 'document', caption: media.caption || '' }; break;
        default:         content = { text: text || '' };
    }

    return new Promise((resolve, reject) => {
        state.queue.push({ phone, content, options: {}, resolve, reject });
        processQueue(id, logger);
    });
}

// ── Status / control ──────────────────────────────────────────────────────────

async function getStatus(channelId, logger) {
    const id = String(channelId);
    const state = getState(id);

    let qrDataUrl = null;
    if (state.qr) {
        try {
            const QRCode = require('qrcode');
            qrDataUrl = await QRCode.toDataURL(state.qr, { width: 280, margin: 1 });
        } catch { /* noop */ }
    }

    const settings = await getChannelSettings(id);
    const today = new Date().toISOString().slice(0, 10);
    let sentToday = 0;
    try { sentToday = parseInt(await state.redis.get(`waqr:sent:${id}:${today}`), 10) || 0; } catch { /* noop */ }

    return {
        status:     state.status,
        phone:      state.phone || settings.phone || '',
        qr:         qrDataUrl,
        warmup_started_at: settings.warmup_started_at || null,
        warmup_day: settings.warmup_started_at
            ? Math.min(Math.floor((Date.now() - new Date(settings.warmup_started_at).getTime()) / 86400000) + 1, WARMUP_CAPS.length)
            : 1,
        warmup_total_days: WARMUP_CAPS.length,
        today_cap:  settings.daily_limit > 0 ? settings.daily_limit : dayCap(settings.warmup_started_at),
        custom_limit: settings.daily_limit || 0,
        sent_today: sentToday,
    };
}

async function disconnect(channelId, logger) {
    const id = String(channelId);
    const state = getState(id);
    try { if (state.sock) await state.sock.logout(); } catch { /* noop */ }
    try { if (state.sock) state.sock.end(); } catch { /* noop */ }
    state.sock = null;
    state.status = 'disconnected';
    state.qr = null;
    try { fs.rmSync(path.join(SESSIONS_DIR, id), { recursive: true, force: true }); } catch { /* noop */ }
    await markChannelDisconnected(id, 'disconnected');
}

async function syncSession(channelId, logger) {
    const id = String(channelId);
    const state = getState(id);
    try { if (state.sock) state.sock.end(); } catch { /* noop */ }
    state.sock = null;
    state.status = 'reconnecting';
    return startSession(id, logger);
}

/**
 * Boot-time restore: reconnect every active whatsapp_qr channel.
 * Called from server.js with the shared redis/amqp deps injected.
 */
async function restoreAll(deps, logger) {
    let rows = [];
    try {
        const [r] = await getPool().query(
            `SELECT id FROM channels WHERE type = 'whatsapp_qr' AND is_active = 1 AND deleted_at IS NULL`
        );
        rows = r;
    } catch (e) {
        logger.warn({ err: e.message }, '[waqr] restore skipped (DB unavailable)');
        return 0;
    }
    let count = 0;
    for (const row of rows) {
        const id = String(row.id);
        if (!fs.existsSync(path.join(SESSIONS_DIR, id))) continue;
        try {
            const state = await startSession(id, logger);
            state.redis = deps.redis;
            state.amqpChannel = deps.amqpChannel;
            count++;
        } catch (e) {
            logger.warn({ channelId: id, err: e.message }, '[waqr] restore failed');
        }
    }
    return count;
}

/**
 * Bind shared deps (redis client + amqp confirm channel + company id) onto a
 * session so inbound handling can publish to the broker.
 */
function bindDeps(channelId, { redis, amqpChannel, companyId }) {
    const state = getState(channelId);
    state.redis = redis;
    state.amqpChannel = amqpChannel;
    if (companyId) state.companyId = companyId;
}

module.exports = { startSession, sendMessage, getStatus, disconnect, restoreAll, syncSession, bindDeps, getState, sessions };
