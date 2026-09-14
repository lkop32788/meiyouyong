import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import api from '../../lib/api';

interface Company {
  id: string;
  name: string;
  slug: string;
  plan?: string;
  timezone?: string;
  locale?: string;
  is_active: boolean;
  users_count: number;
  created_at: string;
}

const EMPTY = { name: '', slug: '', timezone: '', locale: 'zh-CN', is_active: true };

export default function SystemCompaniesPage() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...EMPTY });
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');

  const load = useCallback((q?: string) => {
    setLoading(true);
    api.get('/system/companies', { params: q ? { search: q } : {} })
      .then((r) => setCompanies(r.data?.data ?? []))
      .catch(() => toast.error('加载公司列表失败'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const openCreate = () => { setEditingId(null); setForm({ ...EMPTY }); setModalOpen(true); };

  const openEdit = (c: Company) => {
    setEditingId(c.id);
    setForm({ name: c.name, slug: c.slug, timezone: c.timezone ?? '', locale: c.locale ?? '', is_active: c.is_active });
    setModalOpen(true);
  };

  const submit = async () => {
    if (!form.name.trim() || !form.slug.trim()) { toast.error('请填写公司名称和标识'); return; }
    setSaving(true);
    try {
      if (editingId) {
        await api.put(`/system/companies/${editingId}`, form);
        toast.success('公司已更新');
      } else {
        await api.post('/system/companies', form);
        toast.success('公司已创建');
      }
      setModalOpen(false);
      load(search);
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '保存失败';
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (c: Company) => {
    if (!window.confirm(`确定删除公司「${c.name}」吗？此操作不可恢复。`)) return;
    try {
      await api.delete(`/system/companies/${c.id}`);
      toast.success('公司已删除');
      load(search);
    } catch (e: unknown) {
      toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '删除失败');
    }
  };

  return (
    <div className="p-6 max-w-6xl mx-auto h-full overflow-y-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900">公司管理</h1>
          <p className="text-sm text-gray-400 mt-1">平台所有公司 · 共 {companies.length} 家</p>
        </div>
        <div className="flex items-center gap-3">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && load(search)}
            placeholder="搜索公司名称或标识..."
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-64 focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          <button onClick={() => load(search)} className="text-sm text-gray-500 hover:text-gray-700">搜索</button>
          <button onClick={openCreate} className="bg-brand-600 hover:bg-brand-700 text-white text-sm rounded-lg px-4 py-2">
            + 新建公司
          </button>
        </div>
      </div>

      {loading ? (
        <p className="text-gray-400 text-sm">加载中...</p>
      ) : companies.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <p className="text-lg mb-2">暂无公司</p>
          <button onClick={openCreate} className="text-brand-600 hover:underline text-sm">创建第一个公司</button>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600">公司名称</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">标识</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">套餐</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">成员</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">状态</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">创建时间</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {companies.map((c) => (
                <tr key={c.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-900">{c.name}</td>
                  <td className="px-4 py-3 text-gray-500 font-mono text-xs">{c.slug}</td>
                  <td className="px-4 py-3 text-gray-500">{c.plan ?? '—'}</td>
                  <td className="px-4 py-3 text-gray-500">{c.users_count}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-block text-xs rounded-full px-2 py-0.5 font-medium ${c.is_active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                      {c.is_active ? '活跃' : '已停用'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-xs">{c.created_at ? new Date(c.created_at).toLocaleDateString('zh-CN') : '—'}</td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    <button onClick={() => openEdit(c)} className="text-xs text-brand-600 hover:underline mr-3">编辑</button>
                    <button onClick={() => remove(c)} className="text-xs text-red-500 hover:underline">删除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modalOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setModalOpen(false)}>
          <div className="bg-white rounded-xl w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-gray-900 mb-4">{editingId ? '编辑公司' : '新建公司'}</h2>

            <label className="block text-sm text-gray-600 mb-1">公司名称 *</label>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-brand-500" />

            <label className="block text-sm text-gray-600 mb-1">公司标识（英文/数字） *</label>
            <input value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value.replace(/[^a-z0-9-]/gi, '').toLowerCase() })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-brand-500" />

            <label className="block text-sm text-gray-600 mb-1">时区</label>
            <input value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-brand-500" />

            <label className="block text-sm text-gray-600 mb-1">语言</label>
            <select value={form.locale} onChange={(e) => setForm({ ...form, locale: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-brand-500">
              <option value="zh-CN">简体中文</option>
              <option value="en">English</option>
              <option value="id">Bahasa Indonesia</option>
            </select>

            <label className="flex items-center gap-2 text-sm text-gray-600 mb-4 cursor-pointer">
              <input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
              启用公司
            </label>

            <div className="flex justify-end gap-2">
              <button onClick={() => setModalOpen(false)} className="px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50">取消</button>
              <button onClick={submit} disabled={saving}
                className="px-4 py-2 text-sm rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50">
                {saving ? '保存中...' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
