import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../../lib/api';
import toast from 'react-hot-toast';
import { getSocket } from '../../lib/socket';

interface Contact {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  tags: string[];
}

type CampaignStatus = 'draft' | 'scheduled' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

interface Campaign {
  id: string;
  name: string;
  status: CampaignStatus;
  total_recipients: number;
  sent_count: number;
  delivered_count: number;
  failed_count: number;
  started_at: string | null;
  completed_at: string | null;
  channel?: { name: string; channel_type: string };
}

const STATUS_STYLE: Record<CampaignStatus, string> = {
  draft:      'bg-gray-100 text-gray-600',
  scheduled:  'bg-blue-100 text-blue-600',
  running:    'bg-green-100 text-green-700',
  paused:     'bg-yellow-100 text-yellow-700',
  completed:  'bg-indigo-100 text-indigo-700',
  failed:     'bg-red-100 text-red-700',
  cancelled:  'bg-gray-100 text-gray-400',
};

const STATUS_LABEL: Record<CampaignStatus, string> = {
  draft:     '草稿',
  scheduled: '已排期',
  running:   '进行中',
  paused:    '已暂停',
  completed: '已完成',
  failed:    '失败',
  cancelled: '已取消',
};

export default function BroadcastPage() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading]     = useState(true);
  const [selected, setSelected]   = useState<Campaign | null>(null);
  const selectedIdRef = useRef<string | null>(null);

  useEffect(() => {
    selectedIdRef.current = selected?.id ?? null;
  }, [selected]);
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => {
    api.get('/campaigns').then((r) => setCampaigns(r.data.data ?? r.data)).finally(() => setLoading(false));

    // Real-time progress updates
    const sock = getSocket();
    const handler = (data: { campaign_id: string; sent: number; delivered: number; failed: number; total: number }) => {
      setCampaigns((prev) =>
        prev.map((c) =>
          c.id === data.campaign_id
            ? { ...c, sent_count: data.sent, delivered_count: data.delivered, failed_count: data.failed }
            : c
        )
      );
      if (selectedIdRef.current === data.campaign_id) {
        setSelected((prev) => prev ? { ...prev, sent_count: data.sent, delivered_count: data.delivered, failed_count: data.failed } : prev);
      }
    };
    sock.on('broadcast:progress', handler);
    return () => { sock.off('broadcast:progress', handler); };
  }, []);

  const action = async (id: string, act: 'launch' | 'pause' | 'resume' | 'cancel') => {
    await api.post(`/campaigns/${id}/${act}`);
    const newStatus: Record<string, CampaignStatus> = {
      launch: 'running', pause: 'paused', resume: 'running', cancel: 'cancelled',
    };
    setCampaigns((prev) =>
      prev.map((c) => (c.id === id ? { ...c, status: newStatus[act] ?? c.status } : c))
    );
    toast.success(act === 'launch' ? '群发已启动' : act === 'pause' ? '群发已暂停' : act === 'resume' ? '群发已恢复' : '群发已取消');
  };

  if (showCreate) {
    return <CreateCampaignWizard onDone={(c) => { setCampaigns((prev) => [c, ...prev]); setShowCreate(false); }} onCancel={() => setShowCreate(false)} />;
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* Campaign list */}
      <div className={`${selected ? 'w-1/2' : 'flex-1'} flex flex-col border-r border-gray-200 overflow-hidden`}>
        <div className="p-4 border-b border-gray-200 flex items-center justify-between bg-white">
          <h1 className="text-lg font-bold text-gray-900">群发活动</h1>
          <button
            onClick={() => setShowCreate(true)}
            className="bg-brand-600 hover:bg-brand-700 text-white text-sm rounded-lg px-4 py-2 transition"
          >
            + 新建群发
          </button>
        </div>

        <div className="flex-1 overflow-y-auto bg-gray-50">
          {loading ? (
            <p className="text-center text-sm text-gray-400 mt-8">加载中...</p>
          ) : campaigns.length === 0 ? (
            <div className="text-center py-16 text-gray-400">
              <p className="text-lg mb-2">暂无群发活动</p>
            </div>
          ) : (
            <table className="w-full text-sm bg-white">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">名称</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">状态</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">进度</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {campaigns.map((c) => {
                  const pct = c.total_recipients > 0
                    ? Math.round((c.sent_count / c.total_recipients) * 100)
                    : 0;
                  return (
                    <tr
                      key={c.id}
                      onClick={() => setSelected(c)}
                      className="hover:bg-gray-50 cursor-pointer"
                    >
                      <td className="px-4 py-3 font-medium text-gray-900">{c.name}</td>
                      <td className="px-4 py-3">
                        <span className={`text-xs rounded-full px-2 py-0.5 font-medium ${STATUS_STYLE[c.status]}`}>
                          {STATUS_LABEL[c.status]}
                          {c.status === 'running' && <span className="ml-1 animate-pulse">●</span>}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {c.total_recipients > 0 ? (
                          <div className="flex items-center gap-2">
                            <div className="flex-1 bg-gray-200 rounded-full h-1.5 min-w-[80px]">
                              <div className="bg-brand-500 h-1.5 rounded-full transition-all" style={{ width: `${pct}%` }} />
                            </div>
                            <span className="text-xs text-gray-500">{pct}%</span>
                          </div>
                        ) : (
                          <span className="text-xs text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex gap-2 justify-end" onClick={(e) => e.stopPropagation()}>
                          {c.status === 'draft' && (
                            <button onClick={() => action(c.id, 'launch')} className="text-xs text-green-600 hover:underline">启动</button>
                          )}
                          {c.status === 'running' && (
                            <button onClick={() => action(c.id, 'pause')} className="text-xs text-yellow-600 hover:underline">暂停</button>
                          )}
                          {c.status === 'paused' && (
                            <>
                              <button onClick={() => action(c.id, 'resume')} className="text-xs text-green-600 hover:underline">恢复</button>
                              <button onClick={() => action(c.id, 'cancel')} className="text-xs text-red-500 hover:underline">取消</button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Campaign detail */}
      {selected && (
        <div className="flex-1 overflow-y-auto bg-white">
          <CampaignDetail campaign={selected} onClose={() => setSelected(null)} />
        </div>
      )}
    </div>
  );
}

function CampaignDetail({ campaign, onClose }: { campaign: Campaign; onClose: () => void }) {
  const pct = campaign.total_recipients > 0
    ? Math.round((campaign.sent_count / campaign.total_recipients) * 100)
    : 0;

  return (
    <div className="p-6">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h2 className="text-lg font-bold text-gray-900">{campaign.name}</h2>
          <span className={`text-xs rounded-full px-2 py-0.5 font-medium ${STATUS_STYLE[campaign.status]}`}>
            {STATUS_LABEL[campaign.status]}
          </span>
        </div>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg">×</button>
      </div>

      {/* Progress bar */}
      <div className="mb-6">
        <div className="flex items-center justify-between text-sm text-gray-600 mb-2">
          <span>已发送 {campaign.sent_count.toLocaleString()} / {campaign.total_recipients.toLocaleString()}</span>
          <span>{pct}%</span>
        </div>
        <div className="bg-gray-200 rounded-full h-3">
          <div className="bg-brand-500 h-3 rounded-full transition-all duration-500" style={{ width: `${pct}%` }} />
        </div>
      </div>

      {/* Stats cards */}
      <div className="grid grid-cols-4 gap-3 mb-6">
        {[
          { label: '总数', value: campaign.total_recipients, color: 'text-gray-900' },
          { label: '已发送', value: campaign.sent_count, color: 'text-green-600' },
          { label: '已送达', value: campaign.delivered_count, color: 'text-blue-600' },
          { label: '失败', value: campaign.failed_count, color: 'text-red-600' },
        ].map((s) => (
          <div key={s.label} className="bg-gray-50 rounded-xl p-3 text-center border border-gray-100">
            <p className={`text-2xl font-bold ${s.color}`}>{s.value.toLocaleString()}</p>
            <p className="text-xs text-gray-500 mt-0.5">{s.label}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function CreateCampaignWizard({ onDone, onCancel }: { onDone: (c: Campaign) => void; onCancel: () => void }) {
  const [step, setStep]       = useState(1);
  const [form, setForm]       = useState({
    name: '',
    channel_id: '',
    audience_type: 'all' as 'all' | 'tag' | 'segment' | 'upload',
    audience_config: {} as Record<string, unknown>,
    scheduled_at: '',
    rate_limit_per_minute: 60,
  });
  const [channels, setChannels]   = useState<Array<{ id: string; name: string; channel_type: string }>>([]);
  const [contacts, setContacts]   = useState<Contact[]>([]);
  const [totalContacts, setTotal] = useState(0);
  const [selectedContacts, setSelectedContacts] = useState<Set<string>>(new Set());
  const [loadingContacts, setLoadingContacts] = useState(false);
  const [saving, setSaving] = useState(false);

  // Load imported contacts when audience_type changes to 'upload'
  const loadContacts = useCallback((q = '') => {
    setLoadingContacts(true);
    api.get('/contacts', { params: { page: 1, search: q, limit: 100 } })
      .then((r) => {
        setContacts(r.data.data ?? []);
        setTotal(r.data.total ?? 0);
      })
      .catch(() => toast.error('加载联系人失败'))
      .finally(() => setLoadingContacts(false));
  }, []);

  useEffect(() => {
    api.get('/channels').then((r) => setChannels(r.data?.data ?? r.data ?? [])).catch(() => {});
  }, []);

  useEffect(() => {
    if (form.audience_type === 'upload' && contacts.length === 0) {
      loadContacts();
    }
  }, [form.audience_type, contacts.length, loadContacts]);

  const submit = async () => {
    setSaving(true);
    try {
      const payload = { ...form };
      if (form.audience_type === 'upload') {
        payload.audience_config = { contact_ids: Array.from(selectedContacts) };
      }
      const { data } = await api.post('/campaigns', payload);
      onDone(data);
      toast.success('群发活动创建成功');
    } catch (err: any) {
      toast.error(err?.response?.data?.message ?? '创建群发活动失败');
    } finally {
      setSaving(false);
    }
  };

  const toggleContact = (id: string) => {
    setSelectedContacts((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    if (selectedContacts.size === contacts.length) {
      setSelectedContacts(new Set());
    } else {
      setSelectedContacts(new Set(contacts.map((c) => c.id)));
    }
  };

  return (
    <div className="max-w-2xl mx-auto p-6">
      <div className="flex items-center gap-4 mb-6">
        {[1, 2, 3, 4].map((s) => (
          <div key={s} className={`flex items-center gap-1 text-sm ${step >= s ? 'text-brand-600 font-medium' : 'text-gray-400'}`}>
            <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs ${step >= s ? 'bg-brand-600 text-white' : 'bg-gray-200 text-gray-500'}`}>{s}</span>
            {s === 1 ? '基本信息' : s === 2 ? '目标人群' : s === 3 ? '发送时间' : '确认'}
          </div>
        ))}
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-6">
        {step === 1 && (
          <div className="space-y-4">
            <h3 className="font-semibold text-gray-900">群发信息</h3>
            <div>
              <label className="text-sm text-gray-600 mb-1 block">活动名称</label>
              <input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="例如：2026 新春促销"
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
              />
            </div>
            <div>
              <label className="text-sm text-gray-600 mb-1 block">发送渠道</label>
              <select
                value={form.channel_id}
                onChange={(e) => setForm((f) => ({ ...f, channel_id: e.target.value }))}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none"
              >
                <option value="">请选择渠道</option>
                {channels.map((c) => (
                  <option key={c.id} value={c.id}>{c.name} ({c.channel_type})</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-sm text-gray-600 mb-1 block">发送频率限制（条/分钟）</label>
              <input
                type="number"
                value={form.rate_limit_per_minute}
                onChange={(e) => setForm((f) => ({ ...f, rate_limit_per_minute: Number(e.target.value) }))}
                min={1} max={120}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none"
              />
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <h3 className="font-semibold text-gray-900">目标人群</h3>
            {(['all', 'tag', 'segment', 'upload'] as const).map((type) => (
              <label key={type} className="flex items-center gap-3 cursor-pointer border border-gray-200 rounded-lg p-3 hover:border-brand-300">
                <input
                  type="radio"
                  name="audience_type"
                  value={type}
                  checked={form.audience_type === type}
                  onChange={() => setForm((f) => ({ ...f, audience_type: type }))}
                  className="accent-brand-600"
                />
                <div>
                  <p className="text-sm font-medium text-gray-700 capitalize">
                    {type === 'all' ? '全部联系人' : type === 'tag' ? '按标签筛选' : type === 'segment' ? '动态分组' : '已导入联系人'}
                  </p>
                  <p className="text-xs text-gray-400">
                    {type === 'all' ? '发送给所有启用中的联系人'
                      : type === 'tag' ? '按联系人标签进行筛选'
                      : type === 'segment' ? '基于联系人字段的自定义条件'
                      : `从联系人列表中选择（${totalContacts} 位联系人）`}
                  </p>
                </div>
              </label>
            ))}

            {/* Contact selection when 'upload' is selected */}
            {form.audience_type === 'upload' && (
              <div className="mt-4 border border-gray-200 rounded-lg overflow-hidden">
                <div className="bg-gray-50 px-4 py-2 flex items-center justify-between border-b border-gray-200">
                  <span className="text-sm text-gray-600">
                    已选择 {selectedContacts.size} / {contacts.length} 位联系人
                    {totalContacts > contacts.length && `（共 ${totalContacts} 位）`}
                  </span>
                  <button
                    onClick={selectAll}
                    className="text-xs text-brand-600 hover:underline"
                  >
                    {selectedContacts.size === contacts.length ? '取消全选' : '全选'}
                  </button>
                </div>
                {loadingContacts ? (
                  <p className="text-center py-8 text-gray-400 text-sm">加载中...</p>
                ) : contacts.length === 0 ? (
                  <div className="text-center py-8 text-gray-400">
                    <p className="text-sm mb-2">暂无已导入的联系人</p>
                    <a href="/contacts" target="_blank" className="text-brand-600 hover:underline text-sm">
                      去导入联系人 →
                    </a>
                  </div>
                ) : (
                  <div className="max-h-64 overflow-y-auto divide-y divide-gray-100">
                    {contacts.map((c) => (
                      <label key={c.id} className="flex items-center gap-3 px-4 py-2 hover:bg-gray-50 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={selectedContacts.has(c.id)}
                          onChange={() => toggleContact(c.id)}
                          className="accent-brand-600 rounded"
                        />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-gray-900 truncate">{c.name}</p>
                          <p className="text-xs text-gray-400 truncate">{c.phone ?? c.email ?? '—'}</p>
                        </div>
                        {c.tags.length > 0 && (
                          <div className="flex gap-1 flex-wrap">
                            {c.tags.slice(0, 2).map((t) => (
                              <span key={t} className="text-xs bg-blue-50 text-blue-600 rounded px-1.5 py-0.5">{t}</span>
                            ))}
                          </div>
                        )}
                      </label>
                    ))}
                  </div>
                )}
                {contacts.length < totalContacts && (
                  <div className="px-4 py-2 border-t border-gray-200 text-center">
                    <a href="/contacts" target="_blank" className="text-xs text-gray-500 hover:text-brand-600">
                      查看全部 {totalContacts} 位联系人 →
                    </a>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4">
            <h3 className="font-semibold text-gray-900">发送时间</h3>
            <label className="flex items-center gap-3 cursor-pointer border border-gray-200 rounded-lg p-3 hover:border-brand-300">
              <input
                type="radio"
                name="schedule"
                checked={!form.scheduled_at}
                onChange={() => setForm((f) => ({ ...f, scheduled_at: '' }))}
                className="accent-brand-600"
              />
              <div>
                <p className="text-sm font-medium text-gray-700">立即发送</p>
                <p className="text-xs text-gray-400">启动后将立即开始发送</p>
              </div>
            </label>
            <label className="flex items-center gap-3 cursor-pointer border border-gray-200 rounded-lg p-3 hover:border-brand-300">
              <input
                type="radio"
                name="schedule"
                checked={!!form.scheduled_at}
                onChange={() => setForm((f) => ({ ...f, scheduled_at: new Date(Date.now() + 3600000).toISOString().slice(0, 16) }))}
                className="accent-brand-600"
              />
              <div className="flex-1">
                <p className="text-sm font-medium text-gray-700">定时发送</p>
                {form.scheduled_at && (
                  <input
                    type="datetime-local"
                    value={form.scheduled_at}
                    onChange={(e) => setForm((f) => ({ ...f, scheduled_at: e.target.value }))}
                    className="mt-1 border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none"
                  />
                )}
              </div>
            </label>
          </div>
        )}

        {step === 4 && (
          <div className="space-y-3">
            <h3 className="font-semibold text-gray-900">确认并启动</h3>
            <div className="bg-gray-50 rounded-lg p-4 space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-gray-500">名称</span><span className="font-medium">{form.name}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">渠道</span><span>{channels.find((c) => c.id === form.channel_id)?.name ?? '—'}</span></div>
              <div className="flex justify-between">
                <span className="text-gray-500">人群</span>
                <span>
                  {form.audience_type === 'upload'
                    ? `已选联系人 (${selectedContacts.size}人)`
                    : form.audience_type.charAt(0).toUpperCase() + form.audience_type.slice(1)}
                </span>
              </div>
              <div className="flex justify-between"><span className="text-gray-500">时间</span><span>{form.scheduled_at || '立即'}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">频率限制</span><span>{form.rate_limit_per_minute} 条/分钟</span></div>
            </div>
          </div>
        )}
      </div>

      <div className="flex justify-between mt-4">
        <button
          onClick={step === 1 ? onCancel : () => setStep((s) => s - 1)}
          className="text-sm text-gray-500 hover:text-gray-700 px-4 py-2"
        >
          {step === 1 ? '取消' : '上一步'}
        </button>
        {step < 4 ? (
          <button
            onClick={() => setStep((s) => s + 1)}
            disabled={step === 1 && (!form.name || !form.channel_id)}
            className="bg-brand-600 hover:bg-brand-700 text-white text-sm rounded-lg px-4 py-2 transition disabled:opacity-40"
          >
            下一步
          </button>
        ) : (
          <button
            onClick={submit}
            disabled={saving}
            className="bg-green-600 hover:bg-green-700 text-white text-sm rounded-lg px-4 py-2 transition disabled:opacity-40"
          >
            {saving ? '创建中...' : '启动群发'}
          </button>
        )}
      </div>
    </div>
  );
}
