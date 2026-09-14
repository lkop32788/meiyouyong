import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../lib/api';
import { useAuthStore } from '../stores/useAuthStore';
import { initSocket } from '../lib/socket';

export default function LoginPage() {
  const navigate = useNavigate();

  const [companySlug, setCompanySlug] = useState('');
  const [email,       setEmail]       = useState('');
  const [password,    setPassword]    = useState('');
  const [error,       setError]       = useState('');
  const [loading,     setLoading]     = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { data } = await api.post('/auth/login', {
        company_slug: companySlug,
        email,
        password,
      });

      const user = {
        id:                  data.user.id,
        name:                data.user.name,
        email:               data.user.email,
        role:                data.user.role,
        companyId:           data.user.company_id,
        skillTags:           data.user.skill_tags ?? [],
        maxConcurrentChats:  data.user.max_concurrent_chats ?? 5,
        avatarUrl:          data.user.avatar_url ?? null,
        timezone:           data.user.timezone,
      };

      localStorage.setItem('auth_token', data.token);
      localStorage.setItem('socket_token', data.socket_token);
      useAuthStore.setState({ token: data.token, socketToken: data.socket_token, user, isAuthenticated: true });
      initSocket(data.socket_token);

      // 客服账号登录后直接进入客服聊天页面
      navigate(data.user.role === 'agent' ? '/agent' : '/inbox');
    } catch {
      setError('邮箱、密码或手牌号码不正确。');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="bg-white shadow rounded-lg p-8 w-full max-w-sm">
        <h1 className="text-2xl font-bold text-gray-900 mb-6">红浪漫会所</h1>

        {error && (
          <div className="mb-4 rounded bg-red-50 border border-red-200 text-red-700 px-3 py-2 text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">手牌号码</label>
            <input
              type="text"
              value={companySlug}
              onChange={(e) => setCompanySlug(e.target.value)}
              required
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              placeholder="请输入"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">邮箱</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">密码</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-brand-600 hover:bg-brand-700 text-white font-medium py-2 rounded transition disabled:opacity-50"
          >
            {loading ? '登录中...' : '登录'}
          </button>
        </form>
      </div>
    </div>
  );
}
