'use strict';

/**
 * Facebook (Messenger) Route Handler
 *
 * Same "200 OK fast" principle as WhatsApp: Meta retries when no 200 arrives
 * within ~20 seconds. Signature: X-Hub-Signature-256 HMAC-SHA256 over the raw
 * body using the FACEBOOK_APP_SECRET (app-level, not per-channel — Messenger
 * webhooks are configured once per Meta App with page-level routing below).
 *
 * Payload shape (page object):
 *   entry[].id = page_id → resolves the channel via settings.page_id
 *   entry[].messaging[].sender.id = PSID
 *   entry[].messaging[].message.text
 *   entry[].messaging[].postback.payload (button clicks)
 */

const { Router } = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const { ContentType } = require('../lib/canonicalSchema');
const { lookupChannelByFacebookPage } = require('../services/channelResolver');
const { publishIfNotDuplicate } = require('../services/publisher');

const router = Router();

// GET — hub verification (Meta webhook setup: Verify & Save)
router.get('/hub', (req, res) => {
    const { logger } = res.locals;
    const mode      = req.query['hub.mode'];
    const token     = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token && token === (process.env.FB_VERIFY_TOKEN || process.env.WA_VERIFY_TOKEN)) {
        logger.info('Facebook webhook challenge verified');
        return res.status(200).send(challenge);
    }
    return res.status(403).json({ error: 'Verification failed' });
});

// POST — actual messaging events
router.post('/hub', async (req, res) => {
    const { redis, amqpChannel, logger } = res.locals;

    // App-level signature check (X-Hub-Signature-256, key = app secret)
    const signature = req.headers['x-hub-signature-256'];
    const appSecret = process.env.FACEBOOK_APP_SECRET || '';
    if (appSecret && signature) {
        const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(req.rawBody).digest('hex');
        const a = Buffer.from(signature);
        const b = Buffer.from(expected);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
            logger.warn('Facebook signature mismatch');
            return res.status(401).json({ error: 'Invalid signature' });
        }
    } else if (!signature && appSecret) {
        return res.status(401).json({ error: 'Missing signature' });
    }
    // No app secret configured → accept but log (dev mode); tighten in prod.

    // 200 OK immediately — process async
    res.sendStatus(200);

    try {
        const entries = req.body?.entry || [];
        for (const entry of entries) {
            const pageId = entry.id;
            const channelInfo = await lookupChannelByFacebookPage(pageId, redis);
            if (!channelInfo) {
                logger.warn({ pageId }, 'Unknown/inactive Facebook page, discarding');
                continue;
            }

            for (const evt of entry.messaging || []) {
                // Skip delivery/read/echo events
                if (evt.delivery || evt.read || evt.message?.is_echo) continue;

                const senderId = evt.sender?.id;
                if (!senderId) continue;

                const isPostback = !!evt.postback;
                const text = evt.message?.text || evt.postback?.title || evt.postback?.payload || '';
                const attachments = evt.message?.attachments || [];
                if (!text && attachments.length === 0) continue;

                let canonical;
                const base = {
                    event_id:            uuidv4(),
                    company_id:          channelInfo.company_id,
                    channel_id:          channelInfo.channel_id,
                    channel_type:        'facebook',
                    direction:           'inbound',
                    idempotency_key:     evt.message?.mid || `fb_${entry.time}_${senderId}_${uuidv4()}`,
                    sender_external_id:  senderId,
                    sender_name:         null, // backend can enrich via Graph API
                    sender_avatar:       null,
                    quoted_message_id:   evt.message?.reply_to?.mid || null,
                    conversation_ref_id: null,
                    provider_timestamp:  new Date(entry.time || Date.now()).toISOString(),
                    received_at:         new Date().toISOString(),
                    raw_payload:         evt,
                };

                if (attachments.length > 0 && !text) {
                    const a = attachments[0];
                    const type = a.type === 'image' ? ContentType.IMAGE
                        : a.type === 'video' ? ContentType.VIDEO
                        : a.type === 'audio' ? ContentType.AUDIO
                        : ContentType.FILE;
                    canonical = {
                        ...base,
                        content_type: type,
                        content: {
                            provider_media_id: a.payload?.url || null,
                            mime_type: a.payload?.url ? null : null,
                            caption: null,
                        },
                    };
                    if (isPostback) {
                        canonical = { ...base, content_type: ContentType.BUTTON_REPLY, content: { button_id: evt.postback.payload, button_text: evt.postback.title || '' } };
                    }
                } else if (isPostback) {
                    canonical = { ...base, content_type: ContentType.BUTTON_REPLY, content: { button_id: evt.postback.payload, button_text: evt.postback.title || '' } };
                } else {
                    canonical = { ...base, content_type: ContentType.TEXT, content: { body: text } };
                }

                try {
                    await publishIfNotDuplicate(canonical, amqpChannel, redis, logger);
                } catch (e) {
                    logger.error({ err: e.message, pageId }, 'Facebook publish failed');
                }
            }

            logger.info({ pageId, company_id: channelInfo.company_id, events: (entry.messaging || []).length }, 'Facebook webhook processed');
        }
    } catch (err) {
        logger.error({ err }, 'Fatal error processing Facebook webhook');
    }
});

module.exports = router;
