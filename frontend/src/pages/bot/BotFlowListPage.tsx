import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../lib/api';
import toast from 'react-hot-toast';

interface BotFlow {
  id: string;
  name: string;
  trigger_type: string;
  is_active: boolean;
  version: number;
  created_at: string;
}

export default function BotFlowListPage() {
  const navigate = useNavigate();
  const [flows, setFlows]     = useState<BotFlow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/bot-flows').then((r) => setFlows(r.data)).finally(() => setLoading(false));
  }, []);

  const toggle = async (flow: BotFlow) => {
    const action = flow.is_active ? 'deactivate' : 'activate';
    await api.post(`/bot-flows/${flow.id}/${action}`);
    setFlows((prev) =>
      prev.map((f) => (f.id === flow.id ? { ...f, is_active: !f.is_active } : f))
    );
    toast.success(flow.is_active ? '机器人已停用' : '机器人已启用');
  };

  const duplicate = async (id: string) => {
    const { data } = await api.post(`/bot-flows/${id}/duplicate`);
    setFlows((prev) => [data, ...prev]);
    toast.success('Bot flow 已复制');
  };

  const remove = async (id: string) => {
    if (!confirm('确定删除此 Bot flow 吗？')) return;
    await api.delete(`/bot-flows/${id}`);
    setFlows((prev) => prev.filter((f) => f.id !== id));
    toast.success('Bot flow 已删除');
  };

  const TRIGGER_LABEL: Record<string, string> = {
    keyword: '关键词',
    any_message: '所有消息',
    intent: '意图',
    event: '事件',
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold text-gray-900">机器人流程</h1>
        <button
          onClick={() => navigate('/bot-flows/new')}
          className="bg-brand-600 hover:bg-brand-700 text-white text-sm rounded-lg px-4 py-2 transition"
        >
          + 新建机器人流程
        </button>
      </div>

      {loading ? (
        <p className="text-gray-400 text-sm">加载中...</p>
      ) : flows.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <p className="text-lg mb-2">还没有机器人流程</p>
          <p className="text-sm">创建第一个流程来自动化您的客户对话。</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600">名称</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">触发方式</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">版本</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">状态</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {flows.map((flow) => (
                <tr key={flow.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-900">{flow.name}</td>
                  <td className="px-4 py-3 text-gray-500">{TRIGGER_LABEL[flow.trigger_type] ?? flow.trigger_type}</td>
                  <td className="px-4 py-3 text-gray-500">v{flow.version}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-block text-xs rounded-full px-2 py-0.5 font-medium ${
                        flow.is_active
                          ? 'bg-green-100 text-green-700'
                          : 'bg-gray-100 text-gray-500'
                      }`}
                    >
                      {flow.is_active ? '启用' : '停用'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => navigate(`/bot-flows/${flow.id}`)}
                        className="text-xs text-brand-600 hover:underline"
                      >
                        编辑
                      </button>
                      <button
                        onClick={() => toggle(flow)}
                        className="text-xs text-gray-600 hover:underline"
                      >
                        {flow.is_active ? '停用' : '启用'}
                      </button>
                      <button
                        onClick={() => duplicate(flow.id)}
                        className="text-xs text-gray-600 hover:underline"
                      >
                        复制
                      </button>
                      <button
                        onClick={() => remove(flow.id)}
                        className="text-xs text-red-500 hover:underline"
                      >
                        删除
                      </button>
                    </div>
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
