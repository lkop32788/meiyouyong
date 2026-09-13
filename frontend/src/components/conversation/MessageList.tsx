import { useEffect, useRef } from 'react';
import { useConversationStore } from '../../stores/useConversationStore';
import MessageBubble from './MessageBubble';
import TypingIndicator from './TypingIndicator';

export default function MessageList() {
  const { messages, isLoadingMessages, hasMoreMessages, typingAgentIds, contactIsTyping, loadOlderMessages } =
    useConversationStore();

  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef    = useRef<HTMLDivElement>(null);
  const prevScrollHeight = useRef(0);

  // Auto-scroll ke bawah saat messages pertama kali dimuat
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'instant' });
  }, [messages.length === 0]);

  // Auto-scroll ke bawah saat pesan baru masuk HANYA jika user sudah di bawah
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    if (isAtBottom) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Restore scroll position saat load history (scroll ke atas)
  const handleLoadOlder = async () => {
    const el = containerRef.current;
    if (!el) return;
    prevScrollHeight.current = el.scrollHeight;
    await loadOlderMessages();
    // Setelah prepend, restore posisi scroll
    requestAnimationFrame(() => {
      if (el) el.scrollTop += el.scrollHeight - prevScrollHeight.current;
    });
  };

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    if (el.scrollTop < 100 && hasMoreMessages && !isLoadingMessages) {
      handleLoadOlder();
    }
  };

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto px-4 py-4 bg-gray-50 flex flex-col gap-1"
    >
      {isLoadingMessages && (
        <div className="text-center text-xs text-gray-400 py-2">加载消息中...</div>
      )}

      {messages.map((msg) => (
        <MessageBubble key={msg.tempId ?? msg.id} message={msg} />
      ))}

      <TypingIndicator typingAgentIds={typingAgentIds} contactIsTyping={contactIsTyping} />

      <div ref={bottomRef} />
    </div>
  );
}
