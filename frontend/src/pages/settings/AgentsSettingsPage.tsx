import { useEffect, useState } from 'react';
import api from '../../lib/api';

interface AgentRow {
  id: string;
  name: string;
  email: string;
  role: string;
  is_active: boolean;
  max_concurrent_chats?: number;
}

const ROLE_LABEL: Record<string, string> = {
  super_admin: '超级管理员',
  admin: '管理员',
  supervisor: '主管',
  agent: '客服',
};

export default function AgentsSettingsPage() {
  const [agents, setAgents]     = useState<AgentRow[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');

  useEffect(() => {
    api.get('/agents')
      .then((r) => setAgents(r.data?.data ?? r.data ?? []))
      .catch(() => setError('无法加载客服列表，请稍后重试。'))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="p-6 max-w-5xl mx-auto h-full overflow-y-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900">客服管理</h1>
          <p className="text-sm text-gray-400 mt-1">团队成员与角色</p>
        </div>
        <button
          disabled
          className="bg-gray-300 text-gray-500 text-sm rounded-lg px-4 py-2 cursor-not-allowed"
          title="后端成员管理 API 就绪后开放"
        >
          + 添加客服
        </button>
      </div>

      {loading ? (
        <p className="text-gray-400 text-sm">加载中...</p>
      ) : error ? (
        <div className="bg-yellow-50 border border-yellow-200 text-yellow-700 rounded-lg px-4 py-3 text-sm">
          {error}
        </div>
      ) : agents.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <p className="text-lg mb-2">暂无客服成员</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600">成员</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">邮箱</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">角色</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">状态</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {agents.map((a) => (
                <tr key={a.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-900">
                    <span className="inline-flex items-center gap-2">
                      <span className="w-7 h-7 rounded-full bg-brand-100 text-brand-700 flex items-center justify-center text-xs font-bold">
                        {a.name?.charAt(0) ?? '?'}
                      </span>
                      {a.name}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-500">{a.email}</td>
                  <td className="px-4 py-3 text-gray-500">{ROLE_LABEL[a.role] ?? a.role}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-block text-xs rounded-full px-2 py-0.5 font-medium ${a.is_active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                      {a.is_active ? '启用' : '停用'}
                    </span>
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
