import api from '../../lib/api';
import { useConversationStore } from '../../stores/useConversationStore';
import { useInboxStore } from '../../stores/useInboxStore';

const CHANNEL_LABEL: Record<string, string> = {
  whatsapp: 'WhatsApp',
  line:     'LINE',
  email:    'Email',
  telegram: 'Telegram',
  sms:      'SMS',
};

const STATUS_BADGE: Record<string, string> = {
  open:     'bg-green-100 text-green-700',
  pending:  'bg-yellow-100 text-yellow-700',
  snoozed:  'bg-blue-100 text-blue-700',
  resolved: 'bg-gray-100 text-gray-500',
};

export default function ConversationHeader() {
  const { detail, openConversation, closeConversation, activeConversationId } = useConversationStore();
  const { removeConversation } = useInboxStore();

  if (!detail || !activeConversationId) return null;

  const resolve = async () => {
    // Optimistic
    closeConversation();
    removeConversation(activeConversationId);
    try {
      await api.post(`/conversations/${activeConversationId}/resolve`);
    } catch {
      // Rollback — re-open conversation
      openConversation(activeConversationId);
    }
  };

  const reopen = async () => {
    await api.post(`/conversations/${activeConversationId}/reopen`);
    openConversation(activeConversationId);
  };

  return (
    <div className="bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between gap-4 shrink-0">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h2 className="font-semibold text-gray-900 truncate">{detail.contactName ?? '未命名'}</h2>
          <span className="text-xs bg-gray-100 text-gray-600 rounded px-1.5 py-0.5 shrink-0">
            {CHANNEL_LABEL[detail.channelType] ?? detail.channelType}
          </span>
          <span className={`text-xs rounded px-1.5 py-0.5 shrink-0 ${STATUS_BADGE[detail.status]}`}>
            {detail.status}
          </span>
        </div>

        {detail.assignedAgentName && (
          <p className="text-xs text-gray-400 mt-0.5">
            客服：{detail.assignedAgentName}
          </p>
        )}
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {detail.status !== 'resolved' ? (
          <button
            onClick={resolve}
            className="text-xs bg-green-600 hover:bg-green-700 text-white rounded px-3 py-1.5 transition"
          >
            完成会话
          </button>
        ) : (
          <button
            onClick={reopen}
            className="text-xs bg-blue-600 hover:bg-blue-700 text-white rounded px-3 py-1.5 transition"
          >
重新打开
          </button>
        )}
      </div>
    </div>
  );
}
