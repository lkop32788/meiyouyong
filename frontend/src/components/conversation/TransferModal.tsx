import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import api from '../../lib/api';
import { extractApiError } from '../../lib/apiError';
import { useAuthStore } from '../../stores/useAuthStore';

interface AgentOption {
  id: string;
  name: string;
  email: string;
  role: string;
  is_active: boolean;
  status?: string;
  max_concurrent_chats?: number;
}

const ROLE_LABEL: Record<string, string> = {
  super_admin: '超级管理员',
  admin: '管理员',
  supervisor: '主管',
  agent: '客服',
};

const STATUS_STYLE: Record<string, string> = {
  online: 'bg-green-500',
  busy: 'bg-yellow-500',
  away: 'bg-gray-400',
};

interface Props {
  conversationId: string;
  currentAgentId: string | null;
  onClose: () => void;
  onTransferred: (agentId: string, agentName: string) => void;
}

export default function TransferModal({ conversationId, currentAgentId, onClose, onTransferred }: Props) {
  const me = useAuthStore((s) => s.user);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [savingId, setSavingId] = useState<string | null>(null);

  useEffect(() => {
    api.get('/agents')
      .then((r) => setAgents((r.data?.data ?? []).filter((a: AgentOption) => a.is_active)))
      .catch((e) => toast.error(extractApiError(e, '加载客服列表失败')))
      .finally(() => setLoading(false));
  }, []);

  const visible = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    const matches = keyword
      ? agents.filter((a) => a.name.toLowerCase().includes(keyword) || a.email.toLowerCase().includes(keyword))
      : agents;

    // Online first, then by name — the useful order when handing a live
    // conversation to someone who can pick it up now.
    return [...matches].sort((a, b) => {
      const aOn = a.status === 'online' ? 0 : 1;
      const bOn = b.status === 'online' ? 0 : 1;
      return aOn !== bOn ? aOn - bOn : a.name.localeCompare(b.name);
    });
  }, [agents, search]);

  const transfer = async (agent: AgentOption) => {
    if (agent.id === currentAgentId) { onClose(); return; }

    setSavingId(agent.id);
    try {
      await api.post(`/conversations/${conversationId}/assign`, { agent_id: agent.id });
      toast.success(`已转接给「${agent.name}」`);
      onTransferred(agent.id, agent.name);
      onClose();
    } catch (e: unknown) {
      toast.error(extractApiError(e, '转接失败'));
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-xl w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-bold text-gray-900 mb-1">转接会话</h2>
        <p className="text-sm text-gray-500 mb-4">选择接手的客服，会话状态会同步变为进行中。</p>

        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索姓名或邮箱"
          autoFocus
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-brand-500"
        />

        {loading ? (
          <p className="text-gray-400 text-sm py-6 text-center">加载中...</p>
        ) : visible.length === 0 ? (
          <p className="text-gray-400 text-sm py-6 text-center">
            {agents.length === 0 ? '暂无可转接的客服' : '没有符合条件的客服'}
          </p>
        ) : (
          <div className="space-y-1 max-h-80 overflow-y-auto">
            {visible.map((a) => {
              const isCurrent = a.id === currentAgentId;
              const status = a.status ?? 'offline';
              return (
                <button
                  key={a.id}
                  onClick={() => transfer(a)}
                  disabled={savingId !== null}
                  className={`w-full flex items-center gap-3 p-2.5 rounded-lg border text-left transition disabled:opacity-50 ${
                    isCurrent ? 'border-brand-400 bg-brand-50' : 'border-gray-200 hover:bg-gray-50'
                  }`}
                >
                  <span className="w-8 h-8 rounded-full bg-brand-100 text-brand-700 flex items-center justify-center text-xs font-bold shrink-0">
                    {a.name?.charAt(0) ?? '?'}
                  </span>
                  <span className={`w-2 h-2 rounded-full shrink-0 ${STATUS_STYLE[status] ?? 'bg-gray-300'}`} />
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-medium text-gray-900 truncate">
                      {a.name}
                      {a.id === me?.id && <span className="text-xs text-gray-400 ml-1">（我）</span>}
                    </span>
                    <span className="block text-xs text-gray-400 truncate">{a.email}</span>
                  </span>
                  <span className="text-xs text-gray-400 shrink-0">
                    {isCurrent ? '当前负责' : ROLE_LABEL[a.role] ?? a.role}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        <div className="mt-5 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50"
          >
            取消
          </button>
        </div>
      </div>
    </div>
  );
}
