import { companyRoom, channelRoom, conversationRoom, agentRoom } from '../socket/rooms.js';
import { syncAgentChannelRooms } from '../socket/channelRooms.js';

/**
 * Satu subscriber Redis per company yang aktif.
 * Saat agent pertama company X connect → subscribe channel:events:{companyId}
 * Saat semua agent company X disconnect → unsubscribe
 *
 * Routing isolasi channel:
 * - company room  = manager (supervisor+) saja → melihat semua channel
 * - channel room  = agent yang di-assign ke channel itu
 * Event dengan channel_id dikirim ke KEDUA room (Socket.io dedup per socket);
 * event tanpa channel_id (format lama) hanya ke company room agar tidak
 * bocor ke agent yang bukan pemilik channel (fail-closed).
 */
export class RedisEventSubscriber {
  /** @type {Map<string, number>} companyId → jumlah agent aktif */
  #agentCount = new Map();

  /** @type {import('redis').RedisClientType} */
  #subClient;

  /** @type {import('socket.io').Server} */
  #io;

  /** @type {import('pino').Logger} */
  #log;

  constructor(subClient, io, log) {
    this.#subClient = subClient;
    this.#io        = io;
    this.#log       = log;
  }

  /**
   * Panggil saat agent dari companyId baru connect.
   */
  async agentJoined(companyId) {
    const count = (this.#agentCount.get(companyId) ?? 0) + 1;
    this.#agentCount.set(companyId, count);

    if (count === 1) {
      // Agent pertama dari company ini — mulai subscribe
      const channel = `channel:events:${companyId}`;
      await this.#subClient.subscribe(channel, (message) => {
        this.#route(companyId, message).catch((err) =>
          this.#log.error({ companyId, err }, 'Failed to route Redis event')
        );
      });
      this.#log.info({ companyId }, 'Subscribed to Redis channel');
    }
  }

  /**
   * Panggil saat agent disconnect.
   */
  async agentLeft(companyId) {
    const count = Math.max(0, (this.#agentCount.get(companyId) ?? 1) - 1);
    this.#agentCount.set(companyId, count);

    if (count === 0) {
      const channel = `channel:events:${companyId}`;
      await this.#subClient.unsubscribe(channel).catch(() => {});
      this.#agentCount.delete(companyId);
      this.#log.info({ companyId }, 'Unsubscribed from Redis channel');
    }
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  /**
   * Room target untuk event level-inbox: manager (company room) + agent
   * channel ybs. Tanpa channel_id → company room saja (fail-closed).
   */
  #inboxRooms(companyId, channelId) {
    return channelId
      ? [companyRoom(companyId), channelRoom(channelId)]
      : [companyRoom(companyId)];
  }

  async #route(companyId, rawMessage) {
    let event;
    try {
      event = JSON.parse(rawMessage);
    } catch {
      this.#log.warn({ companyId }, 'Failed to parse Redis event');
      return;
    }

    const io = this.#io;
    const p  = event.payload ?? {};

    switch (event.type) {
      case 'NEW_MESSAGE':
        io.to(conversationRoom(p.conversation_id))
          .emit('message:new', p);

        io.to(this.#inboxRooms(companyId, p.channel_id))
          .emit('inbox:update', {
            conversationId:      p.conversation_id,
            channelId:           p.channel_id,
            channelType:         p.channel_type,
            senderName:          p.sender_name,
            assignedAgentId:     p.assigned_agent_id,
            preview:             p.preview,
            direction:           p.direction,
            timestamp:           p.timestamp,
            unreadIncrement:     1,
          });
        break;

      case 'CONVERSATION_ASSIGNED':
        io.to(agentRoom(p.agent_id))
          .emit('conversation:assigned', p);

        io.to(this.#inboxRooms(companyId, p.channel_id))
          .emit('inbox:assigned', p);
        break;

      case 'CONVERSATION_RESOLVED':
        io.to(this.#inboxRooms(companyId, p.channel_id))
          .emit('inbox:resolved', { conversationId: p.conversation_id });

        io.to(conversationRoom(p.conversation_id))
          .emit('conversation:resolved', p);
        break;

      case 'CONVERSATION_REOPENED':
        io.to(this.#inboxRooms(companyId, p.channel_id))
          .emit('inbox:reopened', p);
        break;

      case 'MESSAGE_STATUS_UPDATE':
        io.to(conversationRoom(p.conversation_id ?? ''))
          .emit('message:status', {
            messageId: p.message_id,
            status:    p.status,
          });
        break;

      case 'AGENT_TYPING':
        io.to(conversationRoom(p.conversation_id))
          .emit('contact:typing', p);
        break;

      case 'CHANNEL_STATUS_CHANGED':
        io.to(companyRoom(companyId))
          .emit('channel:status', p);
        break;

      case 'AGENT_CHANNELS_UPDATED':
        await this.#refreshAgentRooms(p.agent_id);
        break;

      default:
        this.#log.debug({ companyId, type: event.type }, 'Unknown event type — ignored');
    }
  }

  /**
   * Assignment channel agent berubah → re-sync room membership semua socket
   * milik agent itu (bisa multi-tab), lalu beri tahu frontend untuk reload.
   */
  async #refreshAgentRooms(agentId) {
    if (!agentId) return;

    for (const [, socket] of this.#io.of('/').sockets) {
      if (socket.data.agentId !== agentId || socket.data.role !== 'agent') continue;

      await syncAgentChannelRooms(socket);
      socket.emit('channels:updated', { agentId });
      this.#log.info({ agentId }, 'Agent channel rooms refreshed');
    }
  }
}
