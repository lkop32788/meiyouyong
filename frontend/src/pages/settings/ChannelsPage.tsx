import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import api from '../../lib/api';

interface Channel {
  id: string;
  name: string;
  type: string;
  provider?: string | null;
  is_active: boolean;
  is_inbox_enabled: boolean;
  credential_keys: string[];
  webhook_url?: string | null;
  created_at?: string;
}

interface CredentialField {
  key: string;
  label: string;
}

const TYPE_LABEL: Record<string, string> = {
  whatsapp: 'WhatsApp',
  line: 'LINE',
  email: '邮箱',
  telegram: 'Telegram',
  sms: '短信',
  webchat: '网页聊天',
};

const TYPE_ICON: Record<string, string> = {
  whatsapp: '🟢',
  line: '💚',
  email: '✉️',
  telegram: '✈️',
  sms: '📱',
  webchat: '💬',
};

// 已知渠道类型的标准凭据字段；未列出的类型由用户自由输入 key=value。
const CRED_FIELDS: Record<string, CredentialField[]> = {
  whatsapp: [
    { key: 'phone_number_id', label: 'Phone Number ID' },
    { key: 'access_token', label: 'Access Token' },
    { key: 'verify_token', label: 'Verify Token' },
  ],
  line: [
    { key: 'channel_id', label: 'Channel ID' },
    { key: 'channel_secret', label: 'Channel Secret' },
    { key: 'channel_access_token', label: 'Channel Access Token' },
  ],
  telegram: [
    { key: 'bot_token', label: 'Bot Token' },
  ],
  email: [
    { key: 'api_key', label: 'Mailgun API Key' },
    { key: 'domain', label: '发送域名' },
  ],
  sms: [],
  webchat: [],
};

const EMPTY_FORM = {
  name: '',
  type: 'whatsapp',
  provider: '',
  inbox: true,
  active: true,
  cred: {} as Record<string, string>,
};

