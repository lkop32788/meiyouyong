/**
 * AgentChatPage — standalone full-screen chat page (no AppShell sidebar).
 * WhatsApp Web style: brand bar + conversation list + chat area.
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../lib/api';
import { getSocket } from '../../lib/socket';
import { useAuthStore } from '../../stores/useAuthStore';
import { useSocketStore } from '../../stores/useSocketStore';
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
  if ((now.getTime() - d.getTime()) < 7 * 86400000) {
    return d.toLocaleDateString([], { weekday: 'short' });
  }
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
  const navigate = useNavigate();
  const user = useAuthStore(s => s.user);
  const logout = useAuthStore(s => s.logout);
  const isConnected = useSocketStore(s => s.isConnected);

  const [convs, setConvs] = useState<ConversationSummary[]>([]);
  const [selected, setSelected] = useState<ConversationSummary | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [loadingConvs, setLoadingConvs] = useState(true);
  const [msgText, setMsgText] = useState('');
  const [sending, setSending] = useState(false);
  const [filter, setFilter] = useState<ConvFilter>('mine');
  const [search, setSearch] = useState('');
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [forwardMsg, setForwardMsg] = useState<ChatMessage | null>(null);
  const [forwardSearch, setForwardSearch] = useState('');
  const [reactPickerId, setReactPickerId] = useState<string | null>(null);
  const [typingAgent, setTypingAgent] = useState<string | null>(null);
  const [showEmoji, setShowEmoji] = useState(false);
  const [quickReplies, setQuickReplies] = useState<Array<{id: string; title: string; shortcut: string; message: string}>>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true); // mobile: toggle sidebar

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      setConvs((data.data ?? data) as ConversationSummary[]);
    } catch {
      toast.error('加载会话列表失败');
    } finally {
      setLoadingConvs(false);
    }
  };

  useEffect(() => { loadConvs(); }, [filter]);

  useEffect(() => {
    const t = setTimeout(() => loadConvs(), 400);
    return () => clearTimeout(t);
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load messages ────────────────────────────────────────────────────────
  const loadMessages = async (convId: string) => {
    setLoadingMsgs(true);
    setMessages([]);
    try {
      const { data } = await api.get(`/conversations/${convId}/messages`, { params: { limit: 100 } });
      const msgs: ChatMessage[] = ((data.data as Record<string, unknown>[]) ?? []).map(m => ({
        id: m.id as string,
        conversationId: m.conversation_id as string,
        direction: m.direction as MsgDirection,
        senderType: m.sender_type as Message['senderType'],
        senderId: m.sender_id as string,
        contentType: m.content_type as string,
        content: m.content as Record<string, unknown>,
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
        status: m.status as Message['status'],
      }));
      setMessages(msgs);
      setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
    } catch {
      toast.error('加载消息失败');
    } finally {
      setLoadingMsgs(false);
    }
  };

  // ── Select conversation ───────────────────────────────────────────────────
  const selectConv = async (conv: ConversationSummary) => {
    setSelected(conv);
    setReplyTo(null);
    setReactPickerId(null);
    setTypingAgent(null);
    await loadMessages(conv.id);
    api.put(`/conversations/${conv.id}/read`).catch(() => {});
    // On mobile, close sidebar after selecting
    if (window.innerWidth < 768) setSidebarOpen(false);
  };

  // ── Socket events ──────────────────────────────────────────────────────────
  useEffect(() => {
    const socket = getSocket();

    const onNewMessage = (msg: Record<string, unknown>) => {
      if (msg.conversation_id !== selected?.id) return;
      const m = msg as unknown as ChatMessage;
      const newMsg: ChatMessage = {
        ...m,
        text: (m.content as Record<string, unknown>)?.body as string | undefined,
        media: (m.content as Record<string, unknown>)?.media as ChatMessage['media'],
      };
      setMessages(prev => [...prev, newMsg]);
      setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 30);
      if (selected) api.put(`/conversations/${selected.id}/read`).catch(() => {});
    };

    const onMsgStatus = (data: { messageId: string; status: Message['status'] }) => {
      setMessages(prev => prev.map(m =>
        (m.id === data.messageId || m.providerMessageId === data.messageId)
          ? { ...m, status: data.status } : m
      ));
    };

    const onAgentTyping = (data: { agentId: string; conversationId: string }) => {
      if (data.conversationId !== selected?.id) return;
      setTypingAgent(data.agentId);
    };

    const onAgentStoppedTyping = (data: { agentId: string; conversationId: string }) => {
      if (data.conversationId !== selected?.id) return;
      setTypingAgent(null);
    };

    const onInboxResolved = (data: { conversationId: string }) => {
      setConvs(prev => {
        if (prev.find(c => c.id === data.conversationId)) {
          return prev.filter(c => c.id !== data.conversationId);
        }
        return prev;
      });
      if (selected?.id === data.conversationId) setSelected(null);
    };

    socket.on('message:new', onNewMessage);
    socket.on('message:status', onMsgStatus);
    socket.on('typing:start', onAgentTyping);
    socket.on('typing:stop', onAgentStoppedTyping);
    socket.on('inbox:resolved', onInboxResolved);

    return () => {
      socket.off('message:new', onNewMessage);
      socket.off('message:status', onMsgStatus);
      socket.off('typing:start', onAgentTyping);
      socket.off('typing:stop', onAgentStoppedTyping);
      socket.off('inbox:resolved', onInboxResolved);
    };
  }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps

  // Quick replies
  useEffect(() => {
    api.get('/quick-replies').then(r => setQuickReplies(r.data.data ?? [])).catch(() => {});
  }, []);

  // ── Send message ──────────────────────────────────────────────────────────
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
    setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 30);

    try {
      const { data: res } = await api.post(`/conversations/${selected.id}/messages`, {
        content_type: 'text',
        content: { body: text },
        reply_to_provider_msg_id: replyTo?.providerMessageId ?? replyTo?.id,
      });
      setMessages(prev => prev.map(m =>
        m.tempId === tempId
          ? { ...m, id: (res as Record<string, unknown>).id as string ?? tempId, status: 'sent' }
          : m
      ));
    } catch {
      setMessages(prev => prev.map(m =>
        m.tempId === tempId ? { ...m, status: 'failed' } : m
      ));
      toast.error('发送失败');
    }
  };

  const EMOJIS = ['😀','😂','😍','😊','👍','❤️','🔥','✅','😢','😭','😡','🤔','😎','🥳','🙏','👏','💪','🎉','⭐','✨'];

  // ── React ─────────────────────────────────────────────────────────────────
  const handleReact = async (msg: ChatMessage, emoji: string) => {
    try {
      await api.post(`/messages/${msg.id}/react`, { emoji });
      setMessages(prev => prev.map(m =>
        m.id === msg.id
          ? { ...m, reactions: [...(m.reactions ?? []), { emoji, userId: 'me' }] }
          : m
      ));
    } catch { toast.error('反应失败'); }
    setReactPickerId(null);
  };

  // ── Forward ───────────────────────────────────────────────────────────────
  const handleForwardMessage = async (targetId: string) => {
    if (!forwardMsg) return;
    try {
      await api.post(`/conversations/${targetId}/messages`, {
        content_type: 'text',
        content: { body: forwardMsg.text || '' },
      });
      toast.success('已转发');
    } catch { toast.error('转发失败'); }
    setForwardMsg(null);
    setForwardSearch('');
  };

  const handleQuickReply = (qr: typeof quickReplies[0]) => {
    setMsgText(qr.message);
  };

  // ── Resolve ──────────────────────────────────────────────────────────────
  const handleResolve = async () => {
    if (!selected) return;
    try {
      await api.post(`/conversations/${selected.id}/resolve`);
      setSelected(null);
      setConvs(prev => prev.filter(c => c.id !== selected.id));
    } catch { toast.error('完成会话失败'); }
  };

  // ── Render content ───────────────────────────────────────────────────────
  const renderContent = (msg: ChatMessage) => {
    if (msg.media?.url) {
      const isImg = msg.media.mimeType?.startsWith('image/') ?? false;
      const isVid = msg.media.mimeType?.startsWith('video/') ?? false;
      return (
        <div>
          {isImg && <img src={msg.media.url} alt="" className="rounded-xl max-w-full max-h-72" />}
          {isVid && <video src={msg.media.url} controls className="rounded-xl max-w-full max-h-72" />}
          {msg.media.caption && <p className="mt-1 text-sm whitespace-pre-wrap">{msg.media.caption}</p>}
        </div>
      );
    }
    return <p className="whitespace-pre-wrap leading-relaxed">{msg.text}</p>;
  };

  const getStatusIcon = (status: string) => {
    if (status === 'sent') return '✓';
    if (status === 'delivered') return '✓✓';
    if (status === 'read') return <span className="text-blue-400">✓✓</span>;
    if (status === 'failed') return <span className="text-red-400">✗</span>;
    return <span className="text-white/50">○</span>;
  };

  const filteredConvs = convs.filter(c => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (c.contactName?.toLowerCase().includes(q) ?? false)
        || (c.lastMessagePreview?.toLowerCase().includes(q) ?? false);
  });

  return (
    <div className="flex flex-col h-screen bg-[#ededed]">
      {/* ── Top bar ────────────────────────────────────────────────────── */}
      <header className="bg-[#008069] text-white px-4 py-3 flex items-center justify-between shrink-0 shadow">
        <div className="flex items-center gap-3">
          {/* Mobile back */}
          {selected && (
            <button
              onClick={() => { setSelected(null); setSidebarOpen(true); }}
              className="md:hidden p-1 rounded hover:bg-white/20"
            >
              ←
            </button>
          )}
          <span className="font-bold text-lg tracking-wide">红浪漫会所</span>
        </div>
        <div className="flex items-center gap-3">
          <span className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-400' : 'bg-red-400'}`} />
          <span className="text-sm text-white/90 hidden sm:block">{user?.name}</span>
          <button
            onClick={() => { logout(); navigate('/login'); }}
            className="text-xs text-white/70 hover:text-white"
          >
            退出
          </button>
        </div>
      </header>

      {/* ── Main area ──────────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">
        {/* ── Left: conversation list ──────────────────────────────────── */}
        <div
          className={`w-full md:w-80 lg:w-96 bg-white flex flex-col shrink-0 overflow-hidden border-r border-gray-200 ${
            selected && window.innerWidth < 768 && !sidebarOpen ? 'hidden md:flex' : 'flex'
          }`}
        >
          {/* Search */}
          <div className="px-3 py-2 border-b border-gray-100">
            <input
              type="text"
              placeholder="搜索会话..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-emerald-500"
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
                    ? 'text-emerald-600 border-b-2 border-emerald-600'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {FILTER_LABELS[f]}
              </button>
            ))}
          </div>

          {/* List */}
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
                  className={`w-full text-left px-3 py-3 border-b border-gray-50 hover:bg-gray-50 active:bg-gray-100 transition ${
                    selected?.id === conv.id ? 'bg-emerald-50 border-l-4 border-l-emerald-600' : ''
                  }`}
                >
                  <div className="flex items-start gap-3">
                    {/* Avatar */}
                    <div className="w-12 h-12 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center font-semibold text-base shrink-0">
                      {conv.contactName?.charAt(0).toUpperCase() ?? '?'}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-semibold text-gray-900 truncate">
                          {conv.contactName ?? '未命名'}
                        </span>
                        <span className="text-[10px] text-gray-400 shrink-0 ml-1">
                          {fmtTime(conv.lastMessageAt)}
                        </span>
                      </div>
                      <div className="flex items-center gap-1 mt-0.5">
                        <span className="text-xs">{CHANNEL_ICON[conv.channelType] ?? '💬'}</span>
                        <p className="text-xs text-gray-500 truncate flex-1">
                          {conv.lastMessagePreview ?? ''}
                        </p>
                        {conv.unreadCount > 0 && (
                          <span className="w-5 h-5 rounded-full bg-emerald-600 text-white text-[10px] flex items-center justify-center shrink-0 font-medium">
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

        {/* ── Right: chat area ─────────────────────────────────────────── */}
        {selected ? (
          <div className="flex-1 flex flex-col overflow-hidden bg-[#efeae2]">
            {/* Chat header */}
            <div className="bg-[#f0fdf9] border-b border-emerald-100 px-4 py-3 flex items-center justify-between shrink-0 shadow-sm">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center font-semibold text-sm shrink-0">
                  {selected.contactName?.charAt(0).toUpperCase() ?? '?'}
                </div>
                <div>
                  <h3 className="font-semibold text-gray-900">
                    {selected.contactName ?? '未命名'}
                  </h3>
                  <p className="text-xs text-gray-500">
                    {CHANNEL_ICON[selected.channelType]} {selected.channelType}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {selected.status !== 'resolved' && (
                  <button
                    onClick={handleResolve}
                    className="px-3 py-1.5 text-xs bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition shadow-sm"
                  >
                    完成会话
                  </button>
                )}
              </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-1">
              {loadingMsgs ? (
                <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
                  加载消息中...
                </div>
              ) : messages.length === 0 ? (
                <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
                  暂无消息，开始对话吧
                </div>
              ) : (
                messages.map(msg => (
                  <div
                    key={msg.tempId ?? msg.id}
                    className={`group flex min-w-0 ${msg.direction === 'outbound' ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`max-w-[70%] min-w-0 rounded-2xl px-3 py-2 shadow-sm relative ${
                        msg.direction === 'outbound'
                          ? 'bg-[#d9fdd3] text-gray-900 rounded-br-sm'
                          : 'bg-white text-gray-900 rounded-bl-sm'
                      }`}
                    >
                      {/* Reply quote */}
                      {msg.context?.messageId && (
                        <div className={`mb-1.5 border-l-3 px-2 py-1 rounded text-xs ${
                          msg.direction === 'outbound'
                            ? 'border-white/50 bg-white/20 text-gray-700'
                            : 'border-emerald-400 bg-gray-50 text-gray-600'
                        }`}>
                          <div className="font-medium text-[10px] opacity-70">
                            {msg.context.from === 'outbound' ? '我' : '客户'}
                          </div>
                          <div className="truncate max-w-[200px]">{msg.context.text || '引用消息'}</div>
                        </div>
                      )}

                      {/* Content */}
                      <div className="text-sm leading-relaxed">{renderContent(msg)}</div>

                      {/* Meta row */}
                      <div className={`flex items-center justify-end gap-1 mt-0.5 ${
                        msg.direction === 'outbound' ? 'text-gray-500' : 'text-gray-400'
                      }`}>
                        <span className="text-[10px]">{fmtFullTime(msg.createdAt)}</span>
                        {msg.direction === 'outbound' && (
                          <span className="text-xs">{getStatusIcon(msg.status)}</span>
                        )}
                        {/* Actions */}
                        <button
                          onClick={() => setReactPickerId(reactPickerId === msg.id ? null : msg.id)}
                          className="opacity-0 group-hover:opacity-100 ml-1 text-sm leading-none"
                        >
                          😊
                        </button>
                        <button
                          onClick={() => setReplyTo(msg)}
                          className="opacity-0 group-hover:opacity-100 text-sm leading-none"
                        >
                          ↩
                        </button>
                        <button
                          onClick={() => setForwardMsg(msg)}
                          className="opacity-0 group-hover:opacity-100 text-sm leading-none"
                        >
                          ↗
                        </button>
                      </div>

                      {/* Reactions */}
                      {msg.reactions && msg.reactions.length > 0 && (
                        <div className={`flex gap-0.5 -mt-0.5 ${msg.direction === 'outbound' ? 'justify-end' : ''}`}>
                          {msg.reactions.map((r, i) => (
                            <span key={i} className={`text-xs rounded-full px-1.5 py-0.5 ${
                              msg.direction === 'outbound' ? 'bg-[#d9fdd3] border border-white/30' : 'bg-gray-100'
                            }`}>{r.emoji}</span>
                          ))}
                        </div>
                      )}

                      {/* React picker */}
                      {reactPickerId === msg.id && (
                        <div className={`absolute bottom-full mb-1 flex gap-0.5 rounded-full px-2 py-1 shadow-lg z-10 ${
                          msg.direction === 'outbound' ? 'right-0 bg-[#d9fdd3]' : 'left-0 bg-white border border-gray-200'
                        }`}>
                          {EMOJIS.slice(0, 8).map(e => (
                            <button key={e} onClick={() => handleReact(msg, e)} className="text-lg leading-none hover:scale-125 transition-transform">
                              {e}
                            </button>
                          ))}
                        </div>
                      )}

                      {/* Failed */}
                      {msg.status === 'failed' && (
                        <div className="text-[10px] text-red-400 mt-0.5">发送失败 ✗</div>
                      )}
                    </div>
                  </div>
                ))
              )}

              {/* Typing */}
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
                replyTo.direction === 'outbound' ? 'bg-emerald-50' : 'bg-gray-50'
              }`}>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium text-gray-600">
                    回复: {replyTo.direction === 'outbound' ? '我' : '客户'}
                  </div>
                  <div className="text-xs text-gray-500 truncate">{replyTo.text || '[媒体消息]'}</div>
                </div>
                <button onClick={() => setReplyTo(null)} className="text-gray-400 hover:text-gray-600 text-lg leading-none">✕</button>
              </div>
            )}

            {/* Quick replies */}
            {quickReplies.length > 0 && (
              <div className="px-4 py-2 border-t border-gray-100 bg-white flex gap-2 overflow-x-auto">
                {quickReplies.slice(0, 5).map(qr => (
                  <button
                    key={qr.id}
                    onClick={() => handleQuickReply(qr)}
                    className="shrink-0 text-xs px-3 py-1.5 rounded-full border border-emerald-200 text-emerald-700 hover:bg-emerald-50 whitespace-nowrap"
                  >
                    {qr.title}
                  </button>
                ))}
              </div>
            )}

            {/* Input */}
            <div className="p-3 border-t border-gray-200 bg-white flex items-end gap-2 relative">
              <button
                onClick={() => setShowEmoji(v => !v)}
                className={`p-2 rounded-full hover:bg-gray-100 shrink-0 transition ${showEmoji ? 'text-emerald-600 bg-emerald-50' : 'text-gray-500'}`}
              >
                😊
              </button>

              {showEmoji && (
                <div className="absolute bottom-16 left-3 z-50 bg-white rounded-2xl border shadow-xl p-2 w-64 flex flex-wrap gap-0.5">
                  {EMOJIS.map(e => (
                    <button
                      key={e}
                      onClick={() => { setMsgText(t => t + e); setShowEmoji(false); }}
                      className="text-xl p-1 hover:bg-gray-100 rounded-lg"
                    >
                      {e}
                    </button>
                  ))}
                </div>
              )}

              <textarea
                value={msgText}
                onChange={e => {
                  setMsgText(e.target.value);
                  if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
                  if (selected && e.target.value.length > 0) {
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
                placeholder="输入消息..."
                rows={1}
                className="flex-1 resize-none rounded-2xl border border-gray-200 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 max-h-28 overflow-y-auto"
                style={{ minHeight: '44px' }}
              />

              <button
                onClick={handleSend}
                disabled={!msgText.trim() || sending}
                className="bg-emerald-600 hover:bg-emerald-700 text-white rounded-full w-10 h-10 flex items-center justify-center transition disabled:opacity-40 shrink-0"
              >
                {sending ? (
                  <div className="w-5 h-5 border-2 border-white/50 border-t-white rounded-full animate-spin" />
                ) : (
                  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
                  </svg>
                )}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex-1 hidden md:flex items-center justify-center bg-[#f0f0f0]">
            <div className="text-center">
              <div className="text-6xl mb-4">💬</div>
              <h3 className="text-xl font-medium text-gray-500">选择会话开始聊天</h3>
              <p className="text-sm text-gray-400 mt-2">从左侧选择一个会话进行回复</p>
            </div>
          </div>
        )}
      </div>

      {/* Forward modal */}
      {forwardMsg && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          onClick={() => { setForwardMsg(null); setForwardSearch(''); }}
        >
          <div
            className="bg-white rounded-2xl p-6 w-[380px] max-h-[70vh] overflow-hidden flex flex-col shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-semibold text-gray-900">转发消息</h3>
              <button onClick={() => { setForwardMsg(null); setForwardSearch(''); }} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
            </div>
            <div className="p-3 bg-gray-50 rounded-xl mb-3 text-sm text-gray-600 max-h-20 overflow-hidden">
              {forwardMsg.text || '[媒体消息]'}
            </div>
            <input
              type="text"
              placeholder="搜索联系人..."
              value={forwardSearch}
              onChange={e => setForwardSearch(e.target.value)}
              className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
            <div className="flex-1 overflow-y-auto space-y-1">
              {filteredConvs
                .filter(c => !forwardSearch || (c.contactName?.toLowerCase().includes(forwardSearch.toLowerCase()) ?? false))
                .filter(c => c.id !== selected?.id)
                .map(c => (
                  <button
                    key={c.id}
                    onClick={() => handleForwardMessage(c.id)}
                    className="w-full flex items-center gap-3 p-3 rounded-xl hover:bg-emerald-50 active:bg-emerald-100 text-left transition"
                  >
                    <div className="w-10 h-10 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center font-semibold text-sm shrink-0">
                      {c.contactName?.charAt(0).toUpperCase() ?? '?'}
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
