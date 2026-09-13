import { useEffect, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useInboxStore } from '../../stores/useInboxStore';
import { useConversationStore } from '../../stores/useConversationStore';
import { useAuthStore } from '../../stores/useAuthStore';
import ConversationItem from './ConversationItem';

type Filter = 'mine' | 'all' | 'unassigned' | 'pending';
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'mine',       label: '我的' },
  { key: 'all',        label: '全部' },
  { key: 'unassigned', label: '未分配' },
  { key: 'pending',    label: '待处理' },
];

export default function ConversationList() {
  const { conversations, activeFilter, searchQuery, isLoading, hasMore, loadInitial, loadMore, applyFilter, setSearch } =
    useInboxStore();
  const { activeConversationId, openConversation } = useConversationStore();
  const user = useAuthStore((s) => s.user);

  useEffect(() => { loadInitial(); }, [activeFilter]);

  // Client-side filter + search
  const filtered = useMemo(() => {
    let result = conversations;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (c) =>
          (c.contactName?.toLowerCase().includes(q) ?? false) ||
          (c.lastMessagePreview?.toLowerCase().includes(q) ?? false)
      );
    }
    return result.sort(
      (a, b) => new Date(b.lastMessageAt ?? 0).getTime() - new Date(a.lastMessageAt ?? 0).getTime()
    );
  }, [conversations, searchQuery]);

  const scrollRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count:           filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize:    () => 72,
    overscan:        10,
  });

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 200;
    if (nearBottom && hasMore && !isLoading) loadMore();
  };

  return (
    <div className="flex flex-col h-full">
      {/* Search */}
      <div className="px-3 py-2 border-b border-gray-100">
        <input
          type="text"
          placeholder="搜索会话..."
          value={searchQuery}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full text-sm border border-gray-200 rounded px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500"
        />
      </div>

      {/* Filter tabs */}
      <div className="flex border-b border-gray-100 shrink-0">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => applyFilter(f.key)}
            className={[
              'flex-1 text-xs py-2 font-medium transition-colors',
              activeFilter === f.key
                ? 'text-brand-600 border-b-2 border-brand-600'
                : 'text-gray-500 hover:text-gray-700',
            ].join(' ')}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Virtualized list */}
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto">
        {filtered.length === 0 && !isLoading && (
          <p className="text-center text-gray-400 text-sm py-8">暂无会话</p>
        )}

        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((item) => {
            const conv = filtered[item.index];
            return (
              <div
                key={conv.id}
                style={{ position: 'absolute', top: item.start, left: 0, right: 0, height: item.size }}
              >
                <ConversationItem
                  conv={conv}
                  isActive={conv.id === activeConversationId}
                  currentAgentId={user?.id ?? ''}
                  onClick={() => openConversation(conv.id)}
                />
              </div>
            );
          })}
        </div>

        {isLoading && (
          <div className="text-center py-4 text-gray-400 text-xs">加载中...</div>
        )}
      </div>
    </div>
  );
}
