import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import api from '../../lib/api';

interface User {
  id: string;
  company_id: string;
  company_name?: string;
  name: string;
  email: string;
  role: string;
  is_active: boolean;
  max_concurrent_chats: number;
  created_at: string;
}

interface Company {
  id: string;
  name: string;
}

const ROLE_LABEL: Record<string, string> = {
  super_admin: '超级管理员',
  admin: '管理员',
  supervisor: '主管',
  agent: '客服',
};

const ROLE_OPTIONS = ['admin', 'supervisor', 'agent'] as const;

const EMPTY_FORM = {
  company_id: '',
  name: '',
  email: '',
  password: '',
  role: 'agent' as string,
  max_concurrent_chats: 5,
};

export default function SystemUsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const [filterRole, setFilterRole] = useState('');
  const [filterCompany, setFilterCompany] = useState('');

  const load = useCallback((params?: Record<string, string>) => {
    setLoading(true);
    api.get('/system/users', { params: Object.keys(params ?? {}).length ? params : undefined })
      .then((r) => setUsers(r.data?.data ?? []))
      .catch(() => toast.error('加载用户列表失败'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const params: Record<string, string> = {};
    if (search) params.search = search;
    if (filterRole) params.role = filterRole;
    if (filterCompany) params.company_id = filterCompany;
    load(params);
  }, [search, filterRole, filterCompany, load]);

  useEffect(() => {
    api.get('/system/companies').then((r) => setCompanies(r.data?.data ?? [])).catch(() => {});
  }, []);

  const openCreate = () => { setEditingId(null); setForm({ ...EMPTY_FORM, company_id: companies[0]?.id ?? '' }); setModalOpen(true); };

  const openEdit = (u: User) => {
    setEditingId(u.id);
    setForm({
      company_id: u.company_id,
      name: u.name,
      email: u.email,
      password: '',
      role: u.role === 'super_admin' ? 'admin' : u.role,
      max_concurrent_chats: u.max_concurrent_chats ?? 5,
    });
    setModalOpen(true);
  };

  const submit = async () => {
    if (!form.name.trim() || !form.email.trim()) { toast.error('请填写姓名和邮箱'); return; }
    if (!editingId && !form.password.trim()) { toast.error('请填写密码'); return; }
    setSaving(true);
    try {
      if (editingId) {
        await api.put(`/system/users/${editingId}`, {
          name: form.name,
          role: form.role,
          max_concurrent_chats: form.max_concurrent_chats,
          ...(form.password ? { password: form.password } : {}),
        });
        toast.success('用户已更新');
      } else {
        if (form.password.length < 8) { toast.error('密码至少 8 位'); setSaving(false); return; }
        await api.post('/system/users', {
          company_id: form.company_id,
          name: form.name,
          email: form.email,
          password: form.password,
          role: form.role,
          max_concurrent_chats: form.max_concurrent_chats,
        });
        toast.success('用户已创建');
      }
      setModalOpen(false);
      load();
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '保存失败';
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (u: User) => {
    if (!window.confirm(`确定删除用户「${u.name}」吗？`)) return;
    try {
      await api.delete(`/system/users/${u.id}`);
      toast.success('用户已删除');
      load();
    } catch (e: unknown) {
      toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '删除失败');
    }
  };

  return (
    <div className="p-6 max-w-6xl mx-auto h-full overflow-y-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900">用户管理</h1>
          <p className="text-sm text-gray-400 mt-1">跨公司全局用户管理 · 共 {users.length} 人</p>
        </div>
        <button onClick={openCreate} className="bg-brand-600 hover:bg-brand-700 text-white text-sm rounded-lg px-4 py-2">
          + 新建用户
        </button>
      </div>

      <div className="flex items-center gap-3 mb-4">
        <input value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索姓名或邮箱..."
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-48 focus:outline-none focus:ring-2 focus:ring-brand-500" />
        <select value={filterRole} onChange={(e) => setFilterRole(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500">
          <option value="">全部角色</option>
          {ROLE_OPTIONS.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
        </select>
        <select value={filterCompany} onChange={(e) => setFilterCompany(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500">
          <option value="">全部公司</option>
          {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>

      {loading ? (
        <p className="text-gray-400 text-sm">加载中...</p>
      ) : users.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <p className="text-lg mb-2">暂无用户</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600">用户</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">邮箱</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">公司</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">角色</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">状态</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">创建时间</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {users.map((u) => (
                <tr key={u.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-900">{u.name}</td>
                  <td className="px-4 py-3 text-gray-500">{u.email}</td>
                  <td className="px-4 py-3 text-gray-500">{u.company_name ?? '—'}</td>
                  <td className="px-4 py-3 text-gray-500">{ROLE_LABEL[u.role] ?? u.role}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-block text-xs rounded-full px-2 py-0.5 font-medium ${u.is_active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                      {u.is_active ? '启用' : '已停用'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-xs">{u.created_at ? new Date(u.created_at).toLocaleDateString('zh-CN') : '—'}</td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    <button onClick={() => openEdit(u)} className="text-xs text-brand-600 hover:underline mr-3">编辑</button>
                    {u.role !== 'super_admin' && (
                      <button onClick={() => remove(u)} className="text-xs text-red-500 hover:underline">删除</button>
                    )}
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
            <h2 className="text-lg font-bold text-gray-900 mb-4">{editingId ? '编辑用户' : '新建用户'}</h2>

            {!editingId && (
              <>
                <label className="block text-sm text-gray-600 mb-1">所属公司 *</label>
                <select value={form.company_id} onChange={(e) => setForm({ ...form, company_id: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-brand-500">
                  <option value="">请选择公司</option>
                  {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </>
            )}

            <label className="block text-sm text-gray-600 mb-1">姓名 *</label>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-brand-500" />

            {!editingId && (
              <>
                <label className="block text-sm text-gray-600 mb-1">邮箱 *</label>
                <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-brand-500" />

                <label className="block text-sm text-gray-600 mb-1">密码（{editingId ? '留空则不修改' : '至少 8 位'}）</label>
                <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-brand-500" />
              </>
            )}

            <label className="block text-sm text-gray-600 mb-1">角色</label>
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-brand-500">
              {ROLE_OPTIONS.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            </select>

            <label className="block text-sm text-gray-600 mb-1">最大并行会话数</label>
            <input type="number" min={1} max={50} value={form.max_concurrent_chats}
              onChange={(e) => setForm({ ...form, max_concurrent_chats: Number(e.target.value) })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-brand-500" />

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
