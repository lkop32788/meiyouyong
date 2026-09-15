import { create } from 'zustand';
import api from '../lib/api';
import type { ConversationSummary } from '../types';

type InboxFilter = 'mine' | 'all' | 'unassigned' | 'pending';

interface InboxState {
  conversations: ConversationSummary[];
  activeFilter: InboxFilter;
  searchQuery: string;
  isLoading: boolean;
  hasMore: boolean;
  cursor: string | null;

  loadInitial: () => Promise<void>;
  loadMore: () => Promise<void>;
  applyFilter: (filter: InboxFilter) => void;
  setSearch: (query: string) => void;

  // Socket updates
  upsertConversation: (update: Partial<ConversationSummary> & { id: string }) => void;
  removeConversation: (id: string) => void;
  incrementUnread: (id: string) => void;
  clearUnread: (id: string) => void;
  setAssignee: (id: string, agentId: string | null, agentName: string | null) => void;
}

const mapConv = (raw: Record<string, unknown>): ConversationSummary => ({
  id:                   raw.id as string,
  contactName:          raw.contact_name as string | null,
  contactAvatar:        raw.contact_avatar as string | null,
  channelType:          raw.channel_type as ConversationSummary['channelType'],
  lastMessagePreview:   raw.last_message_preview as string | null,
  lastMessageAt:        raw.last_message_at as string | null,
  lastMessageDirection: raw.last_message_direction as ConversationSummary['lastMessageDirection'],
  status:               raw.status as ConversationSummary['status'],
  unreadCount:          raw.unread_count as number,
  assignedAgentId:      raw.assigned_agent_id as string | null,
  assignedAgentName:    raw.assigned_agent_name as string | null,
  priority:             (raw.priority as ConversationSummary['priority']) ?? 'normal',
});

export const useInboxStore = create<InboxState>((set, get) => ({
  conversations: [],
  activeFilter:  'mine',
  searchQuery:   '',
  isLoading:     false,
  hasMore:       false,
  cursor:        null,

  loadInitial: async () => {
    set({ isLoading: true, cursor: null });
    try {
      const { data } = await api.get('/conversations', {
        params: { filter: get().activeFilter, limit: 30 },
      });
      set({
        conversations: (data.data as Record<string, unknown>[]).map(mapConv),
        hasMore:       data.has_more,
        cursor:        data.next_cursor ?? null,
      });
    } finally {
      set({ isLoading: false });
    }
  },

  loadMore: async () => {
    const { cursor, isLoading, hasMore, activeFilter } = get();
    if (!hasMore || isLoading || !cursor) return;

    set({ isLoading: true });
    try {
      const { data } = await api.get('/conversations', {
        params: { filter: activeFilter, cursor, limit: 30 },
      });
      set((s) => ({
        conversations: [...s.conversations, ...(data.data as Record<string, unknown>[]).map(mapConv)],
        hasMore:       data.has_more,
        cursor:        data.next_cursor ?? null,
      }));
    } finally {
      set({ isLoading: false });
    }
  },

  applyFilter: (filter) => {
    set({ activeFilter: filter });
    get().loadInitial();
  },

  setSearch: (query) => set({ searchQuery: query }),

  upsertConversation: (update) => {
    set((s) => {
      const idx = s.conversations.findIndex((c) => c.id === update.id);
      if (idx >= 0) {
        const updated = [...s.conversations];
        updated[idx] = { ...updated[idx], ...update };
        return {
          conversations: updated.sort(
            (a, b) => new Date(b.lastMessageAt ?? 0).getTime() - new Date(a.lastMessageAt ?? 0).getTime()
          ),
        };
      }
      // Conversation baru masuk — insert di posisi pertama
      return {
        conversations: [{ ...({} as ConversationSummary), ...update } as ConversationSummary, ...s.conversations],
      };
    });
  },

  removeConversation: (id) =>
    set((s) => ({ conversations: s.conversations.filter((c) => c.id !== id) })),

  incrementUnread: (id) =>
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === id ? { ...c, unreadCount: c.unreadCount + 1 } : c
      ),
    })),

  // The server clears unread_count when a conversation is opened, but the list
  // in memory kept its stale badge until the next full reload.
  clearUnread: (id) =>
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === id ? { ...c, unreadCount: 0 } : c
      ),
    })),

  setAssignee: (id, agentId, agentName) =>
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === id ? { ...c, assignedAgentId: agentId, assignedAgentName: agentName } : c
      ),
    })),
}));
