import { companyRoom, agentRoom } from '../rooms.js';
import { MANAGER_ROLES, syncAgentChannelRooms } from '../channelRooms.js';
import { fetchAgentSkills, notifyAgentOffline } from '../../redis/publisher.js';
import { config } from '../../config/index.js';

/**
 * Kelola siklus koneksi/diskoneksi agent.
 *
 * @param {import('socket.io').Socket} socket
 * @param {import('socket.io').Server} io
 * @param {import('redis').RedisClientType} redis
 * @param {import('../../redis/subscriber.js').RedisEventSubscriber} subscriber
 * @param {import('pino').Logger} log
 */
export function registerConnectionHandler(socket, io, redis, subscriber, log) {
  const { agentId, companyId, role, skillTags } = socket.data;

  // ── Connect ──────────────────────────────────────────────────────────────

  (async () => {
    try {
      // 1. Join rooms sesuai role.
      //    Manager (supervisor+) → company room: melihat semua channel.
      //    Agent → HANYA channel room sesuai assignment (fail-closed, isolasi
      //    antar nomor WA) + personal room.
      if (MANAGER_ROLES.has(role)) {
        socket.join(companyRoom(companyId));
      } else {
        await syncAgentChannelRooms(socket);
      }
      socket.join(agentRoom(agentId));

      // 2. Simpan presence ke Redis
      const presenceKey = `agent:presence:${companyId}:${agentId}`;
      await redis.hSet(presenceKey, {
        status:         'online',
        socket_id:      socket.id,
        connected_at:   Date.now().toString(),
        last_heartbeat: Date.now().toString(),
        company_id:     companyId,
      });
      await redis.expire(presenceKey, config.presenceTtl);

      // 3. Tambahkan ke workload sorted set (NX = jangan overwrite jika sudah ada)
      await redis.zAdd(`agent:workload:${companyId}`, { NX: true, score: 0, value: agentId });

      // 4. Tambahkan ke skill sets dari Redis (cepat) atau fetch dari Laravel
      const skills = skillTags.length > 0 ? skillTags
        : (await fetchAgentSkills(agentId)).skill_tags;

      await Promise.all(skills.map(async (skill) => {
        const skillKey = `agent:skill:${companyId}:${skill}`;
        await redis.sAdd(skillKey, agentId);
        await redis.expire(skillKey, config.presenceTtl);
      }));

      // Store skills on socket.data for use in disconnect
      socket.data.skillTags = skills;

      // 5. Notify agen lain — presence list di UI
      io.to(companyRoom(companyId)).emit('agent:online', { agentId, timestamp: Date.now() });

      // 6. Subscribe ke Redis channel company ini (idempoten per company)
      await subscriber.agentJoined(companyId);

      // 7. Kirim initial state ke agent yang baru connect
      const onlineAgents = await getOnlineAgents(redis, companyId);
      socket.emit('init:state', { onlineAgents });

      log.info({ agentId, companyId, role }, 'Agent connected');
    } catch (err) {
      log.error({ agentId, err }, 'Error in connection handler');
    }
  })();

  // ── Disconnect ───────────────────────────────────────────────────────────

  // Tunggu 10 detik (grace period) — bisa jadi reconnect setelah network blip
  let offlineTimer = null;

  socket.on('disconnect', (reason) => {
    log.info({ agentId, companyId, reason }, 'Agent disconnecting (grace period)');

    offlineTimer = setTimeout(async () => {
      try {
        const presenceKey = `agent:presence:${companyId}:${agentId}`;
        await redis.del(presenceKey);

        // Hapus dari skill sets
        await Promise.all((socket.data.skillTags ?? []).map(
          (skill) => redis.sRem(`agent:skill:${companyId}:${skill}`, agentId)
        ));

        io.to(companyRoom(companyId)).emit('agent:offline', { agentId });

        // Notify Laravel untuk handle re-assignment
        await notifyAgentOffline(companyId, agentId);

        // Unsubscribe Redis jika tidak ada agent lain dari company ini
        await subscriber.agentLeft(companyId);

        log.info({ agentId, companyId }, 'Agent marked offline after grace period');
      } catch (err) {
        log.error({ agentId, err }, 'Error in disconnect handler');
      }
    }, config.offlineGracePeriod);
  });

  // Batalkan offline jika reconnect dalam grace period
  socket.on('connect', () => {
    if (offlineTimer) {
      clearTimeout(offlineTimer);
      offlineTimer = null;
      log.info({ agentId }, 'Agent reconnected within grace period');
    }
  });
}

// ── Helper ───────────────────────────────────────────────────────────────────

async function getOnlineAgents(redis, companyId) {
  const pattern = `agent:presence:${companyId}:*`;
  const keys    = [];

  // Scan semua presence keys untuk company ini
  for await (const key of redis.scanIterator({ MATCH: pattern, COUNT: 100 })) {
    keys.push(key);
  }

  if (keys.length === 0) return [];

  return Promise.all(keys.map(async (key) => {
    const data    = await redis.hGetAll(key);
    const agentId = key.split(':').pop();
    return { agentId, status: data.status ?? 'offline', lastSeen: data.last_heartbeat };
  }));
}
