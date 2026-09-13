import { useEffect, useState } from 'react';
import api from '../../lib/api';

interface Channel {
  id: string;
  name: string;
  type: string;
  is_active: boolean;
  is_inbox_enabled?: boolean;
  provider?: string | null;
  created_at?: string;
}

const TYPE_LABEL: Record<string, string> = {
  whatsapp: 'WhatsApp',
  line: 'LINE',
  email: '邮箱',
  telegram: 'Telegram',
  sms: '短信',
};

const TYPE_ICON: Record<string, string> = {
  whatsapp: '🟢',
  line: '💚',
  email: '✉️',
  telegram: '✈️',
  sms: '📱',
};

export default function ChannelsPage() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/channels')
      .then((r) => setChannels(r.data?.data ?? r.data ?? []))
      .catch(() => setError('渠道接口暂未开放，请等待后端 API 就绪。'))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="p-6 max-w-5xl mx-auto h-full overflow-y-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900">渠道管理</h1>
          <p className="text-sm text-gray-400 mt-1">管理 WhatsApp、LINE、邮箱、Telegram 等接入渠道</p>
        </div>
        <button
          disabled
          className="bg-gray-300 text-gray-500 text-sm rounded-lg px-4 py-2 cursor-not-allowed"
          title="后端渠道 CRUD API 就绪后开放"
        >
          + 接入渠道
        </button>
      </div>

      {loading ? (
        <p className="text-gray-400 text-sm">加载中...</p>
      ) : error ? (
        <div className="bg-yellow-50 border border-yellow-200 text-yellow-700 rounded-lg px-4 py-3 text-sm">
          {error}
        </div>
      ) : channels.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <p className="text-lg mb-2">还没有接入任何渠道</p>
          <p className="text-sm">接入 WhatsApp / LINE / 邮箱等渠道后，即可在此统一管理。</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600">渠道</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">类型</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">状态</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">收件箱</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {channels.map((ch) => (
                <tr key={ch.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-900">
                    <span className="mr-2">{TYPE_ICON[ch.type] ?? '📱'}</span>{ch.name}
                  </td>
                  <td className="px-4 py-3 text-gray-500">{TYPE_LABEL[ch.type] ?? ch.type}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-block text-xs rounded-full px-2 py-0.5 font-medium ${ch.is_active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                      {ch.is_active ? '启用' : '停用'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-500">
                    {ch.is_inbox_enabled ? '已开启' : '关闭'}
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