export default function ChannelsPage() {
  const [channels, setChannels]   = useState<Channel[]>([]);
  const [maxChannels, setMaxChannels] = useState<number | null>(null);
  const [loading, setLoading]     = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm]           = useState({ ...EMPTY_FORM, cred: {} as Record<string, string> });
  const [saving, setSaving]       = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api.get('/channels'),
      api.get('/auth/me').catch(() => null),
    ])
      .then(([ch, me]) => {
        setChannels(ch.data?.data ?? []);
        setMaxChannels(me?.data?.company?.max_channels ?? null);
      })
      .catch(() => toast.error('加载渠道列表失败'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const openCreate = () => {
    setEditingId(null);
    setForm({ ...EMPTY_FORM, cred: {} });
    setModalOpen(true);
  };

  const openEdit = (ch: Channel) => {
    setEditingId(ch.id);
    setForm({
      name: ch.name,
      type: ch.type,
      provider: ch.provider ?? '',
      inbox: ch.is_inbox_enabled,
      active: ch.is_active,
      cred: {},
    });
    setModalOpen(true);
  };

  const submit = async () => {
    if (!form.name.trim()) { toast.error('请填写渠道名称'); return; }

    const cred = Object.fromEntries(Object.entries(form.cred).filter(([, v]) => v.trim() !== ''));
    if (!editingId && Object.keys(cred).length === 0) {
      toast.error('请至少填写一项凭据');
      return;
    }

    setSaving(true);
    try {
      if (editingId) {
        await api.put(`/channels/${editingId}`, {
          name: form.name,
          provider: form.provider || null,
          is_active: form.active,
          is_inbox_enabled: form.inbox,
          ...(Object.keys(cred).length > 0 ? { credentials: cred } : {}),
        });
        toast.success('渠道已更新');
      } else {
        await api.post('/channels', {
          name: form.name,
          type: form.type,
          provider: form.provider || null,
          credentials: cred,
          is_active: form.active,
          is_inbox_enabled: form.inbox,
        });
        toast.success('渠道已接入');
      }
      setModalOpen(false);
      load();
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message;
      toast.error(msg ?? '保存失败，请重试');
    } finally {
      setSaving(false);
    }
  };

  const toggleField = async (ch: Channel, field: 'is_active' | 'is_inbox_enabled') => {
    const next = !ch[field];
    setChannels((rows) => rows.map((r) => (r.id === ch.id ? { ...r, [field]: next } : r)));
    try {
      await api.put(`/channels/${ch.id}`, { [field]: next });
    } catch {
      toast.error('更新失败');
      load();
    }
  };

  const remove = async (ch: Channel) => {
    if (!window.confirm(`确定删除渠道「${ch.name}」吗？删除后历史会话仍会保留。`)) return;
    try {
      await api.delete(`/channels/${ch.id}`);
      toast.success('渠道已删除');
      load();
    } catch {
      toast.error('删除失败');
    }
  };

  const copyWebhook = async (ch: Channel) => {
    if (!ch.webhook_url) return;
    try {
      await navigator.clipboard.writeText(ch.webhook_url);
      toast.success('Webhook 地址已复制');
    } catch {
      toast.error('复制失败');
    }
  };

  const credFields = CRED_FIELDS[form.type] ?? [];
  const quotaText = maxChannels !== null ? `${channels.length} / ${maxChannels}` : `${channels.length}`;

  return (
    <div className="p-6 max-w-5xl mx-auto h-full overflow-y-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900">渠道管理</h1>
          <p className="text-sm text-gray-400 mt-1">接入 WhatsApp、LINE、邮箱、Telegram 等渠道 · {quotaText}</p>
        </div>
        <button
          onClick={openCreate}
          className="bg-brand-600 hover:bg-brand-700 text-white text-sm rounded-lg px-4 py-2"
        >
          + 接入渠道
        </button>
      </div>

      {loading ? (
        <p className="text-gray-400 text-sm">加载中...</p>
      ) : channels.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <p className="text-lg mb-2">还没有接入任何渠道</p>
          <p className="text-sm">点击右上角「接入渠道」添加第一个渠道。</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600">渠道</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">类型</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">启用</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">收件箱</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {channels.map((ch) => (
                <tr key={ch.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-900">
                    <span className="mr-2">{TYPE_ICON[ch.type] ?? '📱'}</span>{ch.name}
                    <div className="text-xs text-gray-400 mt-0.5">
                      {ch.credential_keys.length > 0 ? `凭据已配置（${ch.credential_keys.join(', ')}）` : '凭据未配置'}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-gray-500">{TYPE_LABEL[ch.type] ?? ch.type}</td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => toggleField(ch, 'is_active')}
                      className={`w-9 h-5 rounded-full relative transition ${ch.is_active ? 'bg-green-500' : 'bg-gray-300'}`}
                      title={ch.is_active ? '点击停用' : '点击启用'}
                    >
                      <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all ${ch.is_active ? 'left-4.5' : 'left-0.5'}`} />
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => toggleField(ch, 'is_inbox_enabled')}
                      className={`w-9 h-5 rounded-full relative transition ${ch.is_inbox_enabled ? 'bg-brand-600' : 'bg-gray-300'}`}
                      title={ch.is_inbox_enabled ? '收件箱已开启' : '收件箱已关闭'}
                    >
                      <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all ${ch.is_inbox_enabled ? 'left-4.5' : 'left-0.5'}`} />
                    </button>
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    {ch.webhook_url && (
                      <button onClick={() => copyWebhook(ch)} className="text-xs text-gray-500 hover:text-brand-600 mr-3" title={ch.webhook_url}>
                        复制 Webhook
                      </button>
                    )}
                    <button onClick={() => openEdit(ch)} className="text-xs text-brand-600 hover:underline mr-3">编辑</button>
                    <button onClick={() => remove(ch)} className="text-xs text-red-500 hover:underline">删除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modalOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setModalOpen(false)}>
          <div className="bg-white rounded-xl w-full max-w-md p-6 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-gray-900 mb-4">{editingId ? '编辑渠道' : '接入新渠道'}</h2>

            <label className="block text-sm text-gray-600 mb-1">渠道名称</label>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="例如：客服主号"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-brand-500"
            />

            {!editingId && (
              <>
                <label className="block text-sm text-gray-600 mb-1">类型</label>
                <select
                  value={form.type}
                  onChange={(e) => setForm({ ...form, type: e.target.value, cred: {} })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-brand-500"
                >
                  {Object.entries(TYPE_LABEL).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </>
            )}

            <label className="block text-sm text-gray-600 mb-1">服务商（可选）</label>
            <input
              value={form.provider}
              onChange={(e) => setForm({ ...form, provider: e.target.value })}
              placeholder="例如 meta_cloud / 360dialog / mailgun"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-brand-500"
            />

            <label className="block text-sm text-gray-600 mb-1">
              凭据{editingId ? '（留空保持不变）' : ''}
            </label>
            {credFields.length > 0 ? (
              credFields.map((f) => (
                <input
                  key={f.key}
                  type="password"
                  value={form.cred[f.key] ?? ''}
                  onChange={(e) => setForm({ ...form, cred: { ...form.cred, [f.key]: e.target.value } })}
                  placeholder={f.label}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-2 focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              ))
            ) : (
              <input
                type="password"
                value={form.cred.api_key ?? ''}
                onChange={(e) => setForm({ ...form, cred: { api_key: e.target.value } })}
                placeholder="API Key"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-2 focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            )}
            <p className="text-xs text-gray-400 mb-4">凭据将加密存储，保存后不再显示。</p>

            <div className="flex items-center gap-4 mb-4 text-sm">
              <label className="flex items-center gap-2 text-gray-600">
                <input type="checkbox" checked={form.inbox} onChange={(e) => setForm({ ...form, inbox: e.target.checked })} />
                收件箱启用
              </label>
              <label className="flex items-center gap-2 text-gray-600">
                <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
                渠道启用
              </label>
            </div>

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
    </div>
  );
}
