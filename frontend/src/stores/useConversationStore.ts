import { create } from 'zustand';
import api from '../lib/api';
import { getSocket } from '../lib/socket';
import { useInboxStore } from './useInboxStore';
import type { Message, ConversationDetail } from '../types';

interface ConversationState {
  activeConversationId: string | null;
  detail: ConversationDetail | null;
  messages: Message[];
  isLoadingMessages: boolean;
  hasMoreMessages: boolean;
  oldestCursor: string | null;
  typingAgentIds: string[];
  contactIsTyping: boolean;

  openConversation: (id: string) => Promise<void>;
  closeConversation: () => void;
  loadOlderMessages: () => Promise<void>;
  sendMessage: (contentType: string, content: Record<string, unknown>, replyTo?: string) => Promise<void>;

  // Socket updates
  appendMessage: (msg: Message) => void;
  updateMessageStatus: (msgId: string, status: Message['status']) => void;
  setTypingAgent: (agentId: string, isTyping: boolean) => void;
  setContactTyping: (isTyping: boolean) => void;
}

/**
 * The API speaks snake_case; ConversationDetail is camelCase. This used to be
 * `detail: res.data` — axios types the body as `any`, so TypeScript accepted it
 * and every camelCase read (contactName, channelType, status, assignedAgentName)
 * silently came back undefined, blanking the whole conversation header.
 */
const mapDetail = (raw: Record<string, unknown>): ConversationDetail => ({
  id:                   raw.id as string,
  contactName:          raw.contact_name as string | null,
  contactAvatar:        raw.contact_avatar as string | null,
  channelType:          raw.channel_type as ConversationDetail['channelType'],
  lastMessagePreview:   raw.last_message_preview as string | null,
  lastMessageAt:        raw.last_message_at as string | null,
  lastMessageDirection: raw.last_message_direction as ConversationDetail['lastMessageDirection'],
  status:               raw.status as ConversationDetail['status'],
  unreadCount:          (raw.unread_count as number) ?? 0,
  assignedAgentId:      raw.assigned_agent_id as string | null,
  assignedAgentName:    raw.assigned_agent_name as string | null,
  priority:             (raw.priority as ConversationDetail['priority']) ?? 'normal',
  channelId:            raw.channel_id as string,
  channelName:          raw.channel_name as string | null,
  contactId:            raw.contact_id as string,
  contactEmail:         raw.contact_email as string | null,
  contactPhone:         raw.contact_phone as string | null,
  subject:              raw.subject as string | null,
  intentTags:           (raw.intent_tags as string[]) ?? [],
  messageCount:         (raw.message_count as number) ?? 0,
  firstResponseAt:      raw.first_response_at as string | null,
  resolvedAt:           raw.resolved_at as string | null,
  snoozedUntil:         raw.snoozed_until as string | null,
  createdAt:            raw.created_at as string | null,
});

const mapMsg = (raw: Record<string, unknown>): Message => ({
  id:                raw.id as string,
  conversationId:    raw.conversation_id as string,
  direction:         raw.direction as Message['direction'],
  senderType:        raw.sender_type as Message['senderType'],
  senderId:          raw.sender_id as string,
  contentType:       raw.content_type as string,
  content:           raw.content as Record<string, unknown>,
  status:            raw.status as Message['status'],
  providerMessageId: raw.provider_message_id as string | undefined,
  providerTimestamp: raw.provider_timestamp as string | null,
  quotedMessageId:   raw.quoted_message_id as string | null | undefined,
  isDeleted:         (raw.is_deleted as boolean) ?? false,
  createdAt:         raw.created_at as string | null,
});

