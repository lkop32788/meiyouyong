import { conversationRoom } from '../rooms.js';

/**
 * Handle event messaging dari client:
 *   typing:start, typing:stop, message:read, join:conversation, leave:conversation
 *
 * @param {import('socket.io').Socket} socket
 * @param {import('socket.io').Server} io
 * @param {import('redis').RedisClientType} redis
 * @param {import('pino').Logger} log
 */
export function registerMessagingHandler(socket, io, redis, log) {
  const { agentId, companyId, role } = socket.data;

  // ── typing:start ──────────────────────────────────────────────────────────
  socket.on('typing:start', async ({ conversationId } = {}) => {
    if (!conversationId) return;
    if (!await isAuthorized(redis, companyId, agentId, conversationId, role)) return;

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

    // Validasi company ownership via Redis conv state
    const state = await redis.hGetAll(`conv:state:${companyId}:${conversationId}`);
    if (!state || !state.status) {
      // State tidak ada di Redis — izinkan tetapi log
      log.debug({ agentId, conversationId }, 'join:conversation — no state in Redis, allowing');
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
 * Cek apakah agent berhak mengirim typing indicator ke conversation ini.
 * Supervisor/admin boleh semua. Agent biasa hanya jika di-assign ke conversation.
 */
async function isAuthorized(redis, companyId, agentId, conversationId, role) {
  if (role === 'supervisor' || role === 'admin') return true;

  const state = await redis.hGetAll(`conv:state:${companyId}:${conversationId}`);
  return state?.assigned_agent_id === agentId;
}
