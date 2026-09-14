import { useEffect, useState } from 'react';
import { Link, Outlet } from 'react-router-dom';
import api from '../../lib/api';
import { useAuthStore } from '../../stores/useAuthStore';

interface Stats {
  total_companies: number;
  active_companies: number;
  total_users: number;
  total_conversations: number;
  total_channels: number;
}

const CARDS = [
  { label: '公司总数', key: 'total_companies' as keyof Stats, color: 'bg-blue-50 text-blue-700' },
  { label: '活跃公司', key: 'active_companies' as keyof Stats, color: 'bg-green-50 text-green-700' },
  { label: '用户总数', key: 'total_users' as keyof Stats, color: 'bg-purple-50 text-purple-700' },
  { label: '会话总数', key: 'total_conversations' as keyof Stats, color: 'bg-orange-50 text-orange-700' },
  { label: '渠道总数', key: 'total_channels' as keyof Stats, color: 'bg-teal-50 text-teal-700' },
];

export default function SystemDashboardPage() {
  const user = useAuthStore((s) => s.user);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/system/stats')
      .then((r) => setStats(r.data))
      .catch(() => null)
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="p-6 max-w-5xl mx-auto h-full overflow-y-auto">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-gray-900">系统管理</h1>
        <p className="text-sm text-gray-400 mt-1">
          欢迎，{user?.name}（{user?.role === 'super_admin' ? '超级管理员' : user?.role}）
        </p>
      </div>

      {loading ? (
        <p className="text-gray-400 text-sm">加载中...</p>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-8">
            {CARDS.map((c) => (
              <div key={c.key} className={`rounded-xl p-4 ${c.color}`}>
                <div className="text-2xl font-bold">{stats?.[c.key] ?? '—'}</div>
                <div className="text-sm mt-1">{c.label}</div>
              </div>
            ))}
          </div>

          <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100">
            <div className="flex items-center justify-between px-4 py-3 hover:bg-gray-50">
              <div>
                <div className="text-sm font-medium text-gray-900">公司管理</div>
                <div className="text-xs text-gray-400">查看、创建、编辑、停用所有公司</div>
              </div>
              <Link
                to="/system/companies"
                className="text-sm text-brand-600 hover:underline"
              >
                进入 →
              </Link>
            </div>
            <div className="flex items-center justify-between px-4 py-3 hover:bg-gray-50">
              <div>
                <div className="text-sm font-medium text-gray-900">用户管理</div>
                <div className="text-xs text-gray-400">跨公司管理所有用户账号与角色</div>
              </div>
              <Link
                to="/system/users"
                className="text-sm text-brand-600 hover:underline"
              >
                进入 →
              </Link>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