export const useConversationStore = create<ConversationState>((set, get) => ({
  activeConversationId: null,
  detail:               null,
  messages:             [],
  isLoadingMessages:    false,
  hasMoreMessages:      false,
  oldestCursor:         null,
  typingAgentIds:       [],
  contactIsTyping:      false,

  openConversation: async (id) => {
    // Leave previous conversation room
    const prev = get().activeConversationId;
    if (prev && prev !== id) {
      getSocket().emit('leave:conversation', { conversationId: prev });
    }

    set({ activeConversationId: id, messages: [], isLoadingMessages: true });

    // Join new conversation room
    getSocket().emit('join:conversation', { conversationId: id });

    const [detailRes, msgRes] = await Promise.all([
      api.get(`/conversations/${id}`),
      api.get(`/conversations/${id}/messages`, { params: { limit: 30 } }),
    ]);

    const msgs = (msgRes.data.data as Record<string, unknown>[]).map(mapMsg);
    set({
      detail:            mapDetail(detailRes.data),
      messages:          msgs,
      isLoadingMessages: false,
      hasMoreMessages:   msgRes.data.has_more,
      oldestCursor:      msgs[0]?.id ?? null,
      typingAgentIds:    [],
      contactIsTyping:   false,
    });

    // Loading the first page zeroes unread_count server-side; mirror it locally
    // so the inbox badge clears now instead of at the next full reload.
    useInboxStore.getState().clearUnread(id);
  },

  closeConversation: () => {
    const id = get().activeConversationId;
    if (id) getSocket().emit('leave:conversation', { conversationId: id });
    set({ activeConversationId: null, detail: null, messages: [] });
  },

  loadOlderMessages: async () => {
    const { activeConversationId, oldestCursor, isLoadingMessages, hasMoreMessages } = get();
    if (!activeConversationId || !hasMoreMessages || isLoadingMessages) return;

    set({ isLoadingMessages: true });
    try {
      const { data } = await api.get(`/conversations/${activeConversationId}/messages`, {
        params: { limit: 30, before: oldestCursor },
      });
      const older = (data.data as Record<string, unknown>[]).map(mapMsg);
      set((s) => ({
        messages:        [...older, ...s.messages],
        hasMoreMessages: data.has_more,
        oldestCursor:    older[0]?.id ?? s.oldestCursor,
      }));
    } finally {
      set({ isLoadingMessages: false });
    }
  },

  sendMessage: async (contentType, content, replyTo) => {
    const id    = get().activeConversationId;
    if (!id) return;

    const tempId = `temp_${Date.now()}`;
    const optimistic: Message = {
      id:                tempId,
      tempId,
      conversationId:    id,
      direction:         'outbound',
      senderType:        'agent',
      senderId:          '',
      contentType,
      content,
      status:            'pending',
      providerTimestamp: new Date().toISOString(),
      isDeleted:         false,
      createdAt:         new Date().toISOString(),
    };

    set((s) => ({ messages: [...s.messages, optimistic] }));

    try {
      const { data } = await api.post(`/conversations/${id}/messages`, {
        content_type:               contentType,
        content,
        reply_to_provider_msg_id:   replyTo,
      });

      // Replace temp message dengan real message dari server
      set((s) => ({
        messages: s.messages.map((m) =>
          m.tempId === tempId ? mapMsg(data.message) : m
        ),
      }));
    } catch {
      set((s) => ({
        messages: s.messages.map((m) =>
          m.tempId === tempId ? { ...m, status: 'failed' as const } : m
        ),
      }));
    }
  },

  appendMessage: (msg) =>
    set((s) => ({ messages: [...s.messages, msg] })),

  updateMessageStatus: (msgId, status) =>
    set((s) => ({
      messages: s.messages.map((m) =>
        (m.id === msgId || m.providerMessageId === msgId) ? { ...m, status } : m
      ),
    })),

  setTypingAgent: (agentId, isTyping) =>
    set((s) => ({
      typingAgentIds: isTyping
        ? [...new Set([...s.typingAgentIds, agentId])]
        : s.typingAgentIds.filter((id) => id !== agentId),
    })),

  setContactTyping: (isTyping) => set({ contactIsTyping: isTyping }),
}));
