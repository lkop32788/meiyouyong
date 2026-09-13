import { companyRoom, conversationRoom, agentRoom } from '../socket/rooms.js';

/**
 * Satu subscriber Redis per company yang aktif.
 * Saat agent pertama company X connect → subscribe channel:events:{companyId}
 * Saat semua agent company X disconnect → unsubscribe
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
      await this.#subClient.subscribe(channel, (message) => this.#route(companyId, message));
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

  #route(companyId, rawMessage) {
    let event;
    try {
      event = JSON.parse(rawMessage);
    } catch {
      this.#log.warn({ companyId }, 'Failed to parse Redis event');
      return;
    }

    const io = this.#io;

    switch (event.type) {
      case 'NEW_MESSAGE':
        io.to(conversationRoom(event.payload.conversation_id))
          .emit('message:new', event.payload);

        io.to(companyRoom(companyId))
          .emit('inbox:update', {
            conversationId:      event.payload.conversation_id,
            preview:             event.payload.preview,
            direction:           event.payload.direction,
            timestamp:           event.payload.timestamp,
            unreadIncrement:     1,
          });
        break;

      case 'CONVERSATION_ASSIGNED':
        io.to(agentRoom(event.payload.agent_id))
          .emit('conversation:assigned', event.payload);

        io.to(companyRoom(companyId))
          .emit('inbox:assigned', event.payload);
        break;

      case 'CONVERSATION_RESOLVED':
        io.to(companyRoom(companyId))
          .emit('inbox:resolved', { conversationId: event.payload.conversation_id });

        io.to(conversationRoom(event.payload.conversation_id))
          .emit('conversation:resolved', event.payload);
        break;

      case 'CONVERSATION_REOPENED':
        io.to(companyRoom(companyId))
          .emit('inbox:reopened', event.payload);
        break;

      case 'MESSAGE_STATUS_UPDATE':
        io.to(conversationRoom(event.payload.conversation_id ?? ''))
          .emit('message:status', {
            messageId: event.payload.message_id,
            status:    event.payload.status,
          });
        break;

      case 'AGENT_TYPING':
        io.to(conversationRoom(event.payload.conversation_id))
          .emit('contact:typing', event.payload);
        break;

      case 'CHANNEL_STATUS_CHANGED':
        io.to(companyRoom(companyId))
          .emit('channel:status', event.payload);
        break;

      default:
        this.#log.debug({ companyId, type: event.type }, 'Unknown event type — ignored');
    }
  }
}
