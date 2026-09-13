import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import api from '../../lib/api';
import { useAuthStore } from '../../stores/useAuthStore';

interface MetaApp {
  id: string;
  label: string;
  kind: string;
  app_id: string;
  config_id?: string | null;
  has_secret: boolean;
  secret_hint: string;
}

const KIND_LABEL: Record<string, string> = {
  facebook: 'Facebook / Messenger',
  whatsapp: 'WhatsApp（官方）',
};

const EMPTY_FORM = {
  label: '',
  kind: 'facebook',
  app_id: '',
  app_secret: '',
  config_id: '',
};

export default function MetaAppsPage() {
  const me = useAuthStore((s) => s.user);
  const [apps, setApps]         = useState<MetaApp[]>([]);
  const [loading, setLoading]   = useState(true);
  const [modalOpen, setModalOpen]   = useState(false);
  const [editingId, setEditingId]   = useState<string | null>(null);
  const [form, setForm]             = useState({ ...EMPTY_FORM });
  const [saving, setSaving]         = useState(false);
  const [verifying, setVerifying]   = useState<string | null>(null);

  const isAdmin = me?.role === 'super_admin' || me?.role === 'admin';

  const load = useCallback(() => {
    setLoading(true);
    api.get('/meta-apps')
      .then((r) => setApps(r.data?.data ?? []))
      .catch(() => toast.error('加载 Meta 应用配置失败'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const openCreate = () => {
    setEditingId(null);
    setForm({ ...EMPTY_FORM });
    setModalOpen(true);
  };

  const openEdit = (a: MetaApp) => {
    setEditingId(a.id);
    setForm({
      label: a.label,
      kind: a.kind,
      app_id: a.app_id,
      app_secret: '', // never echoed back
      config_id: a.config_id ?? '',
    });
    setModalOpen(true);
  };

  const submit = async () => {
    if (!form.label.trim() || !form.app_id.trim()) { toast.error('请填写名称和 App ID'); return; }
    if (!editingId && !form.app_secret.trim()) { toast.error('请填写 App Secret'); return; }

    setSaving(true);
    try {
      if (editingId) {
        await api.put(`/meta-apps/${editingId}`, {
          label: form.label,
          kind: form.kind,
          ...(form.app_secret ? { app_secret: form.app_secret } : {}),
          config_id: form.config_id || null,
        });
        toast.success('配置已更新');
      } else {
        await api.post('/meta-apps', { ...form, config_id: form.config_id || null });
        toast.success('Meta 应用已添加');
      }
      setModalOpen(false);
      load();
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message;
      toast.error(msg ?? '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const verify = async (a: MetaApp) => {
    setVerifying(a.id);
    try {
      const { data } = await api.post(`/meta-apps/${a.id}/verify`);
      if (data.data?.valid) {
        toast.success(`✅ App ${a.app_id} 验证通过`);
      } else {
        toast.error(`验证失败：${data.data?.error ?? '未知错误'}`);
      }
    } catch {
      toast.error('验证请求失败');
    } finally {
      setVerifying(null);
    }
  };

  const remove = async (a: MetaApp) => {
    if (!window.confirm(`确定删除「${a.label}」吗？已接入的渠道不受影响，但将无法新增同类授权。`)) return;
    try {
      await api.delete(`/meta-apps/${a.id}`);
      toast.success('已删除');
      load();
    } catch {
      toast.error('删除失败');
    }
  };

  if (!isAdmin) {
    return (
      <div className="p-6 max-w-5xl mx-auto">
        <div className="bg-yellow-50 border border-yellow-200 text-yellow-700 rounded-lg px-4 py-3 text-sm">
          仅管理员可以管理 Meta 应用配置。
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-5xl mx-auto h-full overflow-y-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Meta 应用配置</h1>
          <p className="text-sm text-gray-400 mt-1">
            配置多个 Meta 应用（Facebook Messenger / WhatsApp 官方接口），支持多账号接入
          </p>
        </div>
        <button onClick={openCreate} className="bg-brand-600 hover:bg-brand-700 text-white text-sm rounded-lg px-4 py-2">
          + 添加应用
        </button>
      </div>

      {loading ? (
        <p className="text-gray-400 text-sm">加载中...</p>
      ) : apps.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <p className="text-lg mb-2">还没有配置 Meta 应用</p>
          <p className="text-sm max-w-md mx-auto">
            前往 <a href="https://developers.facebook.com/apps" target="_blank" rel="noreferrer" className="text-brand-600 hover:underline">developers.facebook.com</a> 创建应用，
            在「设置 → 基础」中获取 App ID 和 App Secret，然后点击右上角「添加应用」。
          </p>
        </div>
      ) : (
        <div className="grid gap-4">
          {apps.map((a) => (
            <div key={a.id} className="bg-white rounded-xl border border-gray-200 p-4 flex items-center justify-between">
              <div>
                <div className="font-medium text-gray-900 flex items-center gap-2">
                  {a.kind === 'facebook' ? '📘' : '🟢'} {a.label}
                  <span className="text-xs bg-gray-100 text-gray-500 rounded-full px-2 py-0.5">{KIND_LABEL[a.kind] ?? a.kind}</span>
                </div>
                <div className="text-sm text-gray-500 mt-1">
                  App ID: <code className="bg-gray-50 px-1 rounded">{a.app_id}</code>
                  <span className="ml-2 text-gray-400">Secret {a.has_secret ? `已配置（${a.secret_hint}）` : '未配置'}</span>
                </div>
                {a.config_id && <div className="text-xs text-gray-400 mt-0.5">Config ID: {a.config_id}</div>}
              </div>
              <div className="flex items-center gap-2 whitespace-nowrap">
                <button
                  onClick={() => verify(a)}
                  disabled={verifying === a.id}
                  className="text-xs text-gray-600 hover:text-brand-600 border border-gray-300 rounded-lg px-3 py-1.5 hover:border-brand-500 disabled:opacity-50"
                >
                  {verifying === a.id ? '验证中...' : '验证'}
                </button>
                <button onClick={() => openEdit(a)} className="text-xs text-brand-600 hover:underline">编辑</button>
                <button onClick={() => remove(a)} className="text-xs text-red-500 hover:underline">删除</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {modalOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setModalOpen(false)}>
          <div className="bg-white rounded-xl w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-gray-900 mb-4">{editingId ? '编辑 Meta 应用' : '添加 Meta 应用'}</h2>

            <label className="block text-sm text-gray-600 mb-1">名称（自定义，便于区分多个账号）</label>
            <input
              value={form.label}
              onChange={(e) => setForm({ ...form, label: e.target.value })}
              placeholder="例如：主账号 / 客服号"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-brand-500"
            />

            <label className="block text-sm text-gray-600 mb-1">应用类型</label>
            <select
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              {Object.entries(KIND_LABEL).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>

            <label className="block text-sm text-gray-600 mb-1">App ID</label>
            <input
              value={form.app_id}
              onChange={(e) => setForm({ ...form, app_id: e.target.value })}
              disabled={!!editingId}
              placeholder="123456789012345"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:bg-gray-50 disabled:text-gray-400"
            />

            <label className="block text-sm text-gray-600 mb-1">
              App Secret{editingId ? '（留空保持不变）' : ''}
            </label>
            <input
              type="password"
              value={form.app_secret}
              onChange={(e) => setForm({ ...form, app_secret: e.target.value })}
              placeholder={editingId ? '不修改请留空' : '从 Meta 后台「设置 → 基础」获取'}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-brand-500"
            />

            <label className="block text-sm text-gray-600 mb-1">Config ID（可选，嵌入式登录用）</label>
            <input
              value={form.config_id}
              onChange={(e) => setForm({ ...form, config_id: e.target.value })}
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
    </div>
  );
}
