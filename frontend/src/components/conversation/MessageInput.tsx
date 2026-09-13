import { KeyboardEvent, useRef, useState } from 'react';
import { getSocket } from '../../lib/socket';
import { useConversationStore } from '../../stores/useConversationStore';

export default function MessageInput() {
  const { activeConversationId, sendMessage } = useConversationStore();
  const [value,  setValue]   = useState('');
  const [sending, setSending] = useState(false);

  const typingRef    = useRef(false);
  const typingTimer  = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleChange = (v: string) => {
    setValue(v);

    if (!typingRef.current && activeConversationId) {
      typingRef.current = true;
      getSocket().emit('typing:start', { conversationId: activeConversationId });
    }

    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => {
      typingRef.current = false;
      if (activeConversationId) {
        getSocket().emit('typing:stop', { conversationId: activeConversationId });
      }
    }, 2000);
  };

  const handleSend = async () => {
    const text = value.trim();
    if (!text || sending) return;

    // Stop typing indicator
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingRef.current = false;
    if (activeConversationId) {
      getSocket().emit('typing:stop', { conversationId: activeConversationId });
    }

    setSending(true);
    setValue('');
    await sendMessage('text', { body: text });
    setSending(false);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  if (!activeConversationId) return null;

  return (
    <div className="border-t border-gray-200 bg-white px-4 py-3 flex items-end gap-2">
      <textarea
        value={value}
        onChange={(e) => handleChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="输入消息...（Enter 发送，Shift+Enter 换行）"
        rows={1}
        className="flex-1 resize-none rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 max-h-32 overflow-y-auto"
        style={{ minHeight: '38px' }}
      />
      <button
        onClick={handleSend}
        disabled={!value.trim() || sending}
        className="bg-brand-600 hover:bg-brand-700 text-white rounded-lg px-4 py-2 text-sm font-medium transition disabled:opacity-40"
      >
        发送
      </button>
    </div>
  );
}
