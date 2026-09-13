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

interface QrStatus {
  status: string;
  phone: string;
  qr: string | null;
  warmup_day: number;
  warmup_total_days: number;
  today_cap: number;
  sent_today: number;
}

interface FacebookConfig {
  app_id: string;
  config_id?: string;
  channels: { id: string; name: string; page_id?: string | null; page_name?: string | null; is_active: boolean }[];
}

declare global {
  interface Window {
    FB?: {
      init: (opts: Record<string, unknown>) => void;
      login: (cb: (response: { authResponse?: { code?: string } }) => void, opts: Record<string, unknown>) => void;
    };
    fbAsyncInit?: () => void;
  }
}

interface CredentialField {
  key: string;
  label: string;
}

const TYPE_LABEL: Record<string, string> = {
  whatsapp: 'WhatsApp（官方接口）',
  whatsapp_qr: 'WhatsApp（扫码登录）',
  facebook: 'Facebook Messenger',
  line: 'LINE',
  email: '邮箱',
  telegram: 'Telegram',
  sms: '短信',
  webchat: '网页聊天',
};

const TYPE_ICON: Record<string, string> = {
  whatsapp: '🟢',
  whatsapp_qr: '📷',
  facebook: '📘',
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
  facebook: [], // connected via OAuth, no manual credentials
  whatsapp_qr: [], // connected via QR scan, session lives on the gateway
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

  // WhatsApp QR pairing modal state
  const [qrChannel, setQrChannel]       = useState<Channel | null>(null);
  const [qrStatus, setQrStatus]         = useState<QrStatus | null>(null);
  const [qrLoading, setQrLoading]       = useState(false);

  // Facebook connect state
  const [fbConfig, setFbConfig]         = useState<FacebookConfig | null>(null);
  const [fbPageChoice, setFbPageChoice] = useState<{ code: string; pages: { id: string; name: string }[] } | null>(null);

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

  // ── WhatsApp QR pairing ──────────────────────────────────────────────
  const openQrModal = async (ch: Channel) => {
    setQrChannel(ch);
    setQrStatus(null);
    setQrLoading(true);
    try {
      await api.post(`/channels/${ch.id}/qr/start`);
      const { data } = await api.get(`/channels/${ch.id}/qr/status`);
      setQrStatus(data.data);
    } catch {
      toast.error('无法启动扫码会话，请确认网关已连接');
      setQrChannel(null);
    } finally {
      setQrLoading(false);
    }
  };

  // Poll QR status while modal is open
  useEffect(() => {
    if (!qrChannel) return;
    const timer = setInterval(async () => {
      try {
        const { data } = await api.get(`/channels/${qrChannel.id}/qr/status`);
        setQrStatus(data.data);
        if (data.data?.status === 'connected') {
          toast.success(`WhatsApp 已连接（${data.data.phone}）`);
          load();
        }
      } catch { /* keep polling */ }
    }, 3000);
    return () => clearInterval(timer);
  }, [qrChannel, load]);

  const disconnectQr = async () => {
    if (!qrChannel) return;
    try {
      await api.post(`/channels/${qrChannel.id}/qr/disconnect`);
      toast.success('已断开并清除会话');
      setQrChannel(null);
      setQrStatus(null);
      load();
    } catch {
      toast.error('断开失败');
    }
  };

  // ── Facebook OAuth connect ─────────────────────────────────────────
  const connectFacebook = async () => {
    try {
      const { data } = await api.get('/channels/facebook/config');
      const cfg: FacebookConfig = data.data;
      if (!cfg?.app_id) {
        toast.error('Facebook 登录尚未配置（需要 FACEBOOK_APP_ID）');
        return;
      }
      setFbConfig(cfg);
      // Load the SDK lazily, then open the login popup
      if (!document.getElementById('facebook-jssdk')) {
        const script = document.createElement('script');
        script.id = 'facebook-jssdk';
        script.src = 'https://connect.facebook.net/zh_CN/sdk.js';
        document.body.appendChild(script);
      }
      window.fbAsyncInit = () => {
        window.FB?.init({ appId: cfg.app_id, cookie: true, xfbml: false, version: 'v21.0' });
        launchFbLogin(cfg);
      };
      if (window.FB) launchFbLogin(cfg);
    } catch {
      toast.error('获取 Facebook 配置失败');
    }
  };

  const launchFbLogin = (cfg: FacebookConfig) => {
    window.FB?.login(async (response) => {
      const code = response?.authResponse?.code;
      if (!code) { toast.error('Facebook 授权已取消'); return; }
      await submitFacebookCode(code);
    }, { scope: 'pages_show_list,pages_messaging,pages_manage_metadata', return_scopes: true });
  };

  const submitFacebookCode = async (code: string, pageId?: string) => {
    try {
      const { data } = await api.post('/channels/facebook/connect', { code, pageId });
      if (data.data?.needs_page_choice) {
        setFbPageChoice({ code, pages: data.data.pages });
        return;
      }
      toast.success(`Facebook 主页「${data.data?.page_name}」已接入`);
      setFbPageChoice(null);
      load();
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message;
      toast.error(msg ?? 'Facebook 接入失败');
    }
  };

  const credFields = CRED_FIELDS[form.type] ?? [];
  const quotaText = maxChannels !== null ? `${channels.length} / ${maxChannels}` : `${channels.length}`;

  const qrConnected = qrStatus?.status === 'connected';

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
                    {ch.type === 'whatsapp_qr' && (
                      <button onClick={() => openQrModal(ch)} className="text-xs text-brand-600 hover:underline mr-3">
                        {ch.is_active ? '扫码 / 管理' : '扫码登录'}
                      </button>
                    )}
                    {ch.webhook_url && (
                      <button onClick={() => copyWebhook(ch)} className="text-xs text-gray-500 hover:text-brand-600 mr-3" title={ch.webhook_url}>
                        复制 Webhook
                      </button>
                    )}
                    {!['whatsapp_qr', 'facebook'].includes(ch.type) && (
                      <button onClick={() => openEdit(ch)} className="text-xs text-brand-600 hover:underline mr-3">编辑</button>
                    )}
                    <button onClick={() => remove(ch)} className="text-xs text-red-500 hover:underline">删除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── WhatsApp QR pairing modal ───────────────────────────── */}
      {qrChannel && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setQrChannel(null)}>
          <div className="bg-white rounded-xl w-full max-w-sm p-6 text-center" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-gray-900 mb-1">WhatsApp 扫码登录</h2>
            <p className="text-xs text-gray-400 mb-4">{qrChannel.name}</p>

            {qrLoading ? (
              <p className="text-sm text-gray-400 py-8">正在启动会话...</p>
            ) : qrConnected ? (
              <>
                <div className="text-5xl mb-3">✅</div>
                <p className="text-sm text-gray-700 font-medium mb-1">已连接：{qrStatus?.phone}</p>
                <p className="text-xs text-gray-400 mb-4">
                  预热期第 {qrStatus?.warmup_day}/{qrStatus?.warmup_total_days} 天 · 今日已发 {qrStatus?.sent_today}/{qrStatus?.today_cap} 条
                </p>
                <div className="bg-yellow-50 border border-yellow-200 rounded-lg px-3 py-2 text-xs text-yellow-700 mb-4">
                  扫码登录为非官方接入方式，存在封号风险，建议使用拉黑风险的测试号码。
                </div>
              </>
            ) : qrStatus?.qr ? (
              <>
                <img src={qrStatus.qr} alt="WhatsApp QR" className="mx-auto mb-3 rounded-lg border border-gray-200" />
                <p className="text-xs text-gray-500 mb-4">打开 WhatsApp → 设置 → 已链接的设备 → 扫描二维码</p>
              </>
            ) : (
              <p className="text-sm text-gray-500 py-8">
                {qrStatus?.status === 'rescan_needed' ? '会话已失效，请重新扫码' : '正在获取二维码...'}
              </p>
            )}

            <div className="flex justify-center gap-2">
              <button onClick={() => setQrChannel(null)} className="px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50">关闭</button>
              {qrConnected && (
                <button onClick={disconnectQr} className="px-4 py-2 text-sm rounded-lg bg-red-500 text-white hover:bg-red-600">断开并登出</button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Facebook page choice modal ───────────────────────────── */}
      {fbPageChoice && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setFbPageChoice(null)}>
          <div className="bg-white rounded-xl w-full max-w-sm p-6" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-gray-900 mb-4">选择要接入的公共主页</h2>
            <div className="space-y-2 max-h-72 overflow-y-auto mb-4">
              {fbPageChoice.pages.map((p) => (
                <button
                  key={p.id}
                  onClick={() => submitFacebookCode(fbPageChoice.code, p.id)}
                  className="w-full text-left px-4 py-2.5 rounded-lg border border-gray-200 hover:border-brand-500 hover:bg-brand-50 text-sm text-gray-700"
                >
                  📘 {p.name}
                </button>
              ))}
            </div>
            <div className="flex justify-end">
              <button onClick={() => setFbPageChoice(null)} className="px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50">取消</button>
            </div>
          </div>
        </div>
      )}
      {/* fbConfig kept in state to avoid re-fetching during the login flow */}
      {fbConfig && !fbPageChoice ? null : null}

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
