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

interface AiGeneratedFlow {
  name: string;
  trigger_type: string;
  trigger_config: Record<string, unknown>;
  flow_graph: { nodes: { id: string; type: string; data: Record<string, unknown> }[]; edges: { source: string; target: string; label?: string }[] };
}

export default function BotFlowListPage() {
  const navigate = useNavigate();
  const [flows, setFlows]     = useState<BotFlow[]>([]);
  const [loading, setLoading] = useState(true);

  // AI generation modal state
  const [aiOpen, setAiOpen]           = useState(false);
  const [aiDescription, setAiDescription] = useState('');
  const [aiGenerating, setAiGenerating]   = useState(false);
  const [aiResult, setAiResult]           = useState<AiGeneratedFlow | null>(null);

  useEffect(() => {
    api.get('/bot-flows').then((r) => setFlows(r.data)).finally(() => setLoading(false));
  }, []);

  const generateAiFlow = async () => {
    if (aiDescription.trim().length < 5) { toast.error('请描述你想要的流程（至少 5 个字）'); return; }
    setAiGenerating(true);
    setAiResult(null);
    try {
      const { data } = await api.post('/ai/generate-flow', { description: aiDescription });
      setAiResult(data.data);
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message;
      toast.error(msg ?? 'AI 生成失败，请重试');
    } finally {
      setAiGenerating(false);
    }
  };

  const useAiFlow = async () => {
    if (!aiResult) return;
    try {
      const { data } = await api.post('/bot-flows', {
        ...aiResult,
        flow_graph: {
          nodes: aiResult.flow_graph.nodes,
          edges: aiResult.flow_graph.edges,
        },
      });
      toast.success('流程已创建，可继续编辑');
      setAiOpen(false);
      setAiDescription('');
      setAiResult(null);
      navigate(`/bot-flows/${data.id}`);
    } catch (e: unknown) {
      const err = e as { response?: { data?: { errors?: Record<string, string[]> } } };
      const first = err?.response?.data?.errors ? Object.values(err.response.data.errors)[0]?.[0] : null;
      toast.error(first ?? '保存流程失败');
    }
  };

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
        <div className="flex items-center gap-2">
          <button
            onClick={() => setAiOpen(true)}
            className="bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-700 hover:to-indigo-700 text-white text-sm rounded-lg px-4 py-2 transition"
            title="用 AI 根据描述自动生成流程"
          >
            ✨ AI 生成流程
          </button>
          <button
            onClick={() => navigate('/bot-flows/new')}
            className="bg-brand-600 hover:bg-brand-700 text-white text-sm rounded-lg px-4 py-2 transition"
          >
            + 新建机器人流程
          </button>
        </div>
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

      {/* ── AI generate modal ───────────────────────────────────── */}
      {aiOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => !aiGenerating && setAiOpen(false)}>
          <div className="bg-white rounded-xl w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-gray-900 mb-1">✨ AI 生成机器人流程</h2>
            <p className="text-xs text-gray-400 mb-4">用自然语言描述你想要的客服流程，AI 会自动生成可编辑的流程图。</p>

            <textarea
              value={aiDescription}
              onChange={(e) => setAiDescription(e.target.value)}
              disabled={aiGenerating}
              rows={5}
              placeholder="例如：客户进来先发欢迎语，然后询问想咨询的问题类型。如果是价格问题，介绍套餐并发送链接；如果是售后问题，收集订单号后转接人工；其他情况引导留言。"
              className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 resize-none mb-3 focus:outline-none focus:ring-2 focus:ring-violet-500 disabled:bg-gray-50"
            />

            {!aiResult && (
              <div className="flex justify-end gap-2">
                <button onClick={() => setAiOpen(false)} disabled={aiGenerating} className="px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50">取消</button>
                <button
                  onClick={generateAiFlow}
                  disabled={aiGenerating}
                  className="px-4 py-2 text-sm rounded-lg bg-gradient-to-r from-violet-600 to-indigo-600 text-white hover:from-violet-700 hover:to-indigo-700 disabled:opacity-50"
                >
                  {aiGenerating ? '生成中…（可能需要 1-2 分钟）' : '开始生成'}
                </button>
              </div>
            )}

            {aiGenerating && (
              <div className="text-center py-6">
                <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-violet-600" />
                <p className="text-xs text-gray-400 mt-2">AI 正在设计流程…</p>
              </div>
            )}

            {aiResult && (
              <>
                <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 mb-3">
                  <p className="text-sm font-medium text-gray-900 mb-2">📋 {aiResult.name}</p>
                  <div className="space-y-1">
                    {aiResult.flow_graph.nodes.map((n) => {
                      const icons: Record<string, string> = { send_message: '💬', collect_input: '✏️', condition: '🔀', set_variable: '📝', api_call: '🔌', handoff: '👤', end: '🏁' };
                      const labels: Record<string, string> = { send_message: '发送消息', collect_input: '收集输入', condition: '条件判断', set_variable: '设置变量', api_call: 'API 调用', handoff: '转接人工', end: '结束' };
                      const detail = (n.data?.text ?? n.data?.prompt ?? n.data?.url ?? '') as string;
                      return (
                        <div key={n.id} className="text-xs text-gray-600 flex items-center gap-1.5">
                          <span>{icons[n.type] ?? '⚙️'}</span>
                          <span className="text-gray-400">{labels[n.type] ?? n.type}</span>
                          {detail && <span className="truncate">— {String(detail).slice(0, 40)}</span>}
                        </div>
                      );
                    })}
                  </div>
                </div>
                <div className="flex justify-end gap-2">
                  <button onClick={generateAiFlow} disabled={aiGenerating} className="px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50">重新生成</button>
                  <button onClick={() => { setAiResult(null); setAiDescription(''); }} className="px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50">放弃</button>
                  <button onClick={useAiFlow} className="px-4 py-2 text-sm rounded-lg bg-brand-600 text-white hover:bg-brand-700">使用此流程 →</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
