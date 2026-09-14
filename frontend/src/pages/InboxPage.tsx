import { useEffect } from 'react';
import { useAuthStore } from '../stores/useAuthStore';
import { useConversationStore } from '../stores/useConversationStore';
import { useSocketStore } from '../stores/useSocketStore';
import { getSocket } from '../lib/socket';
import { registerSocketHandlers } from '../lib/socketEventHandlers';
import ConversationList from '../components/inbox/ConversationList';
import ConversationDetail from '../components/conversation/ConversationDetail';
import PresenceSidebar from '../components/inbox/PresenceSidebar';

export default function InboxPage() {
  const user           = useAuthStore((s) => s.user);
  const logout         = useAuthStore((s) => s.logout);
  const isConnected    = useSocketStore((s) => s.isConnected);
  const activeId       = useConversationStore((s) => s.activeConversationId);

  // Register socket handlers sekali setelah mount
  useEffect(() => {
    let cleanup: (() => void) | undefined;
    try {
      cleanup = registerSocketHandlers(getSocket());
    } catch {
      // Socket belum init — akan di-register saat socket connect event
    }
    return () => cleanup?.();
  }, []);

  return (
    <div className="flex flex-col h-screen bg-gray-100">
      {/* Top bar */}
      <header className="bg-white border-b border-gray-200 px-4 py-2 flex items-center justify-between shrink-0">
        <span className="font-bold text-brand-600">红浪漫会所</span>
        <div className="flex items-center gap-3">
          <span className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-400'}`} title={isConnected ? '已连接' : '已断开'} />
          <span className="text-sm text-gray-600">{user?.name}</span>
          <button onClick={logout} className="text-xs text-gray-400 hover:text-gray-700">退出</button>
        </div>
      </header>

      {/* Main layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left panel — conversation list */}
        <div className="w-80 border-r border-gray-200 bg-white flex flex-col overflow-hidden shrink-0">
          <ConversationList />
        </div>

        {/* Right panel — conversation detail or empty state */}
        <div className="flex-1 overflow-hidden">
          {activeId ? (
            <ConversationDetail />
          ) : (
            <div className="flex items-center justify-center h-full text-gray-400 text-sm">
              选择一个会话开始
            </div>
          )}
        </div>

        {/* Right sidebar — agent presence */}
        <PresenceSidebar />
      </div>
    </div>
  );
}
