'use strict';

/**
 * Channel Resolver Service
 *
 * Memetakan {channelType, channelId dari URL} → {company_id, channel_id di DB}
 *
 * URL webhook: /webhook/whatsapp/:channelId
 * channelId = UUID internal dari tabel channels (paling aman).
 * Alternatif: nomor telepon WA / LINE bot ID → di-resolve via settings JSON.
 *
 * CACHING: channel config jarang berubah → Redis cache TTL 5 menit.
 * Cache di-invalidasi via POST /internal/cache/invalidate/channel dari Core API.
 */

const { channelMetaKey } = require('../lib/redisKeys');
const { getSqlPool } = require('../lib/sqlPool');

const CACHE_TTL = 300; // 5 menit

/**
 * Resolve channel dari URL param ke info internal.
 *
 * @param {string} channelType
 * @param {string} channelIdentifier  - UUID dari URL atau identifier lain
 * @param {import('redis').RedisClientType} redis
 * @returns {Promise<{ channel_id: string, company_id: string, channel_type: string, is_active: boolean }|null>}
 */
async function lookupChannelByEndpoint(channelType, channelIdentifier, redis) {
    const cacheKey = channelMetaKey(channelType, channelIdentifier);

    // 1. Redis cache
    const cached = await redis.get(cacheKey);
    if (cached) {
        const data = JSON.parse(cached);
        return data.is_active ? data : null;
    }

    // 2. SQL Server lookup
    const channelInfo = await queryChannelFromDB(channelType, channelIdentifier);
    if (!channelInfo) return null;

    const payload = {
        channel_id:   channelInfo.id,
        company_id:   channelInfo.company_id,
        channel_type: channelType,
        is_active:    Boolean(channelInfo.is_active),
    };

    // Cache hasil (aktif maupun tidak — agar DB tidak kena flood)
    await redis.set(cacheKey, JSON.stringify(payload), { EX: CACHE_TTL });

    return payload.is_active ? payload : null;
}

/**
 * Invalidate channel cache.
 * Dipanggil dari Core API (Laravel) via endpoint internal ketika admin update config.
 */
async function invalidateChannelCache(channelType, channelIdentifier, redis) {
    await redis.del(channelMetaKey(channelType, channelIdentifier));
}

// ── SQL Query ──────────────────────────────────────────────────────────────

async function queryChannelFromDB(channelType, channelIdentifier) {
    const pool = getSqlPool();

    // Coba dua strategi lookup:
    // 1. channelIdentifier adalah UUID langsung (id kolom)
    // 2. channelIdentifier adalah external identifier dari settings JSON
    const [rows] = await pool.query(
        `
            SELECT
                id,
                company_id,
                is_active
            FROM channels
            WHERE type       = ?
              AND deleted_at IS NULL
              AND (
                  -- Lookup by internal UUID
                  id = ?
                  OR
                  -- Lookup by external identifier in settings JSON
                  JSON_UNQUOTE(JSON_EXTRACT(settings, '$.channel_identifier')) = ?
                  OR
                  JSON_UNQUOTE(JSON_EXTRACT(settings, '$.phone_number')) = ?
                  OR
                  JSON_UNQUOTE(JSON_EXTRACT(settings, '$.bot_id')) = ?
              )
            LIMIT 1
        `,
        [channelType, channelIdentifier, channelIdentifier, channelIdentifier, channelIdentifier]
    );

    return rows[0] || null;
}

module.exports = { lookupChannelByEndpoint, invalidateChannelCache };
