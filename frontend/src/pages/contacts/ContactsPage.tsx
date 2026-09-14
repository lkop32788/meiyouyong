import { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import api from '../../lib/api';

interface Contact {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  tags: string[];
  created_at: string;
}

const EMPTY_FORM = { name: '', phone: '', email: '', tags: '' };

export default function ContactsPage() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [page, setPage] = useState(1);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [allTags, setAllTags] = useState<string[]>([]);
  const importRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback((p = 1, q?: string, tag?: string) => {
    setLoading(true);
    api.get('/contacts', { params: { page: p, search: q, tag: tag || undefined } })
      .then((r) => {
        const d = r.data;
        setContacts(d.data ?? []);
        setTotal(d.total ?? 0);
      })
      .catch(() => toast.error('加载联系人失败'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(page, search, tagFilter); }, [page, search, tagFilter]);

  // Gather unique tags from current page
  useEffect(() => {
    const tags = new Set<string>();
    contacts.forEach((c) => (c.tags ?? []).forEach((t) => tags.add(t)));
    setAllTags(Array.from(tags).sort());
  }, [contacts]);

  const openCreate = () => { setEditingId(null); setForm({ ...EMPTY_FORM }); setModalOpen(true); };

  const openEdit = (c: Contact) => {
    setEditingId(c.id);
    setForm({ name: c.name, phone: c.phone ?? '', email: c.email ?? '', tags: (c.tags ?? []).join(';') });
    setModalOpen(true);
  };

  const handleSave = async () => {
    if (!form.name.trim()) { toast.error('请填写姓名'); return; }
    setSaving(true);
    setSubmitting(true);
    try {
      const tags = form.tags ? form.tags.split(/[;,]/).map((t) => t.trim()).filter(Boolean) : [];
      const payload = { name: form.name, phone: form.phone || null, email: form.email || null, tags };
      if (editingId) {
        await api.patch(`/contacts/${editingId}`, payload);
        toast.success('联系人已更新');
      } else {
        await api.post('/contacts', payload);
        toast.success('联系人已添加');
      }
      setModalOpen(false);
      load(page, search, tagFilter);
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '保存失败';
      toast.error(msg);
    } finally {
      setSaving(false);
      setSubmitting(false);
    }
  };

  const handleDelete = async (c: Contact) => {
    if (!window.confirm(`确定删除「${c.name}」吗？`)) return;
    setSubmitting(true);
    try {
      await api.delete(`/contacts/${c.id}`);
      toast.success('已删除');
      load(page, search, tagFilter);
    } catch {
      toast.error('删除失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    setSubmitting(true);
    const fd = new FormData();
    fd.append('file', file);
    try {
      const r = await api.post('/contacts/import', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      toast.success(r.data.message ?? '导入成功');
      load(1, '', '');
      setPage(1);
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '导入失败';
      toast.error(msg);
    } finally {
      setImporting(false);
      setSubmitting(false);
      if (importRef.current) importRef.current.value = '';
    }
  };

  const handleExport = async () => {
    setSubmitting(true);
    try {
      const r = await api.get('/contacts/export', { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([r.data]));
      const a = document.createElement('a');
      a.href = url;
      a.download = `contacts-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch {
      toast.error('导出失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleTemplate = async () => {
    setSubmitting(true);
    try {
      const r = await api.get('/contacts/template', { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([r.data]));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'contacts-template.csv';
      a.click();
      window.URL.revokeObjectURL(url);
    } catch {
      toast.error('下载模板失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="p-6 max-w-6xl mx-auto h-full overflow-y-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900">联系人管理</h1>
          <p className="text-sm text-gray-400 mt-1">共 {total} 位联系人</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={handleExport} disabled={submitting}
            className="text-sm border border-gray-300 rounded-lg px-3 py-2 text-gray-600 hover:bg-gray-50 transition">
            导出 CSV
          </button>
          <button onClick={handleTemplate} disabled={submitting}
            className="text-sm border border-gray-300 rounded-lg px-3 py-2 text-gray-600 hover:bg-gray-50 transition">
            下载模板
          </button>
          <input ref={importRef} type="file" accept=".csv" className="hidden" onChange={handleImport} />
          <button onClick={() => importRef.current?.click()} disabled={submitting || importing}
            className="text-sm border border-gray-300 rounded-lg px-3 py-2 text-gray-600 hover:bg-gray-50 transition">
            {importing ? '导入中...' : '导入 CSV'}
          </button>
          <button onClick={openCreate}
            className="bg-brand-600 hover:bg-brand-700 text-white text-sm rounded-lg px-4 py-2 transition">
            + 新建联系人
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 mb-4">
        <input
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          onKeyDown={(e) => e.key === 'Enter' && load(1, search, tagFilter)}
          placeholder="搜索姓名、电话或邮箱..."
          className="flex-1 max-w-xs border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        <select
          value={tagFilter}
          onChange={(e) => { setTagFilter(e.target.value); setPage(1); }}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 bg-white"
        >
          <option value="">全部标签</option>
          {allTags.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <button onClick={() => load(1, search, tagFilter)}
          className="text-sm text-brand-600 hover:underline">搜索</button>
      </div>

      {/* Table */}
      {loading ? (
        <p className="text-gray-400 text-sm">加载中...</p>
      ) : contacts.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <p className="text-lg mb-2">暂无联系人</p>
          <button onClick={openCreate} className="text-brand-600 hover:underline text-sm">新建第一个联系人</button>
        </div>
      ) : (
        <>
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">姓名</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">电话</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">邮箱</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">标签</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">创建时间</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {contacts.map((c) => (
                  <tr key={c.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium text-gray-900">{c.name}</td>
                    <td className="px-4 py-3 text-gray-500">{c.phone ?? '—'}</td>
                    <td className="px-4 py-3 text-gray-500">{c.email ?? '—'}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {(c.tags ?? []).map((t) => (
                          <span key={t} className="inline-block text-xs rounded-full px-2 py-0.5 bg-blue-50 text-blue-600">{t}</span>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-gray-400 text-xs">{c.created_at ? new Date(c.created_at).toLocaleDateString('zh-CN') : '—'}</td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <button onClick={() => openEdit(c)} className="text-xs text-brand-600 hover:underline mr-3">编辑</button>
                      <button onClick={() => handleDelete(c)} className="text-xs text-red-500 hover:underline">删除</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between mt-4">
            <span className="text-sm text-gray-400">共 {total} 条</span>
            <div className="flex items-center gap-1">
              <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}
                className="px-3 py-1 text-sm border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-40">上一页</button>
              <span className="px-3 py-1 text-sm text-gray-500">第 {page} 页</span>
              <button onClick={() => setPage((p) => p + 1)} disabled={contacts.length < 20}
                className="px-3 py-1 text-sm border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-40">下一页</button>
            </div>
          </div>
        </>
      )}

      {/* Modal */}
      {modalOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setModalOpen(false)}>
          <div className="bg-white rounded-xl w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-gray-900 mb-4">{editingId ? '编辑联系人' : '新建联系人'}</h2>

            <label className="block text-sm text-gray-600 mb-1">姓名 *</label>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-brand-500" />

            <label className="block text-sm text-gray-600 mb-1">电话</label>
            <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })}
              placeholder="+86 13800138000"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-brand-500" />

            <label className="block text-sm text-gray-600 mb-1">邮箱</label>
            <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-brand-500" />

            <label className="block text-sm text-gray-600 mb-1">标签（多个用分号分隔）</label>
            <input value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })}
              placeholder="VIP;客户;潜在"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-brand-500" />

            <div className="flex justify-end gap-2">
              <button onClick={() => setModalOpen(false)} className="px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50">取消</button>
              <button onClick={handleSave} disabled={saving}
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
