import { useEffect, useRef, useState } from 'react';
import api from '../../lib/api';
import { getSocket } from '../../lib/socket';
import toast from 'react-hot-toast';
import type { ConversationSummary, Message } from '../../types';

type ConvFilter = 'all' | 'mine' | 'unassigned' | 'pending';
type MsgDirection = 'inbound' | 'outbound';

interface ChatMessage extends Message {
  text?: string;
  media?: { url?: string; caption?: string; mimeType?: string };
  reactions?: { emoji: string; userId: string }[];
  context?: { messageId: string; from: string; text: string };
}

const FILTER_LABELS: Record<ConvFilter, string> = {
  all: '全部',
  mine: '我的',
  unassigned: '未分配',
  pending: '待处理',
};

const CHANNEL_ICON: Record<string, string> = {
  whatsapp: '💬',
  telegram: '✈️',
  line: '📱',
  email: '📧',
  sms: '💬',
};

function getStatusIcon(status: string) {
  switch (status) {
    case 'sent':     return '✓';
    case 'delivered': return '✓✓';
    case 'read':     return <span className="text-blue-500">✓✓</span>;
    case 'failed':   return <span className="text-red-500">✗</span>;
    default:         return <span className="text-gray-400">○</span>;
  }
}

function fmtTime(val?: string | null) {
  if (!val) return '';
  const d = new Date(val);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return '昨天';
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

function fmtFullTime(val?: string | null) {
  if (!val) return '';
  const d = new Date(val);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('zh-CN', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export default function AgentChatPage() {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [selected, setSelected]   = useState<ConversationSummary | null>(null);
  const [messages, setMessages]   = useState<ChatMessage[]>([]);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [loadingConvs, setLoadingConvs] = useState(true);
  const [msgText, setMsgText]     = useState('');
  const [sending, setSending]     = useState(false);
  const [filter, setFilter]       = useState<ConvFilter>('mine');
  const [search, setSearch]       = useState('');
  const [replyTo, setReplyTo]     = useState<ChatMessage | null>(null);
  const [forwardMsg, setForwardMsg] = useState<ChatMessage | null>(null);
  const [forwardSearch, setForwardSearch] = useState('');
  const [reactPickerId, setReactPickerId] = useState<string | null>(null);
  const [typingAgent, setTypingAgent] = useState<string | null>(null);
  const [showEmoji, setShowEmoji]  = useState(false);
  const [quickReplies, setQuickReplies] = useState<Array<{id: string; title: string; shortcut: string; message: string}>>([]);

  const messagesEndRef   = useRef<HTMLDivElement>(null);
  const containerRef     = useRef<HTMLDivElement>(null);
  const typingTimerRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingAgentTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Load conversations ─────────────────────────────────────────────────────
  const loadConvs = async () => {
    setLoadingConvs(true);
    try {
      const params: Record<string, string | number> = { limit: 50 };
      if (filter === 'mine') params.filter = 'mine';
      else if (filter === 'unassigned') params.filter = 'unassigned';
      else if (filter === 'pending') params.filter = 'pending';
      if (search.trim()) params.search = search.trim();

      const { data } = await api.get('/conversations', { params });
      const list: ConversationSummary[] = data.data ?? data;
      setConversations(list);
    } catch {
      toast.error('加载会话列表失败');
    } finally {
      setLoadingConvs(false);
    }
  };

  useEffect(() => { loadConvs(); }, [filter]);

  // Debounced search
  useEffect(() => {
    const t = setTimeout(() => loadConvs(), 400);
    return () => clearTimeout(t);
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load messages ──────────────────────────────────────────────────────────
  const loadMessages = async (convId: string) => {
    setLoadingMsgs(true);
    setMessages([]);
    try {
      const { data } = await api.get(`/conversations/${convId}/messages`, { params: { limit: 50 } });
      const msgs: ChatMessage[] = (data.data ?? []).map((m: Record<string, unknown>) => ({
        id: m.id as string,
        conversationId: m.conversation_id as string,
        direction: m.direction as MsgDirection,
        senderType: m.sender_type as Message['senderType'],
        senderId: m.sender_id as string,
        contentType: m.content_type as string,
        content: m.content as Record<string, unknown>,
        status: m.status as Message['status'],
        text: (m.content as Record<string, unknown>)?.body as string | undefined,
        media: (m.content as Record<string, unknown>)?.media as ChatMessage['media'],
        reactions: m.reactions as ChatMessage['reactions'],
        context: m.quoted_message_id ? {
          messageId: m.quoted_message_id as string,
          from: m.direction as string,
          text: '',
        } : undefined,
        providerMessageId: m.provider_message_id as string | undefined,
        providerTimestamp: m.provider_timestamp as string | null,
        quotedMessageId: m.quoted_message_id as string | null | undefined,
        isDeleted: (m.is_deleted as boolean) ?? false,
        createdAt: m.created_at as string | null,
      }));
      setMessages(msgs);
      scrollToBottom();
    } catch {
      toast.error('加载消息失败');
    } finally {
      setLoadingMsgs(false);
    }
  };

  // ── Select conversation ────────────────────────────────────────────────────
  const selectConv = async (conv: ConversationSummary) => {
    setSelected(conv);
    setReplyTo(null);
    setReactPickerId(null);
    setTypingAgent(null);
    await loadMessages(conv.id);
    try {
      await api.put(`/conversations/${conv.id}/read`);
    } catch { /* ignore */ }
  };

  // ── Socket events ──────────────────────────────────────────────────────────
  useEffect(() => {
    const socket = getSocket();

    const onNewMessage = (msg: Record<string, unknown>) => {
      if (msg.conversation_id !== selected?.id) return;
      const m = msg as unknown as ChatMessage;
      setMessages(prev => [...prev, {
        ...m,
        text: (m.content as Record<string, unknown>)?.body as string | undefined,
        media: (m.content as Record<string, unknown>)?.media as ChatMessage['media'],
      }]);
      scrollToBottom();
      // Mark read
      if (selected) api.put(`/conversations/${selected.id}/read`).catch(() => {});
    };

    const onMsgStatus = (data: { messageId: string; status: Message['status'] }) => {
      setMessages(prev => prev.map(m =>
        (m.id === data.messageId || m.providerMessageId === data.messageId)
          ? { ...m, status: data.status }
          : m
      ));
    };

    const onConvUpdate = (data: { conversationId: string; preview: string; timestamp: string }) => {
      setConversations(prev => prev.map(c =>
        c.id === data.conversationId
          ? { ...c, lastMessagePreview: data.preview, lastMessageAt: data.timestamp }
          : c
      ));
    };

    const onAgentTyping = (data: { agentId: string; conversationId: string }) => {
      if (data.conversationId !== selected?.id) return;
      setTypingAgent(data.agentId);
      if (typingAgentTimer.current) clearTimeout(typingAgentTimer.current);
      typingAgentTimer.current = setTimeout(() => setTypingAgent(null), 4000);
    };

    const onAgentStoppedTyping = (data: { agentId: string; conversationId: string }) => {
      if (data.conversationId !== selected?.id) return;
      setTypingAgent(null);
    };

    const onInboxResolved = (data: { conversationId: string }) => {
      if (filter === 'mine' || filter === 'all') {
        setConversations(prev => prev.filter(c => c.id !== data.conversationId));
        if (selected?.id === data.conversationId) setSelected(null);
      }
    };

    socket.on('message:new', onNewMessage);
    socket.on('message:status', onMsgStatus);
    socket.on('inbox:update', onConvUpdate);
    socket.on('typing:start', onAgentTyping);
    socket.on('typing:stop', onAgentStoppedTyping);
    socket.on('inbox:resolved', onInboxResolved);

    return () => {
      socket.off('message:new', onNewMessage);
      socket.off('message:status', onMsgStatus);
      socket.off('inbox:update', onConvUpdate);
      socket.off('typing:start', onAgentTyping);
      socket.off('typing:stop', onAgentStoppedTyping);
      socket.off('inbox:resolved', onInboxResolved);
    };
  }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load quick replies
  useEffect(() => {
    api.get('/quick-replies').then(r => setQuickReplies(r.data.data ?? [])).catch(() => {});
  }, []);

  // ── Scroll ─────────────────────────────────────────────────────────────────
  const scrollToBottom = () => {
    setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
  };

  // ── Send message ───────────────────────────────────────────────────────────
  const handleSend = async () => {
    const text = msgText.trim();
    if (!text || !selected || sending) return;

    const tempId = `temp_${Date.now()}`;
    const optimistic: ChatMessage = {
      id: tempId,
      tempId,
      conversationId: selected.id,
      direction: 'outbound',
      senderType: 'agent',
      senderId: '',
      contentType: 'text',
      content: { body: text },
      text,
      status: 'pending',
      providerTimestamp: new Date().toISOString(),
      quotedMessageId: replyTo?.id,
      context: replyTo ? { messageId: replyTo.id, from: 'outbound', text: replyTo.text ?? '' } : undefined,
      isDeleted: false,
      createdAt: new Date().toISOString(),
    };

    setMessages(prev => [...prev, optimistic]);
    setMsgText('');
    setReplyTo(null);
    scrollToBottom();

    try {
      const { data } = await api.post(`/conversations/${selected.id}/messages`, {
        content_type: 'text',
        content: { body: text },
        reply_to_provider_msg_id: replyTo?.providerMessageId ?? replyTo?.id,
      });
      setMessages(prev => prev.map(m =>
        m.tempId === tempId ? { ...m, id: data.id ?? data.message?.id ?? tempId, status: 'sent' } : m
      ));
    } catch {
      setMessages(prev => prev.map(m =>
        m.tempId === tempId ? { ...m, status: 'failed' } : m
      ));
      toast.error('发送失败');
    }
  };

  // ── Emoji ──────────────────────────────────────────────────────────────────
  const EMOJIS = ['😀','😂','😍','😊','👍','❤️','🔥','✅','😢','😭','😡','🤔','😎','🥳','🙏','👏','💪','🎉','⭐','✨'];

  // ── React ──────────────────────────────────────────────────────────────────
  const handleReact = async (msg: ChatMessage, emoji: string) => {
    try {
      await api.post(`/messages/${msg.id}/react`, { emoji });
      setMessages(prev => prev.map(m =>
        m.id === msg.id
          ? { ...m, reactions: [...(m.reactions ?? []), { emoji, userId: 'me' }] }
          : m
      ));
    } catch {
      toast.error('反应失败');
    }
    setReactPickerId(null);
  };

  // ── Forward ────────────────────────────────────────────────────────────────
  const handleForwardMessage = async (targetId: string) => {
    if (!forwardMsg) return;
    try {
      await api.post(`/conversations/${targetId}/messages`, {
        content_type: 'text',
        content: { body: forwardMsg.text || '' },
      });
      toast.success('已转发');
    } catch {
      toast.error('转发失败');
    }
    setForwardMsg(null);
    setForwardSearch('');
  };

  // ── Quick reply ────────────────────────────────────────────────────────────
  const handleQuickReply = (qr: typeof quickReplies[0]) => {
    setMsgText(qr.message);
  };

  // ── Resolve conversation ───────────────────────────────────────────────────
  const handleResolve = async () => {
    if (!selected) return;
    try {
      await api.post(`/conversations/${selected.id}/resolve`);
      setSelected(null);
      setConversations(prev => prev.filter(c => c.id !== selected.id));
    } catch {
      toast.error('完成会话失败');
    }
  };

  // ── Render message content ─────────────────────────────────────────────────
  const renderContent = (msg: ChatMessage) => {
    if (msg.media?.url) {
      const isImg = msg.media.mimeType?.startsWith('image/') ?? false;
      const isVid = msg.media.mimeType?.startsWith('video/') ?? false;
      return (
        <div>
          {isImg && <img src={msg.media.url} alt="" className="rounded-lg max-w-full max-h-64" />}
          {isVid && <video src={msg.media.url} controls className="rounded-lg max-w-full max-h-64" />}
          {msg.media.caption && <p className="mt-1 text-sm whitespace-pre-wrap">{msg.media.caption}</p>}
        </div>
      );
    }
    return <p className="whitespace-pre-wrap">{msg.text}</p>;
  };

  const filteredConvs = conversations.filter(c => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (c.contactName?.toLowerCase().includes(q) ?? false)
        || (c.lastMessagePreview?.toLowerCase().includes(q) ?? false);
  });

  return (
    <div className="flex h-screen bg-gray-100 overflow-hidden">
      {/* ── Left sidebar: conversation list ─────────────────────────────── */}
      <div className="w-80 bg-white border-r border-gray-200 flex flex-col shrink-0">
        {/* Header */}
        <div className="px-4 py-3 border-b border-gray-100">
          <h2 className="font-bold text-gray-800 mb-2">客服聊天</h2>
          <input
            type="text"
            placeholder="搜索会话..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500"
          />
        </div>

        {/* Filter tabs */}
        <div className="flex border-b border-gray-100 shrink-0">
          {(['mine', 'all', 'unassigned', 'pending'] as ConvFilter[]).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`flex-1 text-xs py-2 font-medium transition-colors ${
                filter === f
                  ? 'text-brand-600 border-b-2 border-brand-600'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {FILTER_LABELS[f]}
            </button>
          ))}
        </div>

        {/* Conversation list */}
        <div ref={containerRef} className="flex-1 overflow-y-auto">
          {loadingConvs ? (
            <div className="text-center text-gray-400 text-sm py-8">加载中...</div>
          ) : filteredConvs.length === 0 ? (
            <div className="text-center text-gray-400 text-sm py-8">暂无会话</div>
          ) : (
            filteredConvs.map(conv => (
              <button
                key={conv.id}
                onClick={() => selectConv(conv)}
                className={`w-full text-left px-3 py-3 border-b border-gray-50 hover:bg-gray-50 transition ${
                  selected?.id === conv.id ? 'bg-brand-50 border-l-4 border-l-brand-600' : ''
                }`}
              >
                <div className="flex items-start gap-2">
                  {/* Avatar */}
                  <div className="w-10 h-10 rounded-full bg-brand-100 text-brand-700 flex items-center justify-center font-semibold text-sm shrink-0">
                    {conv.contactName?.charAt(0) ?? '?'}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-sm font-medium text-gray-900 truncate">
                        {conv.contactName ?? '未命名'}
                      </span>
                      <span className="text-[10px] text-gray-400 shrink-0">
                        {fmtTime(conv.lastMessageAt)}
                      </span>
                    </div>
                    <div className="flex items-center gap-1 mt-0.5">
                      <span className="text-xs">{CHANNEL_ICON[conv.channelType] ?? '💬'}</span>
                      <p className="text-xs text-gray-500 truncate flex-1">
                        {conv.lastMessagePreview ?? ''}
                      </p>
                      {conv.unreadCount > 0 && (
                        <span className="w-5 h-5 rounded-full bg-brand-600 text-white text-[10px] flex items-center justify-center shrink-0">
                          {conv.unreadCount > 9 ? '9+' : conv.unreadCount}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* ── Right panel: chat area ──────────────────────────────────────── */}
      {selected ? (
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Chat header */}
          <div className="bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between shrink-0">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-full bg-brand-100 text-brand-700 flex items-center justify-center font-semibold text-xs shrink-0">
                  {selected.contactName?.charAt(0) ?? '?'}
                </div>
                <div>
                  <h3 className="font-semibold text-gray-900 truncate">
                    {selected.contactName ?? '未命名'}
                  </h3>
                  <p className="text-xs text-gray-500">
                    {CHANNEL_ICON[selected.channelType]} {selected.channelType}
                  </p>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {selected.status !== 'resolved' && (
                <button
                  onClick={handleResolve}
                  className="px-3 py-1.5 text-xs bg-green-600 text-white rounded-lg hover:bg-green-700 transition"
                >
                  完成会话
                </button>
              )}
            </div>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-4 bg-gray-50 flex flex-col gap-2">
            {loadingMsgs ? (
              <div className="text-center text-gray-400 text-sm py-8">加载消息中...</div>
            ) : messages.length === 0 ? (
              <div className="text-center text-gray-400 text-sm py-8">
                暂无消息，开始对话吧
              </div>
            ) : (
              messages.map(msg => (
                <div
                  key={msg.tempId ?? msg.id}
                  className={`group flex min-w-0 ${msg.direction === 'outbound' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[75%] min-w-0 rounded-2xl px-4 py-2 shadow-sm ${
                      msg.direction === 'outbound'
                        ? 'bg-brand-500 text-white rounded-br-sm'
                        : 'bg-white text-gray-900 rounded-bl-sm'
                    }`}
                  >
                    {/* Reply quote */}
                    {msg.context?.messageId && (
                      <div className={`mb-1 border-l-4 px-2 py-1 rounded text-xs ${
                        msg.direction === 'outbound'
                          ? 'border-white/40 bg-white/10 text-white/80'
                          : 'border-brand-500 bg-gray-50 text-gray-600'
                      }`}>
                        <div className="font-medium text-[10px] opacity-70">
                          {msg.context.from === 'outbound' ? '我' : '客户'}
                        </div>
                        <div className="truncate">{msg.context.text || '引用消息'}</div>
                      </div>
                    )}

                    {/* Content */}
                    {renderContent(msg)}

                    {/* Meta */}
                    <div className={`flex items-center justify-end gap-1 mt-1 ${
                      msg.direction === 'outbound' ? 'text-white/60' : 'text-gray-400'
                    }`}>
                      <span className="text-[10px]">{fmtFullTime(msg.createdAt)}</span>
                      {msg.direction === 'outbound' && (
                        <span className="text-xs">{getStatusIcon(msg.status)}</span>
                      )}
                      <button
                        onClick={() => setReactPickerId(reactPickerId === msg.id ? null : msg.id)}
                        className="opacity-0 group-hover:opacity-100 ml-1 text-sm hover:scale-125 transition-transform"
                      >
                        😊
                      </button>
                      <button
                        onClick={() => setReplyTo(msg)}
                        className="opacity-0 group-hover:opacity-100 ml-0.5 text-sm hover:scale-125 transition-transform"
                      >
                        ↩
                      </button>
                      <button
                        onClick={() => setForwardMsg(msg)}
                        className="opacity-0 group-hover:opacity-100 ml-0.5 text-sm hover:scale-125 transition-transform"
                      >
                        ↗
                      </button>
                    </div>

                    {/* Reactions */}
                    {msg.reactions && msg.reactions.length > 0 && (
                      <div className="flex gap-0.5 -mt-0.5">
                        {msg.reactions.map((r, i) => (
                          <span key={i} className={`text-xs rounded-full px-1.5 py-0.5 ${
                            msg.direction === 'outbound' ? 'bg-white/20' : 'bg-gray-100'
                          }`}>{r.emoji}</span>
                        ))}
                      </div>
                    )}

                    {/* React picker */}
                    {reactPickerId === msg.id && (
                      <div className={`flex gap-1 mt-1 rounded-full px-2 py-1 w-fit shadow ${
                        msg.direction === 'outbound' ? 'bg-white/20' : 'bg-gray-100'
                      }`}>
                        {EMOJIS.slice(0, 8).map(e => (
                          <button key={e} onClick={() => handleReact(msg, e)} className="text-base leading-none hover:scale-125 transition-transform">
                            {e}
                          </button>
                        ))}
                      </div>
                    )}

                    {/* Failed indicator */}
                    {msg.status === 'failed' && (
                      <div className="text-[10px] text-red-300 mt-0.5">发送失败</div>
                    )}
                  </div>
                </div>
              ))
            )}

            {/* Typing indicator */}
            {typingAgent && (
              <div className="flex justify-start">
                <div className="bg-white rounded-2xl px-4 py-2 shadow-sm">
                  <p className="text-xs text-gray-500 italic">对方正在输入...</p>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Reply bar */}
          {replyTo && (
            <div className={`px-4 py-2 flex items-center gap-2 border-t border-gray-200 ${
              replyTo.direction === 'outbound' ? 'bg-brand-50' : 'bg-gray-50'
            }`}>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium text-gray-600">回复: {replyTo.direction === 'outbound' ? '我' : '客户'}</div>
                <div className="text-xs text-gray-500 truncate">{replyTo.text || '[媒体消息]'}</div>
              </div>
              <button onClick={() => setReplyTo(null)} className="text-gray-400 hover:text-gray-600 text-lg">✕</button>
            </div>
          )}

          {/* Quick replies */}
          {quickReplies.length > 0 && (
            <div className="px-4 py-2 border-t border-gray-100 bg-white flex gap-2 overflow-x-auto">
              {quickReplies.slice(0, 5).map(qr => (
                <button
                  key={qr.id}
                  onClick={() => handleQuickReply(qr)}
                  className="shrink-0 text-xs px-3 py-1.5 rounded-full border border-brand-200 text-brand-700 hover:bg-brand-50 whitespace-nowrap"
                >
                  {qr.title}
                </button>
              ))}
            </div>
          )}

          {/* Input area */}
          <div className="p-3 border-t border-gray-200 bg-white flex items-end gap-2">
            {/* Emoji button */}
            <button
              onClick={() => setShowEmoji(v => !v)}
              className={`p-2 rounded-lg hover:bg-gray-50 shrink-0 ${showEmoji ? 'text-brand-600' : 'text-gray-400'}`}
            >
              😊
            </button>

            {/* Textarea */}
            <textarea
              value={msgText}
              onChange={e => {
                setMsgText(e.target.value);
                if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
                if (selected) {
                  getSocket().emit('typing:start', { conversationId: selected.id });
                  typingTimerRef.current = setTimeout(() => {
                    getSocket().emit('typing:stop', { conversationId: selected.id });
                  }, 2000);
                }
              }}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder="输入消息（Enter 发送）"
              rows={1}
              className="flex-1 resize-none rounded-2xl border border-gray-200 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 max-h-32 overflow-y-auto"
              style={{ minHeight: '42px' }}
            />

            {/* Emoji picker */}
            {showEmoji && (
              <div className="absolute bottom-24 right-6 z-50 bg-white rounded-xl border shadow-lg p-2 w-64 flex flex-wrap gap-0.5">
                {EMOJIS.map(e => (
                  <button key={e} onClick={() => { setMsgText(t => t + e); setShowEmoji(false); }} className="text-xl p-1 hover:bg-gray-100 rounded">
                    {e}
                  </button>
                ))}
              </div>
            )}

            {/* Send button */}
            <button
              onClick={handleSend}
              disabled={!msgText.trim() || sending}
              className="bg-brand-600 hover:bg-brand-700 text-white rounded-2xl px-5 py-2.5 text-sm font-medium transition disabled:opacity-40 shrink-0"
            >
              发送
            </button>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center bg-gray-50">
          <div className="text-center">
            <div className="text-5xl mb-4">💬</div>
            <h3 className="text-lg font-medium text-gray-500">选择会话开始聊天</h3>
            <p className="text-sm text-gray-400 mt-1">从左侧选择一个会话进行回复</p>
          </div>
        </div>
      )}

      {/* Forward modal */}
      {forwardMsg && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => { setForwardMsg(null); setForwardSearch(''); }}>
          <div className="bg-white rounded-xl p-6 w-96 max-h-[80vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-semibold text-gray-900">转发消息</h3>
              <button onClick={() => { setForwardMsg(null); setForwardSearch(''); }} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>
            <div className="p-3 bg-gray-50 rounded-lg mb-3 text-sm text-gray-600 max-h-20 overflow-hidden">
              {forwardMsg.text || '[媒体消息]'}
            </div>
            <input
              type="text"
              placeholder="搜索联系人..."
              value={forwardSearch}
              onChange={e => setForwardSearch(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
            <div className="flex-1 overflow-y-auto space-y-1">
              {filteredConvs
                .filter(c => !forwardSearch || (c.contactName?.toLowerCase().includes(forwardSearch.toLowerCase()) ?? false))
                .filter(c => c.id !== selected?.id)
                .map(c => (
                <button
                  key={c.id}
                  onClick={() => handleForwardMessage(c.id)}
                  className="w-full flex items-center gap-3 p-2 rounded-lg hover:bg-gray-50 text-left"
                >
                  <div className="w-8 h-8 rounded-full bg-brand-100 text-brand-700 flex items-center justify-center font-semibold text-sm">
                    {c.contactName?.charAt(0) ?? '?'}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-gray-900 truncate">{c.contactName ?? '未命名'}</p>
                    <p className="text-xs text-gray-500">{c.channelType}</p>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
