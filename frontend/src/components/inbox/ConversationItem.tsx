import type { ConversationSummary } from '../../types';

const CHANNEL_LABELS: Record<string, string> = {
  whatsapp: 'WA',
  line:     'LINE',
  email:    'Email',
  telegram: 'TG',
  sms:      'SMS',
};

const PRIORITY_BORDER: Record<string, string> = {
  urgent: 'border-l-4 border-l-red-500',
  high:   'border-l-4 border-l-orange-400',
  normal: '',
  low:    '',
};

function relativeTime(iso: string | null): string {
  if (!iso) return '';
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60)    return '刚刚';
  if (diff < 3600)  return `${Math.floor(diff / 60)}分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`;
  return `${Math.floor(diff / 86400)}天前`;
}

interface Props {
  conv: ConversationSummary;
  isActive: boolean;
  currentAgentId: string;
  onClick: () => void;
}

export default function ConversationItem({ conv, isActive, currentAgentId, onClick }: Props) {
  const isUnread = conv.unreadCount > 0;
  const isPending = conv.status === 'pending';
  const isAssignedToMe = conv.assignedAgentId === currentAgentId;

  return (
    <button
      onClick={onClick}
      className={[
        'w-full text-left px-4 py-3 flex gap-3 transition-colors',
        isActive  ? 'bg-brand-50 border-l-4 border-l-brand-500' : 'hover:bg-gray-50',
        !isActive && PRIORITY_BORDER[conv.priority],
        isPending && !isActive ? 'border-l-4 border-l-yellow-400' : '',
      ].join(' ')}
    >
      {/* Channel icon */}
      <div className="mt-0.5 w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center text-xs font-bold text-gray-600 shrink-0">
        {CHANNEL_LABELS[conv.channelType] ?? '?'}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className={`text-sm truncate ${isUnread ? 'font-semibold text-gray-900' : 'text-gray-700'}`}>
            {conv.contactName ?? '未命名'}
          </span>
          <span className="text-xs text-gray-400 shrink-0">
            {relativeTime(conv.lastMessageAt)}
          </span>
        </div>

        <div className="flex items-center justify-between gap-2 mt-0.5">
          <p className={`text-xs truncate ${isUnread ? 'text-gray-700' : 'text-gray-400'}`}>
            {conv.lastMessageDirection === 'outbound' && <span className="text-brand-500 mr-1">我：</span>}
            {conv.lastMessagePreview ?? ''}
          </p>
          {isUnread && (
            <span className="bg-brand-600 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center shrink-0">
              {conv.unreadCount > 9 ? '9+' : conv.unreadCount}
            </span>
          )}
        </div>

        {!isAssignedToMe && conv.assignedAgentName && (
          <p className="text-xs text-purple-500 truncate mt-0.5">
            {conv.assignedAgentName}
          </p>
        )}
      </div>
    </button>
  );
}
