import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import api from '../../lib/api';
import { useAuthStore } from '../../stores/useAuthStore';

interface AgentRow {
  id: string;
  name: string;
  email: string;
  role: string;
  is_active: boolean;
  max_concurrent_chats?: number;
  status?: string;
}

interface ChannelRow {
  id: string;
  name: string;
  type: string;
  is_active: boolean;
}

interface AgentChannelRow {
  id: string;
  agent_id: string;
  channel_id: string;
  channel_name: string;
  channel_type: string;
}

const ROLE_LABEL: Record<string, string> = {
  super_admin: '超级管理员',
  admin: '管理员',
  supervisor: '主管',
  agent: '客服',
};

const ROLE_OPTIONS = ['admin', 'supervisor', 'agent'] as const;

const EMPTY_FORM = {
  name: '',
  email: '',
  password: '',
  role: 'agent' as string,
  max_concurrent_chats: 5,
};

export default function AgentsSettingsPage() {
  const me = useAuthStore((s) => s.user);
  const [agents, setAgents]   = useState<AgentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInactive, setShowInactive] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);

  // Channel assignment modal state
  const [channelModalOpen, setChannelModalOpen] = useState(false);
  const [channelAgentId, setChannelAgentId] = useState<string | null>(null);
  const [channelAgentName, setChannelAgentName] = useState('');
  const [allChannels, setAllChannels] = useState<ChannelRow[]>([]);
  const [assignedChannels, setAssignedChannels] = useState<AgentChannelRow[]>([]);
  const [channelLoading, setChannelLoading] = useState(false);
  const [channelSaving, setChannelSaving] = useState(false);

  const isAdmin = me?.role === 'super_admin' || me?.role === 'admin';
  const isSupervisor = me?.role === 'supervisor';
  const canManage = isAdmin || isSupervisor;

  const load = useCallback((includeInactive: boolean) => {
    setLoading(true);
    api.get('/agents', { params: includeInactive ? { include_inactive: true } : {} })
      .then((r) => setAgents(r.data?.data ?? []))
      .catch(() => toast.error('加载客服列表失败'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(showInactive); }, [load, showInactive]);

  const openCreate = () => {
    setEditingId(null);
    setForm({ ...EMPTY_FORM });
    setModalOpen(true);
  };

  const openEdit = (a: AgentRow) => {
    setEditingId(a.id);
    setForm({
      name: a.name,
      email: a.email,
      password: '',
      role: a.role === 'super_admin' ? 'admin' : a.role,
      max_concurrent_chats: a.max_concurrent_chats ?? 5,
    });
    setModalOpen(true);
  };

  const submit = async () => {
    if (!form.name.trim() || !form.email.trim()) { toast.error('请填写姓名和邮箱'); return; }

    setSaving(true);
    try {
      if (editingId) {
        await api.put(`/agents/${editingId}`, {
          name: form.name,
          role: form.role,
          max_concurrent_chats: form.max_concurrent_chats,
          ...(form.password ? { password: form.password } : {}),
        });
        toast.success('成员已更新');
      } else {
        if (form.password.length < 8) { toast.error('密码至少 8 位'); setSaving(false); return; }
        await api.post('/agents', {
          name: form.name,
          email: form.email,
          password: form.password,
          role: form.role,
          max_concurrent_chats: form.max_concurrent_chats,
        });
        toast.success('成员已添加');
      }
      setModalOpen(false);
      load(showInactive);
    } catch (e: unknown) {
      const err = e as { response?: { data?: { message?: string; errors?: Record<string, string[]> } } };
      const firstFieldError = err?.response?.data?.errors
        ? Object.values(err.response.data.errors)[0]?.[0]
        : undefined;
      toast.error(firstFieldError ?? err?.response?.data?.message ?? '保存失败，请重试');
    } finally {
      setSaving(false);
    }
  };

  const deactivate = async (a: AgentRow) => {
    if (!window.confirm(`确定停用「${a.name}」吗？停用后该成员将立即无法登录。`)) return;
    try {
      await api.delete(`/agents/${a.id}`);
      toast.success('成员已停用');
      load(showInactive);
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message;
      toast.error(msg ?? '停用失败');
    }
  };

  // ── Channel assignment ───────────────────────────────────────────────────────

  const openChannelModal = async (agent: AgentRow) => {
    setChannelAgentId(agent.id);
    setChannelAgentName(agent.name);
    setChannelModalOpen(true);
    setChannelLoading(true);

    try {
      const [channelsRes, assignedRes] = await Promise.all([
        api.get('/channels'),
        api.get('/agent-channels', { params: { agent_id: agent.id } }),
      ]);

      const activeChannels = (channelsRes.data?.data ?? []).filter(
        (c: ChannelRow) => c.is_active
      );
      setAllChannels(activeChannels);
      setAssignedChannels(assignedRes.data ?? []);
    } catch {
      toast.error('加载渠道列表失败');
    } finally {
      setChannelLoading(false);
    }
  };

  const removeAssignedChannel = async (assignmentId: string) => {
    try {
      await api.delete(`/agent-channels/${assignmentId}`);
      setAssignedChannels((prev) => prev.filter((a) => a.id !== assignmentId));
    } catch {
      toast.error('移除失败');
    }
  };

  const addChannel = async (channelId: string) => {
    if (!channelAgentId) return;
    try {
      const res = await api.post('/agent-channels', {
        agent_id: channelAgentId,
        channel_id: channelId,
      });
      const newRow: AgentChannelRow = {
        id: res.data.id,
        agent_id: channelAgentId,
        channel_id: channelId,
        channel_name: allChannels.find((c) => c.id === channelId)?.name ?? '',
        channel_type: allChannels.find((c) => c.id === channelId)?.type ?? '',
      };
      setAssignedChannels((prev) => [...prev, newRow]);
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message;
      toast.error(msg ?? '添加失败');
    }
  };

  const assignedChannelIds = new Set(assignedChannels.map((a) => a.channel_id));
  const availableChannels = allChannels.filter((c) => !assignedChannelIds.has(c.id));

  const canEditRow = (a: AgentRow) =>
    canManage && a.id !== me?.id && !['super_admin'].includes(a.role);

  return (
    <div className="p-6 max-w-5xl mx-auto h-full overflow-y-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900">客服管理</h1>
          <p className="text-sm text-gray-400 mt-1">团队成员与角色 · {agents.filter((a) => a.is_active).length} 人在职</p>
        </div>
        <div className="flex items-center gap-3">
          {isAdmin && (
            <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer">
              <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
              显示已停用
            </label>
          )}
          {canManage && (
            <button onClick={openCreate} className="bg-brand-600 hover:bg-brand-700 text-white text-sm rounded-lg px-4 py-2">
              + 添加客服
            </button>
          )}
        </div>
      </div>

      {loading ? (
        <p className="text-gray-400 text-sm">加载中...</p>
      ) : agents.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <p className="text-lg mb-2">暂无客服成员</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600">成员</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">邮箱</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">角色</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">状态</th>
                {canManage && <th className="text-right px-4 py-3 font-medium text-gray-600">操作</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {agents.map((a) => (
                <tr key={a.id} className={`hover:bg-gray-50 ${!a.is_active ? 'opacity-50' : ''}`}>
                  <td className="px-4 py-3 font-medium text-gray-900">
                    <span className="inline-flex items-center gap-2">
                      <span className="w-7 h-7 rounded-full bg-brand-100 text-brand-700 flex items-center justify-center text-xs font-bold">
                        {a.name?.charAt(0) ?? '?'}
                      </span>
                      {a.name}
                      {a.id === me?.id && <span className="text-xs text-gray-400">（我）</span>}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-500">{a.email}</td>
                  <td className="px-4 py-3 text-gray-500">{ROLE_LABEL[a.role] ?? a.role}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-block text-xs rounded-full px-2 py-0.5 font-medium ${a.is_active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                      {a.is_active ? '启用' : '已停用'}
                    </span>
                  </td>
                  {canManage && (
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      {canEditRow(a) ? (
                        <>
                          <button onClick={() => openEdit(a)} className="text-xs text-brand-600 hover:underline mr-3">编辑</button>
                          <button onClick={() => openChannelModal(a)} className="text-xs text-gray-500 hover:text-gray-700 mr-3 border border-gray-300 rounded px-1.5 py-0.5">分配渠道</button>
                          <button onClick={() => deactivate(a)} className="text-xs text-red-500 hover:underline">停用</button>
                        </>
                      ) : (
                        <span className="text-xs text-gray-300">—</span>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create/Edit modal */}
      {modalOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setModalOpen(false)}>
          <div className="bg-white rounded-xl w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-gray-900 mb-4">{editingId ? '编辑成员' : '添加客服成员'}</h2>

            <label className="block text-sm text-gray-600 mb-1">姓名</label>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-brand-500"
            />

            {!editingId && (
              <>
                <label className="block text-sm text-gray-600 mb-1">邮箱</label>
                <input
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
                <label className="block text-sm text-gray-600 mb-1">初始密码（至少 8 位）</label>
                <input
                  type="password"
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </>
            )}

            <label className="block text-sm text-gray-600 mb-1">角色</label>
            <select
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              {ROLE_OPTIONS.map((r) => (
                <option key={r} value={r}>{ROLE_LABEL[r]}</option>
              ))}
            </select>

            <label className="block text-sm text-gray-600 mb-1">最大并行会话数</label>
            <input
              type="number"
              min={1}
              max={50}
              value={form.max_concurrent_chats}
              onChange={(e) => setForm({ ...form, max_concurrent_chats: Number(e.target.value) })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-brand-500"
            />

            <div className="flex justify-end gap-2">
              <button onClick={() => setModalOpen(false)} className="px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50">取消</button>
              <button
                onClick={submit}
                disabled={saving}
                className="px-4 py-2 text-sm rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50"
              >
                {saving ? '保存中...' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Channel assignment modal */}
      {channelModalOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setChannelModalOpen(false)}>
          <div className="bg-white rounded-xl w-full max-w-lg p-6 max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-gray-900 mb-1">分配渠道</h2>
            <p className="text-sm text-gray-500 mb-4">为「{channelAgentName}」分配可处理的渠道号码。客服只能看到分配渠道的会话。</p>

            {channelLoading ? (
              <p className="text-gray-400 text-sm">加载中...</p>
            ) : (
              <>
                {/* Assigned channels */}
                <div className="mb-4">
                  <h3 className="text-sm font-medium text-gray-700 mb-2">已分配渠道</h3>
                  {assignedChannels.length === 0 ? (
                    <p className="text-xs text-gray-400">暂未分配任何渠道。该客服将无法看到任何会话。</p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {assignedChannels.map((ac) => (
                        <span key={ac.id} className="inline-flex items-center gap-1 bg-green-100 text-green-800 text-xs rounded-full px-3 py-1">
                          <span className="font-medium">{ac.channel_name || ac.channel_type}</span>
                          <button
                            onClick={() => removeAssignedChannel(ac.id)}
                            className="ml-1 hover:text-red-600 font-bold"
                            title="移除"
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                {/* Add channel */}
                {availableChannels.length > 0 && (
                  <div>
                    <h3 className="text-sm font-medium text-gray-700 mb-2">添加渠道</h3>
                    <div className="flex flex-wrap gap-2">
                      {availableChannels.map((c) => (
                        <button
                          key={c.id}
                          onClick={() => addChannel(c.id)}
                          className="inline-flex items-center gap-1 bg-gray-100 hover:bg-gray-200 text-gray-700 text-xs rounded-full px-3 py-1 transition"
                        >
                          <span className="font-medium">{c.name || c.type}</span>
                          <span className="text-gray-400">+</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {allChannels.length === 0 && (
                  <p className="text-xs text-gray-400">当前公司没有已激活的渠道。</p>
                )}
              </>
            )}

            <div className="mt-6 pt-4 border-t border-gray-200 flex justify-end">
              <button
                onClick={() => setChannelModalOpen(false)}
                className="px-4 py-2 text-sm rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
