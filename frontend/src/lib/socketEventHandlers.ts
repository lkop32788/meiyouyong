import { Socket } from 'socket.io-client';
import toast from 'react-hot-toast';
import { useInboxStore } from '../stores/useInboxStore';
import { useConversationStore } from '../stores/useConversationStore';
import { usePresenceStore } from '../stores/usePresenceStore';
import { useSocketStore } from '../stores/useSocketStore';
import { useAuthStore } from '../stores/useAuthStore';
import type { Message } from '../types';

/**
 * Daftarkan semua socket event listener.
 * Dipanggil sekali setelah socket berhasil connect.
 * Kembalikan cleanup function untuk remove listener.
 */
export function registerSocketHandlers(socket: Socket): () => void {
  const inbox        = useInboxStore.getState();
  const conversation = useConversationStore.getState();
  const presence     = usePresenceStore.getState();
  const socketStore  = useSocketStore.getState();
  const auth         = useAuthStore.getState();

  // ── Inbox ─────────────────────────────────────────────────────────────────
  const onInboxUpdate = (data: { conversationId: string; preview: string; timestamp: string; direction: string }) => {
    inbox.upsertConversation({
      id:                   data.conversationId,
      lastMessagePreview:   data.preview,
      lastMessageAt:        data.timestamp,
      lastMessageDirection: data.direction as Message['direction'],
    });
    if (data.conversationId !== useConversationStore.getState().activeConversationId) {
      inbox.incrementUnread(data.conversationId);
    }
  };

  const onInboxAssigned = (data: { conversation_id: string; agent_id: string }) => {
    inbox.upsertConversation({ id: data.conversation_id, assignedAgentId: data.agent_id });
  };

  const onInboxResolved = (data: { conversationId: string }) => {
    const filter = useInboxStore.getState().activeFilter;
    if (['mine', 'all'].includes(filter)) {
      inbox.removeConversation(data.conversationId);
    } else {
      inbox.upsertConversation({ id: data.conversationId, status: 'resolved' });
    }
  };

  const onInboxReopened = (data: { conversation_id: string }) => {
    inbox.upsertConversation({ id: data.conversation_id, status: 'open' });
  };

  // ── Messages ──────────────────────────────────────────────────────────────
  const onMessageNew = (data: Message) => {
    if (data.conversationId !== useConversationStore.getState().activeConversationId) return;
    conversation.appendMessage(data);
  };

  const onMessageStatus = (data: { messageId: string; status: Message['status'] }) => {
    conversation.updateMessageStatus(data.messageId, data.status);
  };

  // ── Typing ────────────────────────────────────────────────────────────────
  const onTypingStart = (data: { agentId: string; conversationId: string }) => {
    if (data.conversationId !== useConversationStore.getState().activeConversationId) return;
    conversation.setTypingAgent(data.agentId, true);
  };

  const onTypingStop = (data: { agentId: string; conversationId: string }) => {
    if (data.conversationId !== useConversationStore.getState().activeConversationId) return;
    conversation.setTypingAgent(data.agentId, false);
  };

  let contactTypingTimer: ReturnType<typeof setTimeout> | null = null;
  const onContactTyping = (data: { conversationId: string }) => {
    if (data.conversationId !== useConversationStore.getState().activeConversationId) return;
    conversation.setContactTyping(true);
    if (contactTypingTimer) clearTimeout(contactTypingTimer);
    contactTypingTimer = setTimeout(() => conversation.setContactTyping(false), 3000);
  };

  // ── Presence ──────────────────────────────────────────────────────────────
  const onAgentOnline  = (data: { agentId: string }) => presence.setOnline(data.agentId);
  const onAgentOffline = (data: { agentId: string }) => presence.setOffline(data.agentId);
  const onAgentStatus  = (data: { agentId: string; status: 'online' | 'offline' | 'busy' | 'away' }) =>
    presence.updateStatus(data.agentId, data.status);

  // ── Channel status (auto health watchdog) ─────────────────────────────
  const onChannelStatus = (data: { channel_name: string; health: string; reason?: string | null; deactivated?: boolean }) => {
    if (data.deactivated) {
      toast.error(`渠道「${data.channel_name}」异常已自动停用：${data.reason ?? '未知原因'}`, { duration: 8000 });
    } else if (data.health === 'down') {
      toast.error(`渠道「${data.channel_name}」连接异常：${data.reason ?? '未知原因'}`, { duration: 6000 });
    } else if (data.health === 'healthy') {
      toast.success(`渠道「${data.channel_name}」已恢复`);
    }
  };

  // ── Personal notifications ───────────────────────────────────────────────
  const onConversationAssigned = (data: { conversation_id: string; contact_name?: string }) => {
    toast.success(`Percakapan baru: ${data.contact_name ?? 'Tanpa nama'}`);
    inbox.upsertConversation({ id: data.conversation_id });

    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      new Notification('Percakapan baru masuk', { body: data.contact_name ?? '' });
    }
  };

  // ── Connection ────────────────────────────────────────────────────────────
  const onConnect = () => {
    socketStore.setConnected(true);
    // Re-join conversation room setelah reconnect
    const activeId = useConversationStore.getState().activeConversationId;
    if (activeId) socket.emit('join:conversation', { conversationId: activeId });
  };

  const onDisconnect = (reason: string) => {
    socketStore.setConnected(false);
    console.warn('[Socket] Disconnected:', reason);
  };

  const onConnectError = async (err: Error) => {
    if (err.message === 'UNAUTHORIZED') {
      try {
        const newToken = await auth.refreshSocketToken();
        (socket.auth as Record<string, string>).token = newToken;
        socket.connect();
      } catch {
        auth.logout();
      }
    }
  };

  // ── App-level heartbeat ───────────────────────────────────────────────────
  const heartbeatInterval = setInterval(() => {
    if (socket.connected) socket.emit('heartbeat');
  }, 30_000);

  // Register all listeners
  socket.on('inbox:update',            onInboxUpdate);
  socket.on('channel:status',          onChannelStatus);
  socket.on('inbox:assigned',          onInboxAssigned);
  socket.on('inbox:resolved',          onInboxResolved);
  socket.on('inbox:reopened',          onInboxReopened);
  socket.on('message:new',             onMessageNew);
  socket.on('message:status',          onMessageStatus);
  socket.on('typing:start',            onTypingStart);
  socket.on('typing:stop',             onTypingStop);
  socket.on('contact:typing',          onContactTyping);
  socket.on('agent:online',            onAgentOnline);
  socket.on('agent:offline',           onAgentOffline);
  socket.on('agent:status',            onAgentStatus);
  socket.on('conversation:assigned',   onConversationAssigned);
  socket.on('connect',                 onConnect);
  socket.on('disconnect',              onDisconnect);
  socket.on('connect_error',           onConnectError);

  // Cleanup function
  return () => {
    clearInterval(heartbeatInterval);
    if (contactTypingTimer) clearTimeout(contactTypingTimer);
    socket.off('inbox:update',          onInboxUpdate);
    socket.off('inbox:assigned',        onInboxAssigned);
    socket.off('inbox:resolved',        onInboxResolved);
    socket.off('inbox:reopened',        onInboxReopened);
    socket.off('message:new',           onMessageNew);
    socket.off('message:status',        onMessageStatus);
    socket.off('typing:start',          onTypingStart);
    socket.off('typing:stop',           onTypingStop);
    socket.off('contact:typing',        onContactTyping);
    socket.off('agent:online',          onAgentOnline);
    socket.off('agent:offline',         onAgentOffline);
    socket.off('agent:status',          onAgentStatus);
    socket.off('conversation:assigned', onConversationAssigned);
    socket.off('connect',               onConnect);
    socket.off('disconnect',            onDisconnect);
    socket.off('connect_error',         onConnectError);
  };
}
