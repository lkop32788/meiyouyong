import { conversationRoom } from '../rooms.js';
import { MANAGER_ROLES } from '../channelRooms.js';
import { fetchConversationState } from '../../redis/publisher.js';

/**
 * Handle event messaging dari client:
 *   typing:start, typing:stop, message:read, join:conversation, leave:conversation
 *
 * Semua akses conversation di-gate oleh canAccessConversation() — fail-closed:
 * state tidak ditemukan (termasuk conversation milik company lain) → tolak;
 * role agent → channel conversation harus ada di assignment-nya.
 *
 * @param {import('socket.io').Socket} socket
 * @param {import('socket.io').Server} io
 * @param {import('redis').RedisClientType} redis
 * @param {import('pino').Logger} log
 */
export function registerMessagingHandler(socket, io, redis, log) {
  const { agentId, companyId } = socket.data;

  // ── typing:start ──────────────────────────────────────────────────────────
  socket.on('typing:start', async ({ conversationId } = {}) => {
    if (!conversationId) return;
    if (!await canAccessConversation(redis, socket.data, conversationId)) return;

    await redis.set(
      `typing:${companyId}:${conversationId}:${agentId}`,
      '1',
      { EX: 5 }
    );

    io.to(conversationRoom(conversationId))
      .except(socket.id)
      .emit('typing:start', { agentId, conversationId });
  });

  // ── typing:stop ───────────────────────────────────────────────────────────
  socket.on('typing:stop', async ({ conversationId } = {}) => {
    if (!conversationId) return;

    await redis.del(`typing:${companyId}:${conversationId}:${agentId}`);

    io.to(conversationRoom(conversationId))
      .except(socket.id)
      .emit('typing:stop', { agentId, conversationId });
  });

  // ── message:read ──────────────────────────────────────────────────────────
  socket.on('message:read', async ({ conversationId, lastReadMessageId } = {}) => {
    if (!conversationId || !lastReadMessageId) return;
    if (!await canAccessConversation(redis, socket.data, conversationId)) return;

    // Publish ke Laravel via Redis untuk update unread_count di SQL
    await redis.publish('dispatcher:requests', JSON.stringify({
      action:              'MARK_READ',
      company_id:          companyId,
      conversation_id:     conversationId,
      agent_id:            agentId,
      last_read_message_id: lastReadMessageId,
    }));

    // Sinkronisasi multi-tab
    io.to(conversationRoom(conversationId))
      .emit('message:read', { agentId, conversationId, lastReadMessageId });
  });

  // ── join:conversation ─────────────────────────────────────────────────────
  socket.on('join:conversation', async ({ conversationId } = {}) => {
    if (!conversationId) return;

    if (!await canAccessConversation(redis, socket.data, conversationId)) {
      log.warn({ agentId, conversationId }, 'join:conversation denied');
      socket.emit('join:denied', { conversationId });
      return;
    }

    socket.join(conversationRoom(conversationId));
    socket.emit('joined:conversation', { conversationId });
  });

  // ── leave:conversation ────────────────────────────────────────────────────
  socket.on('leave:conversation', ({ conversationId } = {}) => {
    if (conversationId) {
      socket.leave(conversationRoom(conversationId));
    }
  });

  // ── auth:refresh (JWT refresh dari frontend) ──────────────────────────────
  socket.on('auth:refresh', async ({ token } = {}) => {
    if (!token) {
      socket.emit('auth:error', { message: 'No token provided' });
      return;
    }

    try {
      const jwt     = await import('jsonwebtoken');
      const { config } = await import('../../config/index.js');
      const payload = jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'] });

      socket.data.agentId   = payload.sub;
      socket.data.companyId = payload.company_id;
      socket.data.role      = payload.role;
      socket.data.skillTags = payload.skill_tags ?? [];

      log.debug({ agentId }, 'JWT refreshed on socket');
    } catch {
      socket.emit('auth:error', { message: 'Invalid token' });
      socket.disconnect(true);
    }
  });
}

// ── Helper ────────────────────────────────────────────────────────────────────

/**
 * Apakah socket ini boleh mengakses conversation tersebut?
 *
 * 1. Ambil conv:state dari Redis; miss (atau state lama tanpa channel_id)
 *    → fallback ke Laravel internal API, yang juga rebuild cache-nya.
 * 2. State tetap tidak ada → TOLAK (conversation tidak ada / company lain).
 * 3. Manager (supervisor+) → boleh semua conversation company-nya.
 * 4. Agent → channel_id conversation harus ada di assignment socket ini.
 */
async function canAccessConversation(redis, socketData, conversationId) {
  const { companyId, role, allowedChannels } = socketData;

  let state = await redis.hGetAll(`conv:state:${companyId}:${conversationId}`);

  const stale = !state?.status || (role === 'agent' && !state.channel_id);
  if (stale) {
    state = await fetchConversationState(companyId, conversationId);
  }

  if (!state?.status) return false;

  if (MANAGER_ROLES.has(role)) return true;
  if (role !== 'agent') return false;

  const channelId = state.channel_id;
  if (!channelId) return false;

  return (allowedChannels ?? new Set()).has(channelId);
}
