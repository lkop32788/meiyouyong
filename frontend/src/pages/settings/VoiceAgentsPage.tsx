import { useCallback, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import api from '../../lib/api';

interface Contact {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  tags: string[];
}

// ── Types ────────────────────────────────────────────────────────────────────

interface VoiceStats {
  total_calls: number;
  completed: number;
  missed: number;
  failed: number;
  avg_duration: number;
  success_rate: number;
}

interface VoiceAgent {
  id: string;
  name: string;
  description: string | null;
  engine: 'openai' | 'groq_sarvam';
  system_prompt: string;
  greeting: string;
  voice: string;
  voice_id: string;
  language: string;
  voice_speed: number;
  voice_pitch: number;
  max_duration_seconds: number;
  transfer_number: string | null;
  summary_enabled: boolean;
  is_active: boolean;
  is_default: boolean;
  stats: VoiceStats;
  has_realtime_key: boolean;
  has_groq_key: boolean;
  has_sarvam_key: boolean;
  created_at: string;
}

interface CallSession {
  id: string;
  call_id: string;
  voice_agent_id: string | null;
  agent_name: string | null;
  from_number: string | null;
  to_number: string | null;
  direction: string;
  direction_label: string;
  status: string;
  status_label: string;
  duration_seconds: number;
  duration_formatted: string;
  summary: string | null;
  disposition: string | null;
  recording_url: string | null;
  error: string | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
}

interface VoiceAgentForm {
  name: string;
  description: string;
  engine: 'openai' | 'groq_sarvam';
  system_prompt: string;
  greeting: string;
  voice: string;
  voice_id: string;
  language: string;
  voice_speed: number;
  voice_pitch: number;
  max_duration_seconds: number;
  transfer_number: string;
  summary_enabled: boolean;
  is_active: boolean;
  realtime_api_key: string;
  groq_api_key: string;
  sarvam_api_key: string;
}

interface CallDetail extends CallSession {
  transcript: Array<{ role: string; text: string }>;
}

// ── Constants ────────────────────────────────────────────────────────────────

const OPENAI_VOICES = [
  { value: 'alloy', label: 'Alloy（中性）' },
  { value: 'ash', label: 'Ash（年轻男性）' },
  { value: 'ballad', label: 'Ballad（柔和女声）' },
  { value: 'coral', label: 'Coral（温暖女声）' },
  { value: 'echo', label: 'Echo（回声）' },
  { value: 'sage', label: 'Sage（智者）' },
  { value: 'shimmer', label: 'Shimmer（明亮）' },
  { value: 'verse', label: 'Verse（诗意）' },
];

const SARVAM_VOICES = [
  { value: 'priya', label: 'Priya（印度女声）' },
  { value: 'karun', label: 'Karun（印度男声）' },
  { value: 'hitesh', label: 'Hitesh（印度男声）' },
  { value: 'radha', label: 'Radha（印度女声）' },
  { value: 'arya', label: 'Arya（年轻女声）' },
  { value: 'amol', label: 'Amol（印度男声）' },
  { value: 'shaan', label: 'Shaan（印度男声）' },
  { value: 'peter', label: 'Peter（英文男声）' },
  { value: 'pooja', label: 'Pooja（印度女声）' },
];

const LANGUAGES = [
  { value: 'zh-CN', label: '中文（简体）' },
  { value: 'zh-TW', label: '中文（繁体）' },
  { value: 'en-IN', label: '英语（印度）' },
  { value: 'en-US', label: '英语（美国）' },
  { value: 'hi-IN', label: '印地语' },
  { value: 'ta-IN', label: '泰米尔语' },
  { value: 'te-IN', label: '泰卢固语' },
  { value: 'mr-IN', label: '马拉地语' },
  { value: 'bn-IN', label: '孟加拉语' },
  { value: 'gu-IN', label: '古吉拉特语' },
  { value: 'kn-IN', label: '卡纳达语' },
  { value: 'ml-IN', label: '马拉雅拉姆语' },
];

const STATUS_COLORS: Record<string, string> = {
  completed: 'bg-green-100 text-green-700',
  accepted: 'bg-green-100 text-green-700',
  'ai-connected': 'bg-blue-100 text-blue-700',
  missed: 'bg-yellow-100 text-yellow-700',
  failed: 'bg-red-100 text-red-600',
  rejected: 'bg-red-100 text-red-600',
  initiating: 'bg-gray-100 text-gray-500',
  incoming: 'bg-gray-100 text-gray-500',
  ringing: 'bg-blue-100 text-blue-600',
  connecting: 'bg-gray-100 text-gray-500',
  terminated: 'bg-gray-100 text-gray-400',
};

// ── Component ─────────────────────────────────────────────────────────────────

export default function VoiceAgentsPage() {
  const [agents, setAgents] = useState<VoiceAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingAgent, setEditingAgent] = useState<VoiceAgent | null>(null);
  const [form, setForm] = useState(EMPTY_FORM());
  const [saving, setSaving] = useState(false);

  // Outbound call state
  const [callNumber, setCallNumber] = useState('');
  const [callingAgentId, setCallingAgentId] = useState<string | null>(null);
  const [contactPickerOpen, setContactPickerOpen] = useState(false);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactsLoading, setContactsLoading] = useState(false);

  // Call log detail state
  const [callLogs, setCallLogs] = useState<CallSession[]>([]);
  const [callsLoading, setCallsLoading] = useState(false);
  const [detailSession, setDetailSession] = useState<CallDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const loadAgents = useCallback(async () => {
    try {
      const { data } = await api.get('/voice/agents');
      setAgents(data ?? []);
    } catch {
      toast.error('加载语音坐席失败');
    }
  }, []);

  const loadCallLogs = useCallback(async (agentId?: string) => {
    setCallsLoading(true);
    try {
      const params = agentId ? `?agent_id=${agentId}` : '';
      const { data } = await api.get(`/voice/calls${params}`);
      setCallLogs(data ?? []);
    } catch {
      toast.error('加载通话记录失败');
    } finally {
      setCallsLoading(false);
    }
  }, []);

  const loadContacts = useCallback((q = '') => {
    setContactsLoading(true);
    api.get('/contacts', { params: { page: 1, search: q, limit: 50 } })
      .then((r) => setContacts(r.data.data ?? []))
      .catch(() => toast.error('加载联系人失败'))
      .finally(() => setContactsLoading(false));
  }, []);

  const openContactPicker = () => {
    loadContacts();
    setContactPickerOpen(true);
  };

  const pickContact = (c: Contact) => {
    if (c.phone) {
      setCallNumber(c.phone);
      setContactPickerOpen(false);
      toast.success(`已选择：${c.name}`);
    } else {
      toast.error('该联系人没有手机号');
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    await Promise.all([loadAgents(), loadCallLogs()]);
    setLoading(false);
  }, [loadAgents, loadCallLogs]);

  useEffect(() => { load(); }, [load]);

  // ── Form helpers ─────────────────────────────────────────────────────────────

  function EMPTY_FORM(): VoiceAgentForm {
    return {
      name: '',
      description: '',
      engine: 'openai',
      system_prompt: '',
      greeting: '您好！请问有什么可以帮您？',
      voice: 'alloy',
      voice_id: 'priya',
      language: 'zh-CN',
      voice_speed: 1.0,
      voice_pitch: 1.0,
      max_duration_seconds: 300,
      transfer_number: '',
      summary_enabled: true,
      is_active: false,
      realtime_api_key: '',
      groq_api_key: '',
      sarvam_api_key: '',
    };
  }

  function openCreate() {
    setEditingAgent(null);
    setForm(EMPTY_FORM());
    setModalOpen(true);
  }

  function openEdit(a: VoiceAgent) {
    setEditingAgent(a);
    setForm({
      name: a.name,
      description: a.description ?? '',
      engine: a.engine,
      system_prompt: '',
      greeting: a.greeting,
      voice: a.voice,
      voice_id: a.voice_id,
      language: a.language ?? 'zh-CN',
      voice_speed: a.voice_speed ?? 1.0,
      voice_pitch: a.voice_pitch ?? 1.0,
      max_duration_seconds: a.max_duration_seconds,
      transfer_number: a.transfer_number ?? '',
      summary_enabled: a.summary_enabled,
      is_active: a.is_active,
      realtime_api_key: '',
      groq_api_key: '',
      sarvam_api_key: '',
    });
    setModalOpen(true);
  }

  async function submit() {
    if (!form.name.trim()) { toast.error('请填写坐席名称'); return; }
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        name: form.name,
        description: form.description || null,
        engine: form.engine,
        greeting: form.greeting,
        voice: form.voice,
        voice_id: form.voice_id,
        language: form.language,
        voice_speed: form.voice_speed,
        voice_pitch: form.voice_pitch,
        max_duration_seconds: Number(form.max_duration_seconds) || 300,
        transfer_number: form.transfer_number || null,
        summary_enabled: form.summary_enabled,
        is_active: form.is_active,
      };
      if (form.system_prompt.trim()) payload.system_prompt = form.system_prompt;
      if (form.realtime_api_key.trim()) payload.realtime_api_key = form.realtime_api_key;
      if (form.groq_api_key.trim()) payload.groq_api_key = form.groq_api_key;
      if (form.sarvam_api_key.trim()) payload.sarvam_api_key = form.sarvam_api_key;

      if (editingAgent) {
        await api.put(`/voice/agents/${editingAgent.id}`, payload);
        toast.success('坐席已更新');
      } else {
        await api.post('/voice/agents', payload);
        toast.success('坐席已创建');
      }
      setModalOpen(false);
      loadAgents();
    } catch (e: unknown) {
      const err = e as { response?: { data?: { errors?: Record<string, string[]> } } };
      const first = err?.response?.data?.errors ? Object.values(err.response.data.errors)[0]?.[0] : null;
      toast.error(first ?? '保存失败');
    } finally {
      setSaving(false);
    }
  }

  async function remove(a: VoiceAgent) {
    if (!window.confirm(`确定删除语音坐席「${a.name}」吗？`)) return;
    await api.delete(`/voice/agents/${a.id}`);
    toast.success('已删除');
    loadAgents();
  }

  async function makeDefault(a: VoiceAgent) {
    await api.post(`/voice/agents/${a.id}/default`);
    toast.success(`「${a.name}」将自动接听来电`);
    loadAgents();
  }

  async function startCall(a: VoiceAgent) {
    if (!callNumber.trim()) { toast.error('请输入对方手机号（含国家码）'); return; }
    setCallingAgentId(a.id);
    try {
      const { data } = await api.post(`/voice/agents/${a.id}/call`, { phone: callNumber });
      toast.success(`正在呼叫 ${data.data.to}`);
      setCallNumber('');
      loadCallLogs();
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message;
      toast.error(msg ?? '呼叫失败');
    } finally {
      setCallingAgentId(null);
    }
  }

  async function openDetail(id: string) {
    setDetailLoading(true);
    setDetailSession(null);
    try {
      const { data } = await api.get(`/voice/calls/${id}`);
      setDetailSession(data);
    } catch {
      toast.error('加载通话详情失败');
    } finally {
      setDetailLoading(false);
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="p-6 max-w-7xl mx-auto h-full overflow-y-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900">AI 语音通话</h1>
          <p className="text-sm text-gray-400 mt-1">
            配置 AI 语音坐席，自动接听 / 外呼 WhatsApp 电话
          </p>
        </div>
        <button onClick={openCreate}
          className="bg-brand-600 hover:bg-brand-700 text-white text-sm rounded-lg px-4 py-2">
          + 添加语音坐席
        </button>
      </div>

      {loading ? (
        <p className="text-gray-400 text-sm">加载中...</p>
      ) : (
        <>
          {/* ── Agents ──────────────────────────────────────────────────────── */}
          <div className="grid gap-4 mb-8">
            {agents.length === 0 ? (
              <div className="text-center py-12 text-gray-400 bg-white rounded-xl border border-gray-200">
                <p className="text-lg mb-1">还没有语音坐席</p>
                <p className="text-sm">创建一个坐席并设为默认，客户打来的 WhatsApp 电话将由 AI 自动接听。</p>
              </div>
            ) : agents.map((a) => (
              <AgentCard
                key={a.id}
                agent={a}
                callNumber={callNumber}
                callingAgentId={callingAgentId}
                onEdit={openEdit}
                onDelete={remove}
                onMakeDefault={makeDefault}
                onCallNumberChange={setCallNumber}
                onStartCall={startCall}
                onOpenContactPicker={openContactPicker}
              />
            ))}
          </div>

          {/* ── Call Log ──────────────────────────────────────────────────── */}
          <CallLogSection
            logs={callLogs}
            loading={callsLoading}
            onRefresh={() => loadCallLogs()}
            onOpenDetail={openDetail}
          />
        </>
      )}

      {/* Create/Edit Modal */}
      {modalOpen && (
        <AgentModal
          form={form}
          editing={!!editingAgent}
          saving={saving}
          onChange={setForm}
          onClose={() => setModalOpen(false)}
          onSubmit={submit}
        />
      )}

      {/* Call Detail Modal */}
      {detailSession && (
        <CallDetailModal
          session={detailSession}
          loading={detailLoading}
          onClose={() => setDetailSession(null)}
        />
      )}

      {/* Contact Picker Modal */}
      {contactPickerOpen && (
        <ContactPickerModal
          contacts={contacts}
          loading={contactsLoading}
          onPick={pickContact}
          onClose={() => setContactPickerOpen(false)}
        />
      )}
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function AgentCard({
  agent,
  callNumber,
  callingAgentId,
  onEdit,
  onDelete,
  onMakeDefault,
  onCallNumberChange,
  onStartCall,
  onOpenContactPicker,
}: {
  agent: VoiceAgent;
  callNumber: string;
  callingAgentId: string | null;
  onEdit: (a: VoiceAgent) => void;
  onDelete: (a: VoiceAgent) => void;
  onMakeDefault: (a: VoiceAgent) => void;
  onCallNumberChange: (v: string) => void;
  onStartCall: (a: VoiceAgent) => void;
  onOpenContactPicker: () => void;
}) {
  const s = agent.stats ?? {};
  const engineLabel = agent.engine === 'openai' ? 'OpenAI 实时' : 'Groq + Sarvam';

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      {/* Card header */}
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <div className="font-medium text-gray-900 flex items-center gap-2 flex-wrap">
            <span>📞</span>
            <span>{agent.name}</span>
            <span className="text-xs bg-gray-100 text-gray-500 rounded-full px-2 py-0.5">{engineLabel}</span>
            {agent.is_default && <span className="text-xs bg-green-100 text-green-700 rounded-full px-2 py-0.5">默认接听</span>}
            <span className={`text-xs rounded-full px-2 py-0.5 ${agent.is_active ? 'bg-brand-100 text-brand-700' : 'bg-gray-100 text-gray-400'}`}>
              {agent.is_active ? '启用' : '停用'}
            </span>
          </div>
          {agent.description && <p className="text-sm text-gray-500 mt-0.5">{agent.description}</p>}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 ml-4 whitespace-nowrap">
          {!agent.is_default && (
            <button onClick={() => onMakeDefault(agent)}
              className="text-xs text-gray-600 hover:text-brand-600 border border-gray-300 rounded-lg px-3 py-1.5 hover:border-brand-500">
              设为默认
            </button>
          )}
          <button onClick={() => onEdit(agent)} className="text-xs text-brand-600 hover:underline">编辑</button>
          <button onClick={() => onDelete(agent)} className="text-xs text-red-500 hover:underline">删除</button>
        </div>
      </div>

      {/* Stats row */}
      <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2">
        <Stat label="总通话" value={s.total_calls ?? 0} />
        <Stat label="已接通" value={s.completed ?? 0} color="text-green-600" />
        <Stat label="未接" value={s.missed ?? 0} color="text-yellow-600" />
        <Stat label="失败" value={s.failed ?? 0} color="text-red-500" />
        <Stat label="平均时长" value={s.avg_duration ? `${s.avg_duration}秒` : '—'} />
        <Stat label="接通率" value={s.success_rate ? `${s.success_rate}%` : '—'} color={s.success_rate >= 70 ? 'text-green-600' : s.success_rate >= 40 ? 'text-yellow-600' : 'text-red-500'} />
      </div>

      {/* Config summary */}
      <div className="mt-2 text-xs text-gray-400">
        问候语「{agent.greeting?.slice(0, 30)}{agent.greeting?.length > 30 ? '…' : ''}」· 最长 {Math.round(agent.max_duration_seconds / 60)} 分钟
        {agent.language && ` · 语言 ${agent.language}`}
        {agent.engine === 'openai'
          ? ` · 音色 ${agent.voice}`
          : ` · Groq ${agent.has_groq_key ? '✓' : '✗'} / Sarvam ${agent.has_sarvam_key ? '✓' : '✗'}`}
      </div>

      {/* Outbound call */}
      <div className="mt-3 pt-3 border-t border-gray-100 flex items-center gap-2">
        <input
          value={callNumber}
          onChange={(e) => onCallNumberChange(e.target.value)}
          placeholder="外呼手机号（含国家码，如 8613800000000）"
          className="flex-1 max-w-xs text-sm border border-gray-300 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        <button
          onClick={onOpenContactPicker}
          className="text-xs border border-brand-300 text-brand-600 rounded-lg px-3 py-1.5 hover:bg-brand-50 transition">
          📋 从通讯录
        </button>
        <button
          onClick={() => onStartCall(agent)}
          disabled={callingAgentId === agent.id}
          className="text-sm bg-brand-600 hover:bg-brand-700 text-white rounded-lg px-4 py-1.5 disabled:opacity-50">
          {callingAgentId === agent.id ? '呼叫中…' : '📞 AI 外呼'}
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value, color = 'text-gray-900' }: { label: string; value: string | number; color?: string }) {
  return (
    <div className="bg-gray-50 rounded-lg px-3 py-2 text-center">
      <div className={`text-base font-semibold ${color}`}>{value}</div>
      <div className="text-xs text-gray-400 mt-0.5">{label}</div>
    </div>
  );
}

function CallLogSection({
  logs,
  loading,
  onRefresh,
  onOpenDetail,
}: {
  logs: CallSession[];
  loading: boolean;
  onRefresh: () => void;
  onOpenDetail: (id: string) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-base font-semibold text-gray-800">通话记录</h2>
        <button onClick={onRefresh} className="text-xs text-gray-500 hover:text-brand-600">
          ↻ 刷新
        </button>
      </div>

      {loading ? (
        <p className="text-sm text-gray-400">加载中...</p>
      ) : logs.length === 0 ? (
        <p className="text-sm text-gray-400">暂无通话记录</p>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-2.5 font-medium text-gray-600">号码</th>
                <th className="text-left px-4 py-2.5 font-medium text-gray-600">坐席</th>
                <th className="text-left px-4 py-2.5 font-medium text-gray-600">方向</th>
                <th className="text-left px-4 py-2.5 font-medium text-gray-600">状态</th>
                <th className="text-left px-4 py-2.5 font-medium text-gray-600">时长</th>
                <th className="text-left px-4 py-2.5 font-medium text-gray-600">时间</th>
                <th className="text-left px-4 py-2.5 font-medium text-gray-600">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {logs.map((c) => (
                <tr key={c.id} className="hover:bg-gray-50">
                  <td className="px-4 py-2.5 font-medium text-gray-900">
                    {c.direction === 'business_initiated' ? c.to_number : c.from_number}
                  </td>
                  <td className="px-4 py-2.5 text-gray-500 text-xs">{c.agent_name ?? '—'}</td>
                  <td className="px-4 py-2.5 text-gray-500">{c.direction_label}</td>
                  <td className="px-4 py-2.5">
                    <span className={`text-xs rounded-full px-2 py-0.5 ${STATUS_COLORS[c.status] ?? 'bg-gray-100 text-gray-500'}`}>
                      {c.status_label}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-gray-500">{c.duration_formatted}</td>
                  <td className="px-4 py-2.5 text-gray-400 text-xs">
                    {c.created_at ? new Date(c.created_at).toLocaleString('zh-CN') : '—'}
                  </td>
                  <td className="px-4 py-2.5">
                    <button onClick={() => onOpenDetail(c.id)}
                      className="text-xs text-brand-600 hover:underline">
                      详情
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CallDetailModal({
  session,
  loading,
  onClose,
}: {
  session: CallDetail | null;
  loading: boolean;
  onClose: () => void;
}) {
  if (!session) return null;

  const transcript = session.transcript ?? [];

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-xl w-full max-w-2xl max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="sticky top-0 bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-gray-900">通话详情</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">×</button>
        </div>

        <div className="px-6 py-4 space-y-4">
          {/* Info grid */}
          <div className="grid grid-cols-2 gap-3 text-sm">
            <InfoItem label="坐席">{session.agent_name ?? '—'}</InfoItem>
            <InfoItem label="方向">{session.direction_label}</InfoItem>
            <InfoItem label="状态">
              <span className={`text-xs rounded-full px-2 py-0.5 ${STATUS_COLORS[session.status] ?? ''}`}>
                {session.status_label}
              </span>
            </InfoItem>
            <InfoItem label="时长">{session.duration_formatted}</InfoItem>
            <InfoItem label="发起方">
              {session.direction === 'business_initiated' ? `呼出至 ${session.to_number}` : `来电 ${session.from_number}`}
            </InfoItem>
            <InfoItem label="时间">
              {session.created_at ? new Date(session.created_at).toLocaleString('zh-CN') : '—'}
            </InfoItem>
          </div>

          {/* Recording */}
          {session.recording_url && (
            <div>
              <h3 className="text-sm font-medium text-gray-700 mb-2">录音</h3>
              <audio controls src={session.recording_url} className="w-full" />
            </div>
          )}

          {/* Summary */}
          {session.summary && (
            <div>
              <h3 className="text-sm font-medium text-gray-700 mb-2">AI 总结</h3>
              <div className="bg-blue-50 rounded-lg px-4 py-3 text-sm text-blue-800">
                {session.summary}
              </div>
            </div>
          )}

          {/* Transcript */}
          <div>
            <h3 className="text-sm font-medium text-gray-700 mb-2">对话记录</h3>
            {transcript.length === 0 ? (
              <p className="text-sm text-gray-400">暂无对话记录</p>
            ) : (
              <div className="space-y-2">
                {transcript.map((t, i) => (
                  <div key={i} className={`flex gap-2 ${t.role === 'assistant' ? 'flex-row-reverse' : ''}`}>
                    <div className={`flex-1 rounded-lg px-3 py-2 text-sm ${
                      t.role === 'assistant' ? 'bg-brand-50 text-brand-900' : 'bg-gray-100 text-gray-800'
                    }`}>
                      <span className="font-medium text-xs opacity-60 mr-1">
                        {t.role === 'assistant' ? 'AI' : '客户'}:
                      </span>
                      {t.text}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Error */}
          {session.error && (
            <div className="bg-red-50 rounded-lg px-4 py-3 text-sm text-red-700">
              <strong>错误：</strong>{session.error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function InfoItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-gray-400">{label}</div>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}

function AgentModal({
  form,
  editing,
  saving,
  onChange,
  onClose,
  onSubmit,
}: {
  form: VoiceAgentForm;
  editing: boolean;
  saving: boolean;
  onChange: React.Dispatch<React.SetStateAction<VoiceAgentForm>>;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const set = (key: string, value: unknown) => onChange({ ...form, [key]: value });

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="sticky top-0 bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-gray-900">{editing ? '编辑语音坐席' : '添加语音坐席'}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">×</button>
        </div>

        <div className="px-6 py-4 space-y-5">
          {/* Basic info */}
          <div className="grid grid-cols-2 gap-4">
            <Field label="坐席名称">
              <input value={form.name as string} onChange={(e) => set('name', e.target.value)}
                placeholder="例如：售后语音坐席"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
            </Field>
            <Field label="引擎">
              <select value={form.engine as string} onChange={(e) => set('engine', e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500">
                <option value="openai">OpenAI 实时语音（效果最佳）</option>
                <option value="groq_sarvam">Groq + Sarvam（经济方案）</option>
              </select>
            </Field>
          </div>

          <Field label="描述（可选）">
            <input value={form.description as string} onChange={(e) => set('description', e.target.value)}
              placeholder="坐席用途说明"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
          </Field>

          {/* Voice settings */}
          <div className="border-t border-gray-200 pt-4">
            <h3 className="text-sm font-semibold text-gray-800 mb-3">🎙️ 语音设置</h3>

            {form.engine === 'openai' ? (
              <>
                <Field label="API Key（留空保持不变）">
                  <input type="password" value={form.realtime_api_key as string}
                    onChange={(e) => set('realtime_api_key', e.target.value)}
                    placeholder={editing ? '不修改请留空' : 'sk-...'}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
                </Field>
                <div className="grid grid-cols-3 gap-4">
                  <Field label="音色">
                    <select value={form.voice as string} onChange={(e) => set('voice', e.target.value)}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500">
                      {OPENAI_VOICES.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
                    </select>
                  </Field>
                  <Field label="语速（0.5-2.0）">
                    <input type="number" step="0.1" min="0.5" max="2" value={form.voice_speed as number}
                      onChange={(e) => set('voice_speed', parseFloat(e.target.value))}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
                  </Field>
                  <Field label="音高（0.5-2.0）">
                    <input type="number" step="0.1" min="0.5" max="2" value={form.voice_pitch as number}
                      onChange={(e) => set('voice_pitch', parseFloat(e.target.value))}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
                  </Field>
                </div>
              </>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-4">
                  <Field label="Groq API Key（留空保持不变）">
                    <input type="password" value={form.groq_api_key as string}
                      onChange={(e) => set('groq_api_key', e.target.value)}
                      placeholder={editing ? '不修改请留空' : 'gsk_...'}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
                  </Field>
                  <Field label="Sarvam API Key（留空保持不变）">
                    <input type="password" value={form.sarvam_api_key as string}
                      onChange={(e) => set('sarvam_api_key', e.target.value)}
                      placeholder={editing ? '不修改请留空' : ''}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
                  </Field>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <Field label="Sarvam 音色">
                    <select value={form.voice_id as string} onChange={(e) => set('voice_id', e.target.value)}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500">
                      {SARVAM_VOICES.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
                    </select>
                  </Field>
                  <Field label="语言">
                    <select value={form.language as string} onChange={(e) => set('language', e.target.value)}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500">
                      {LANGUAGES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
                    </select>
                  </Field>
                </div>
              </>
            )}
          </div>

          {/* Behaviour */}
          <div className="border-t border-gray-200 pt-4">
            <h3 className="text-sm font-semibold text-gray-800 mb-3">💬 对话设置</h3>
            <Field label="问候语">
              <input value={form.greeting as string} onChange={(e) => set('greeting', e.target.value)}
                placeholder="AI 开头说的话"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
            </Field>
            <Field label="系统提示词（可选）">
              <textarea value={form.system_prompt as string} onChange={(e) => set('system_prompt', e.target.value)}
                rows={4}
                placeholder={editing ? '不修改请留空' : '定义坐席人设、业务知识、回复规则…'}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-brand-500" />
              <p className="text-xs text-gray-400 mt-1">告诉 AI 坐席它是谁、擅长什么、如何回复客户。</p>
            </Field>
          </div>

          {/* Advanced */}
          <div className="border-t border-gray-200 pt-4">
            <h3 className="text-sm font-semibold text-gray-800 mb-3">⚙️ 高级设置</h3>
            <div className="grid grid-cols-2 gap-4">
              <Field label="最长通话（秒）">
                <input type="number" value={form.max_duration_seconds as number}
                  onChange={(e) => set('max_duration_seconds', parseInt(e.target.value))}
                  min={30} max={3600}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
              </Field>
              <Field label="转人工号码（可选）">
                <input value={form.transfer_number as string} onChange={(e) => set('transfer_number', e.target.value)}
                  placeholder="客户要求人工时通知的号码"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
              </Field>
            </div>
          </div>

          {/* Toggles */}
          <div className="border-t border-gray-200 pt-4 space-y-2">
            <label className="flex items-center gap-2 text-sm text-gray-600">
              <input type="checkbox" checked={form.is_active as boolean}
                onChange={(e) => set('is_active', e.target.checked)} />
              启用该坐席
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-600">
              <input type="checkbox" checked={form.summary_enabled as boolean}
                onChange={(e) => set('summary_enabled', e.target.checked)} />
              通话结束后生成 AI 总结
            </label>
          </div>
        </div>

        {/* Footer */}
        <div className="sticky bottom-0 bg-white border-t border-gray-200 px-6 py-4 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50">
            取消
          </button>
          <button onClick={onSubmit} disabled={saving}
            className="px-4 py-2 text-sm rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50">
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm text-gray-600 mb-1">{label}</label>
      {children}
    </div>
  );
}

// ── Contact Picker Modal ───────────────────────────────────────────────────────

function ContactPickerModal({
  contacts,
  loading,
  onPick,
  onClose,
}: {
  contacts: Contact[];
  loading: boolean;
  onPick: (c: Contact) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    if (!search) return contacts;
    const q = search.toLowerCase();
    return contacts.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (c.phone ?? '').includes(q) ||
        (c.email ?? '').includes(q)
    );
  }, [contacts, search]);

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-xl w-full max-w-lg max-h-[70vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-lg font-bold text-gray-900">选择联系人</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">×</button>
        </div>
        <div className="px-5 py-3 border-b border-gray-100">
          <input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索姓名或电话..."
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <p className="text-center text-gray-400 text-sm py-8">加载中...</p>
          ) : filtered.length === 0 ? (
            <p className="text-center text-gray-400 text-sm py-8">暂无匹配的联系人</p>
          ) : (
            <div className="divide-y divide-gray-100">
              {filtered.map((c) => (
                <button
                  key={c.id}
                  onClick={() => onPick(c)}
                  className="w-full text-left px-5 py-3 hover:bg-gray-50 transition flex items-center gap-3"
                >
                  <div className="w-9 h-9 rounded-full bg-brand-100 text-brand-700 flex items-center justify-center text-sm font-medium">
                    {c.name.charAt(0)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{c.name}</p>
                    <p className="text-xs text-gray-400 truncate">{c.phone ?? c.email ?? '—'}</p>
                  </div>
                  {c.tags.length > 0 && (
                    <span className="text-xs bg-blue-50 text-blue-600 rounded px-1.5 py-0.5 shrink-0">{c.tags[0]}</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="px-5 py-3 border-t border-gray-100 text-center">
          <a href="/contacts" target="_blank" className="text-xs text-gray-500 hover:text-brand-600">
            管理联系人 →
          </a>
        </div>
      </div>
    </div>
  );
}
