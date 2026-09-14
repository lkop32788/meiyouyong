'use strict';

/**
 * WhatsApp Calling webhook — handles Meta Calls events that arrive on the same
 * webhook as messages, under entry[].changes[].value.calls[]:
 *   - event=connect   : SDP offer (customer called us) or SDP answer (we called)
 *   - event=terminate : call ended
 *   - event=accept/ring : progress events (logged only)
 *
 * AI voice routing:
 *   - inbound offer  → if an active default voice agent exists, the gateway
 *                      answers with the AI bridge (werift + realtime engine)
 *   - outbound answer → completes a parked business-initiated AI bridge
 */

const { Router } = require('express');
const { verifyWhatsApp } = require('../middleware/verifySignature');
const { lookupChannelByEndpoint } = require('../services/channelResolver');
const { getSqlPool } = require('../lib/sqlPool');
const voiceBridge = require('../services/aiVoiceBridge');

const router = Router();

// Call events ride the standard WhatsApp webhook path
router.route('/:channelId')
    .get(verifyWhatsApp)
    .post(verifyWhatsApp, handleWebhook);

async function handleWebhook(req, res) {
    const { redis, logger } = res.locals;

    // ACK first — Meta retries after ~20s without a 200
    res.sendStatus(200);

    try {
        const entries = req.body?.entry || [];
        const callValues = [];
        for (const entry of entries) {
            for (const change of entry.changes || []) {
                const value = change.value;
                if (value?.calls?.length) callValues.push(value);
            }
        }
        if (!callValues.length) return;

        for (const value of callValues) {
            const phoneNumberId = value.metadata?.phone_number_id;
            if (!phoneNumberId) continue;

            const channel = await lookupChannelByEndpoint('whatsapp', phoneNumberId, redis);
            if (!channel) {
                logger.warn({ phoneNumberId }, '[calls] unknown channel for call event');
                continue;
            }

            for (const call of value.calls || []) {
                await handleCallEvent({ call, channel, phoneNumberId, redis, logger }).catch((e) => {
                    logger.error({ err: e.message, callId: call.id }, '[calls] call event failed');
                });
            }
        }
    } catch (err) {
        logger.error({ err }, '[calls] fatal error processing call webhook');
    }
}

async function handleCallEvent({ call, channel, phoneNumberId, redis, logger }) {
    const { call_id: callId, event, from, to } = call;
    const sdp = call.session?.sdp;
    const sdpType = call.session?.sdp_type || call.session?.type || '';

    logger.info({ callId, event, sdpType, direction: call.direction }, '[calls] event');

    if (event === 'connect' && sdp) {
        const isInbound = sdpType !== 'answer';
        if (isInbound) {
            // Customer called us — decide whether the AI should answer
            const agent = await resolveVoiceAgent(redis, channel.company_id);
            if (agent) {
                const sessionId = await createCallSession(redis, {
                    companyId: channel.company_id,
                    channelId: channel.channel_id,
                    agentId: agent.id,
                    callId,
                    fromNumber: from || '',
                    direction: 'user_initiated',
                });
                const result = await voiceBridge.startInbound({
                    callId,
                    offerSdp: sdp,
                    from: from || '',
                    sessionId,
                    companyId: channel.company_id,
                    agent,
                    access_token: await channelAccessToken(redis, channel.channel_id),
                    phone_number_id: phoneNumberId,
                    realtime_api_key: agent.realtime_api_key || process.env.OPENAI_API_KEY || '',
                    summary_enabled: agent.summary_enabled !== false,
                    summary_key: process.env.AI_API_KEY || '',
                    summary_base: summaryBase(),
                    summary_model: process.env.AI_MODEL || 'gpt-4o-mini',
                    backend: { redis, logger, sessionId, companyId: channel.company_id, agentId: agent.id, callId },
                    deps: { redis, logger },
                });
                if (result.ok) {
                    logger.info({ callId }, '[calls] AI voice bridge started (inbound)');
                } else {
                    logger.error({ callId, err: result.error }, '[calls] AI bridge failed to start');
                    await createCallSession(redis, {
                        companyId: channel.company_id, channelId: channel.channel_id, agentId: agent.id,
                        callId, fromNumber: from || '', direction: 'user_initiated', status: 'failed', error: result.error,
                    });
                }
                return;
            }
            // No AI agent — session row for the (future) browser softphone path
            await createCallSession(redis, {
                companyId: channel.company_id, channelId: channel.channel_id,
                callId, fromNumber: from || '', direction: 'user_initiated', status: 'incoming',
            });
            return;
        }

        // sdp_type=answer → reply to our business-initiated offer
        const completed = await voiceBridge.completeOutbound(callId, sdp).catch((e) => {
            logger.error({ callId, err: e.message }, '[calls] completeOutbound failed');
            return false;
        });
        if (completed) {
            await updateSessionStatus(redis, { callId, status: 'ai-connected' });
            logger.info({ callId }, '[calls] outbound AI bridge completed');
        } else {
            await updateSessionStatus(redis, { callId, status: 'connecting', patch: { note: 'answer sdp received (no ai bridge)' } });
        }
        return;
    }

    if (event === 'terminate') {
        voiceBridge.stop(callId);
        await updateSessionStatus(redis, { callId, status: 'terminated', ended: true });
        return;
    }

    // accept / ring / other progress events
    if (event && call.status) {
        await updateSessionStatus(redis, { callId, status: mapStatus(call, event) });
    }
}

