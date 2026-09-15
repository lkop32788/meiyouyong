import { useCallback, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import api from '../../lib/api';
import { extractApiError } from '../../lib/apiError';
import { useAuthStore } from '../../stores/useAuthStore';
import type { AgentRole } from '../../types';

interface AgentRow {
  id: string;
  name: string;
  email: string;
  role: AgentRole;
  is_active: boolean;
  max_concurrent_chats?: number;
  skill_tags?: string[];
  status?: string;
  last_seen?: string | null;
}

interface ChannelRow {
  id: string;
  name: string;
  type: string;
  display_phone_number?: string | null;
  is_active: boolean;
}

interface AgentChannelRow {
  id: string;
  agent_id: string;
  channel_id: string;
  channel_name: string | null;
  channel_type: string | null;
  display_phone_number: string | null;
}

const ROLE_LABEL: Record<string, string> = {
  super_admin: '超级管理员',
  admin: '管理员',
  supervisor: '主管',
  agent: '客服',
};

const CHANNEL_TYPE_LABEL: Record<string, string> = {
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  line: 'LINE',
  email: 'Email',
  facebook: 'Facebook',
  instagram: 'Instagram',
  webchat: '网页聊天',
};

// Same visual language as the inbox PresenceSidebar. offline is absent on
// purpose so it falls through to grey.
const STATUS_STYLE: Record<string, string> = {
  online: 'bg-green-500',
  busy: 'bg-yellow-500',
  away: 'bg-gray-400',
};

const STATUS_LABEL: Record<string, string> = {
  online: '在线',
  busy: '忙碌',
  away: '离开',
  offline: '离线',
};

/** Mirrors User::assignableRoles() on the backend. */
function assignableRoles(actorRole?: AgentRole): AgentRole[] {
  switch (actorRole) {
    case 'super_admin':
    case 'admin':
      return ['admin', 'supervisor', 'agent'];
    case 'supervisor':
      return ['agent'];
    default:
      return [];
  }
}

/** Mirrors User::canManageMember() on the backend. */
function canManageMember(actorRole: AgentRole | undefined, targetRole: AgentRole): boolean {
  switch (actorRole) {
    case 'super_admin':
      return true;
    case 'admin':
      return targetRole !== 'super_admin';
    case 'supervisor':
      return targetRole === 'agent';
    default:
      return false;
  }
}

function relativeTime(iso?: string | null): string {
  if (!iso) return '无记录';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '无记录';

  const minutes = Math.floor((Date.now() - then) / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;

  return `${Math.floor(hours / 24)} 天前`;
}

const EMPTY_FORM = {
  name: '',
  email: '',
  password: '',
  role: 'agent' as AgentRole,
  max_concurrent_chats: 5,
  skill_tags: [] as string[],
};

export default function AgentsSettingsPage() {
  const me = useAuthStore((s) => s.user);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [allChannels, setAllChannels] = useState<ChannelRow[]>([]);
  const [allAssignments, setAllAssignments] = useState<AgentChannelRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInactive, setShowInactive] = useState(false);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [skillDraft, setSkillDraft] = useState('');
  const [saving, setSaving] = useState(false);

  // Assign modal
  const [assignModalOpen, setAssignModalOpen] = useState(false);
  const [assignAgentId, setAssignAgentId] = useState<string | null>(null);
  const [assignAgentName, setAssignAgentName] = useState('');
  const [assignSelected, setAssignSelected] = useState<string[]>([]);
  const [assignSaving, setAssignSaving] = useState(false);

  const myRole = me?.role;
  const canManage = assignableRoles(myRole).length > 0;
  const roleOptions = assignableRoles(myRole);

  const load = useCallback(async (includeInactive: boolean) => {
    setLoading(true);
    try {
      const [agentsRes, channelsRes, assignmentsRes] = await Promise.all([
        api.get('/agents', { params: includeInactive ? { include_inactive: true } : {} }),
        api.get('/channels'),
        api.get('/agent-channels'),
      ]);
      setAgents(agentsRes.data?.data ?? []);
      setAllChannels((channelsRes.data?.data ?? []).filter((c: ChannelRow) => c.is_active));
      setAllAssignments(assignmentsRes.data ?? []);
    } catch (e: unknown) {
      toast.error(extractApiError(e, '加载失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(showInactive); }, [load, showInactive]);

  const getAgentChannels = useCallback(
    (agentId: string) => allAssignments.filter((a) => a.agent_id === agentId),
    [allAssignments]
  );

  const visibleAgents = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return agents.filter((a) => {
      if (roleFilter && a.role !== roleFilter) return false;
      if (!keyword) return true;
      return a.name.toLowerCase().includes(keyword) || a.email.toLowerCase().includes(keyword);
    });
  }, [agents, search, roleFilter]);

  const openCreate = () => {
    setEditingId(null);
    setForm({ ...EMPTY_FORM, role: roleOptions[roleOptions.length - 1] ?? 'agent' });
    setSkillDraft('');
    setModalOpen(true);
  };

  const openEdit = (a: AgentRow) => {
    setEditingId(a.id);
    setForm({
      name: a.name,
      email: a.email,
      password: '',
      role: a.role,
      max_concurrent_chats: a.max_concurrent_chats ?? 5,
      skill_tags: a.skill_tags ?? [],
    });
    setSkillDraft('');
    setModalOpen(true);
  };

  // ── Skill tag chips ──────────────────────────────────────────────────────────

  const addSkill = () => {
    const tag = skillDraft.trim();
    if (!tag) return;
    if (tag.length > 50) { toast.error('技能标签最长 50 个字符'); return; }
    if (form.skill_tags.includes(tag)) { setSkillDraft(''); return; }
    setForm((f) => ({ ...f, skill_tags: [...f.skill_tags, tag] }));
    setSkillDraft('');
  };

  const removeSkill = (tag: string) =>
    setForm((f) => ({ ...f, skill_tags: f.skill_tags.filter((t) => t !== tag) }));

  // ── Create / edit ────────────────────────────────────────────────────────────

  const submit = async () => {
    if (!form.name.trim() || !form.email.trim()) { toast.error('请填写姓名和邮箱'); return; }
    setSaving(true);
    try {
      if (editingId) {
        await api.put(`/agents/${editingId}`, {
          name: form.name,
          role: form.role,
          max_concurrent_chats: form.max_concurrent_chats,
          skill_tags: form.skill_tags,
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
          skill_tags: form.skill_tags,
        });
        toast.success('成员已添加');
      }
      setModalOpen(false);
      load(showInactive);
    } catch (e: unknown) {
      toast.error(extractApiError(e, '保存失败'));
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
      toast.error(extractApiError(e, '停用失败'));
    }
  };

  const restore = async (a: AgentRow) => {
    if (!window.confirm(`确定恢复「${a.name}」吗？恢复后该成员可重新登录，原有渠道分配将一并生效。`)) return;
    try {
      await api.post(`/agents/${a.id}/restore`);
      toast.success('成员已恢复');
      load(showInactive);
    } catch (e: unknown) {
      toast.error(extractApiError(e, '恢复失败'));
    }
  };

  // ── Assign modal ─────────────────────────────────────────────────────────────

  const openAssignModal = (agent: AgentRow) => {
    setAssignAgentId(agent.id);
    setAssignAgentName(agent.name);
    setAssignSelected(getAgentChannels(agent.id).map((a) => a.channel_id));
    setAssignModalOpen(true);
  };

  const toggleChannel = (channelId: string) => {
    setAssignSelected((prev) =>
      prev.includes(channelId) ? prev.filter((id) => id !== channelId) : [...prev, channelId]
    );
  };

  const saveAssignments = async () => {
    if (!assignAgentId) return;
    setAssignSaving(true);
    try {
      const current = getAgentChannels(assignAgentId);
      const currentIds = current.map((a) => a.channel_id);
      const toAdd = assignSelected.filter((id) => !currentIds.includes(id));
      const toRemove = current.filter((a) => !assignSelected.includes(a.channel_id)).map((a) => a.id);

      // allSettled, not all: a partial failure must not leave the table showing
      // a state the server never accepted.
      const results = await Promise.allSettled([
        ...toAdd.map((channelId) => api.post('/agent-channels', { agent_id: assignAgentId, channel_id: channelId })),
        ...toRemove.map((id) => api.delete(`/agent-channels/${id}`)),
      ]);

      const failures = results.filter((r) => r.status === 'rejected');

      if (failures.length === 0) {
        toast.success('渠道分配已保存');
        setAssignModalOpen(false);
      } else {
        const first = (failures[0] as PromiseRejectedResult).reason;
        toast.error(
          `${results.length - failures.length} 项成功，${failures.length} 项失败：${extractApiError(first, '未知错误')}`
        );
      }
    } finally {
      setAssignSaving(false);
      load(showInactive); // always resync with the server
    }
  };

  // ── Row permissions ──────────────────────────────────────────────────────────

  const canActOnRow = (a: AgentRow) =>
    canManage && a.id !== me?.id && canManageMember(myRole, a.role);

  const channelLabel = (assignment: AgentChannelRow) => {
    const channel = allChannels.find((c) => c.id === assignment.channel_id);
    const phone = channel?.display_phone_number ?? assignment.display_phone_number;
    const name = channel?.name ?? assignment.channel_name;
    const type = channel?.type ?? assignment.channel_type ?? '';
    return phone || name || CHANNEL_TYPE_LABEL[type] || type;
  };

  return (
    <div className="p-6 max-w-5xl mx-auto h-full overflow-y-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900">客服账号与号码授权</h1>
          <p className="text-sm text-gray-400 mt-1">创建客服、设置密码并分配可处理的号码</p>
        </div>
        {canManage && (
          <button onClick={openCreate} className="bg-brand-600 hover:bg-brand-700 text-white text-sm rounded-lg px-4 py-2">
            + 添加客服
          </button>
        )}
      </div>

      <div className="flex items-center gap-3 mb-4">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索姓名或邮箱"
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-56 focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        <select
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-36 focus:outline-none focus:ring-2 focus:ring-brand-500"
        >
          <option value="">全部角色</option>
          {Object.entries(ROLE_LABEL).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
        {canManage && (
          <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer">
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
            显示已停用
          </label>
        )}
        <span className="text-xs text-gray-400 ml-auto">共 {visibleAgents.length} 人</span>
      </div>

      {loading ? (
        <p className="text-gray-400 text-sm">加载中...</p>
      ) : visibleAgents.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <p className="text-lg mb-2">{agents.length === 0 ? '暂无客服成员' : '没有符合条件的成员'}</p>
          {agents.length === 0 && canManage && (
            <p className="text-sm">点击右上角「添加客服」创建第一个成员。</p>
          )}
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600">客服</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">账号</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">角色</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">技能标签</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">已分配渠道</th>
                {canManage && <th className="text-right px-4 py-3 font-medium text-gray-600">操作</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {visibleAgents.map((a) => {
                const agentChannels = getAgentChannels(a.id);
                const status = a.status ?? 'offline';
                return (
                  <tr key={a.id} className={`hover:bg-gray-50 ${!a.is_active ? 'opacity-50' : ''}`}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="w-7 h-7 rounded-full bg-brand-100 text-brand-700 flex items-center justify-center text-xs font-bold shrink-0">
                          {a.name?.charAt(0) ?? '?'}
                        </span>
                        <span
                          className={`w-2 h-2 rounded-full shrink-0 ${STATUS_STYLE[status] ?? 'bg-gray-300'}`}
                          title={`${STATUS_LABEL[status] ?? status} · 最后活跃 ${relativeTime(a.last_seen)}`}
                        />
                        <span className="font-medium text-gray-900">{a.name}</span>
                        {a.id === me?.id && <span className="text-xs text-gray-400">（我）</span>}
                        {!a.is_active && <span className="text-xs text-red-400">已停用</span>}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs">{a.email}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-block text-xs rounded-full px-2 py-0.5 font-medium ${a.is_active ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-500'}`}>
                        {ROLE_LABEL[a.role] ?? a.role}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {(a.skill_tags ?? []).length === 0 ? (
                          <span className="text-xs text-gray-300">—</span>
                        ) : (
                          (a.skill_tags ?? []).map((tag) => (
                            <span key={tag} className="text-[11px] bg-brand-100 text-brand-700 rounded-full px-2 py-0.5">
                              {tag}
                            </span>
                          ))
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1.5">
                        {agentChannels.length === 0 ? (
                          <span className="text-xs text-gray-400 italic">未分配</span>
                        ) : (
                          agentChannels.map((ac) => (
                            <span
                              key={ac.id}
                              className="inline-block bg-green-50 border border-green-200 text-green-700 text-xs rounded px-2 py-0.5"
                              title={ac.channel_name ?? undefined}
                            >
                              {channelLabel(ac)}
                            </span>
                          ))
                        )}
                      </div>
                    </td>
                    {canManage && (
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        {!canActOnRow(a) ? (
                          <span className="text-xs text-gray-300">—</span>
                        ) : !a.is_active ? (
                          <button onClick={() => restore(a)} className="text-xs text-brand-600 hover:underline">恢复</button>
                        ) : (
                          <>
                            <button onClick={() => openEdit(a)} className="text-xs text-brand-600 hover:underline mr-3">编辑</button>
                            <button onClick={() => openAssignModal(a)} className="text-xs text-gray-500 hover:text-gray-700 mr-3 border border-gray-300 rounded px-1.5 py-0.5">分配渠道</button>
                            <button onClick={() => deactivate(a)} className="text-xs text-red-500 hover:underline">停用</button>
                          </>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Create/Edit modal */}
      {modalOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setModalOpen(false)}>
          <div className="bg-white rounded-xl w-full max-w-md p-6 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
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
              </>
            )}

            <label className="block text-sm text-gray-600 mb-1">
              {editingId ? '重置密码（留空则不修改）' : '初始密码（至少 8 位）'}
            </label>
            <input
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-brand-500"
            />

            <label className="block text-sm text-gray-600 mb-1">角色</label>
            <select
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value as AgentRole })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              {Array.from(new Set(editingId ? [...roleOptions, form.role] : roleOptions)).map((r) => (
                <option key={r} value={r}>{ROLE_LABEL[r] ?? r}</option>
              ))}
            </select>

            <label className="block text-sm text-gray-600 mb-1">技能标签</label>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {form.skill_tags.map((tag) => (
                <span key={tag} className="text-[11px] bg-brand-100 text-brand-700 rounded-full px-2 py-0.5 flex items-center gap-1">
                  {tag}
                  <button onClick={() => removeSkill(tag)} className="text-brand-500 hover:text-brand-700">×</button>
                </span>
              ))}
            </div>
            <div className="flex gap-2 mb-1">
              <input
                value={skillDraft}
                onChange={(e) => setSkillDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addSkill(); }
                }}
                placeholder="输入后回车添加，如：退款"
                className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
              <button onClick={addSkill} className="px-3 py-2 text-sm rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50">添加</button>
            </div>
            <p className="text-xs text-gray-400 mb-3">用于技能路由；修改后需该客服重新登录才会生效。</p>

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

      {/* Assign channels modal */}
      {assignModalOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setAssignModalOpen(false)}>
          <div className="bg-white rounded-xl w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-gray-900 mb-1">分配渠道</h2>
            <p className="text-sm text-gray-500 mb-4">
              为「{assignAgentName}」分配可处理的渠道号码。客服只能看到分配渠道的会话。
            </p>

            {allChannels.length === 0 ? (
              <p className="text-sm text-gray-400">当前公司没有已激活的渠道。</p>
            ) : (
              <div className="space-y-2 max-h-72 overflow-y-auto">
                {allChannels.map((c) => {
                  const checked = assignSelected.includes(c.id);
                  const label = c.display_phone_number || c.name || CHANNEL_TYPE_LABEL[c.type] || c.type;
                  return (
                    <label
                      key={c.id}
                      className={`flex items-center gap-3 p-2.5 rounded-lg border cursor-pointer transition ${
                        checked ? 'border-brand-400 bg-brand-50' : 'border-gray-200 bg-white hover:bg-gray-50'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleChannel(c.id)}
                        className="w-4 h-4 text-brand-600 rounded focus:ring-brand-500"
                      />
                      <div className="flex-1 min-w-0">
                        <div className={`text-sm font-medium truncate ${checked ? 'text-brand-700' : 'text-gray-900'}`}>
                          {label}
                        </div>
                        {c.display_phone_number && c.name && c.name !== c.display_phone_number && (
                          <div className="text-xs text-gray-400 truncate">{c.name}</div>
                        )}
                      </div>
                      <span className="text-xs text-gray-400 shrink-0">
                        {CHANNEL_TYPE_LABEL[c.type] || c.type}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}

            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setAssignModalOpen(false)}
                className="px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50"
              >
                取消
              </button>
              <button
                onClick={saveAssignments}
                disabled={assignSaving}
                className="px-4 py-2 text-sm rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50"
              >
                {assignSaving ? '保存中...' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
