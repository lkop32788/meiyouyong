import { channelRoom } from './rooms.js';
import { fetchAgentChannels } from '../redis/publisher.js';

export const MANAGER_ROLES = new Set(['super_admin', 'admin', 'supervisor']);

/**
 * Sinkronkan channel room membership sebuah socket agent dengan assignment
 * terbaru dari Laravel (agent_channels).
 *
 * Dipanggil saat connect dan saat menerima AGENT_CHANNELS_UPDATED.
 * Fail-closed: fetch gagal / zero assignment → keluar dari semua channel room.
 *
 * @param {import('socket.io').Socket} socket
 * @returns {Promise<Set<string>>} channel IDs yang sekarang boleh diakses
 */
export async function syncAgentChannelRooms(socket) {
  const channelIds = await fetchAgentChannels(socket.data.agentId);
  const next = new Set(channelIds);
  const prev = socket.data.allowedChannels ?? new Set();

  let revoked = false;
  for (const id of prev) {
    if (!next.has(id)) {
      socket.leave(channelRoom(id));
      revoked = true;
    }
  }
  for (const id of next) {
    if (!prev.has(id)) socket.join(channelRoom(id));
  }

  // Ada channel yang dicabut → keluar dari SEMUA conversation room juga.
  // Kita tidak tahu conversation mana milik channel yang dicabut; frontend
  // akan re-join conversation aktif dan gate join:conversation yang memutuskan.
  if (revoked) {
    for (const room of socket.rooms) {
      if (room.startsWith('conv:')) socket.leave(room);
    }
  }

  socket.data.allowedChannels = next;
  return next;
}