function mapStatus(call, event) {
    if (event === 'accept') return 'accepted';
    if (event === 'ring' || call.status === 'RINGING') return 'ringing';
    return call.status?.toLowerCase() || 'progressing';
}

// ── Backend lookups (direct SQL via the gateway's existing pool) ──────────────

// The default active voice agent for a company. decrypted keys are fetched from
// the backend via HTTP to keep crypto logic in one place.
async function resolveVoiceAgent(redis, companyId) {
    try {
        const base = process.env.BACKEND_INTERNAL_URL || 'http://127.0.0.1:8000';
        const key = process.env.BACKEND_INTERNAL_KEY || process.env.INTERNAL_API_KEY || '';
        const r = await fetch(`${base}/internal/voice/resolve-agent?company_id=${companyId}`, {
            headers: { 'X-Internal-Key': key },
        });
        if (!r.ok) return null;
        const body = await r.json();
        return body?.data || null;
    } catch {
        return null;
    }
}

async function channelAccessToken(redis, channelId) {
    const pool = getSqlPool();
    // credentials are stored as an encrypted JSON blob by the backend; the
    // gateway shares APP_KEY so it can decrypt with the same AES-256-GCM scheme
    const [rows] = await pool.query(
        `SELECT credentials_encrypted FROM channels WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
        [channelId]
    );
    const blob = rows[0]?.credentials_encrypted;
    if (!blob) return '';
    try {
        const creds = JSON.parse(decryptLaravel(blob));
        return creds.access_token || '';
    } catch {
        return '';
    }
}

// Decrypt a Laravel Crypt::encryptString payload.
// Payload = base64( JSON {iv, value, mac, tag?} ) — AES-256-CBC + HMAC-SHA256
// (mac = hex hmac(iv_b64 + value_b64, APP_KEY)) or AES-256-GCM when tag present.
function decryptLaravel(payload) {
    const crypto = require('crypto');
    const appKeyBase64 = process.env.APP_KEY || '';
    if (!appKeyBase64.startsWith('base64:')) throw new Error('APP_KEY not base64');
    const appKey = Buffer.from(appKeyBase64.slice(7), 'base64');

    const env = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    const iv = Buffer.from(env.iv, 'base64');
    const ct = Buffer.from(env.value, 'base64');

    let plain;
    if (env.tag) {
        // GCM path
        const decipher = crypto.createDecipheriv('aes-256-gcm', appKey, iv);
        decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
        plain = Buffer.concat([decipher.update(ct), decipher.final()]);
    } else {
        // CBC path — verify HMAC over base64(iv)+base64(value)
        const mac = crypto.createHmac('sha256', appKey).update(env.iv + env.value).digest('hex');
        if (mac !== env.mac) throw new Error('MAC mismatch');
        const decipher = crypto.createDecipheriv('aes-256-cbc', appKey, iv);
        plain = Buffer.concat([decipher.update(ct), decipher.final()]);
    }
    return plain.toString('utf8');
}

// Create a call session row via the backend internal API (keeps model logic there)
async function createCallSession(redis, { companyId, channelId, agentId, callId, fromNumber, toNumber, direction, status, error }) {
    try {
        const base = process.env.BACKEND_INTERNAL_URL || 'http://127.0.0.1:8000';
        const key = process.env.BACKEND_INTERNAL_KEY || process.env.INTERNAL_API_KEY || '';
        const r = await fetch(`${base}/internal/voice/sessions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Internal-Key': key },
            body: JSON.stringify({
                company_id: companyId, channel_id: channelId, voice_agent_id: agentId,
                call_id: callId, from_number: fromNumber, to_number: toNumber,
                direction: direction || 'user_initiated', status: status || 'initiating', error: error || null,
                started: true,
            }),
        });
        if (r.ok) {
            const body = await r.json().catch(() => null);
            return body?.data?.id || null;
        }
    } catch { /* best-effort */ }
    return null;
}

async function updateSessionStatus(redis, { callId, status, patch, ended }) {
    try {
        const base = process.env.BACKEND_INTERNAL_URL || 'http://127.0.0.1:8000';
        const key = process.env.BACKEND_INTERNAL_KEY || process.env.INTERNAL_API_KEY || '';
        await fetch(`${base}/internal/voice/session-status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Internal-Key': key },
            body: JSON.stringify({ call_id: callId, status, ended: !!ended, ...patch }),
        });
    } catch { /* best-effort */ }
}

module.exports = router;
