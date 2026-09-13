import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../../lib/api';
import toast from 'react-hot-toast';

interface FlowNode {
  id: string;
  type: string;
  data: Record<string, unknown>;
  children?: FlowNode[];
}

interface BotFlow {
  id?: string;
  name: string;
  trigger_type: string;
  trigger_config: Record<string, unknown>;
  flow_graph: { nodes: FlowNode[]; edges: Array<{ source: string; target: string; label?: string }> };
  is_active: boolean;
}

const NODE_TYPES = [
  { value: 'send_message',  label: '发送消息' },
  { value: 'collect_input', label: '收集输入' },
  { value: 'condition',     label: '条件判断' },
  { value: 'set_variable',  label: '设置变量' },
  { value: 'api_call',      label: 'API 调用' },
  { value: 'handoff',       label: '转接人工' },
  { value: 'end',           label: '结束' },
];

const EMPTY_FLOW: BotFlow = {
  name: '',
  trigger_type: 'keyword',
  trigger_config: { keywords: [] },
  flow_graph: {
    nodes: [
      { id: 'start', type: 'send_message', data: { text: '您好！请问有什么可以帮您？' } },
      { id: 'end-1', type: 'end', data: {} },
    ],
    edges: [{ source: 'start', target: 'end-1' }],
  },
  is_active: false,
};

export default function BotFlowEditorPage() {
  const { id }        = useParams<{ id: string }>();
  const navigate      = useNavigate();
  const isNew         = id === 'new';
  const [flow, setFlow]       = useState<BotFlow>(EMPTY_FLOW);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving]   = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [keywordInput, setKeywordInput]     = useState('');

  // AI append modal state
  const [aiOpen, setAiOpen]           = useState(false);
  const [aiInstruction, setAiInstruction] = useState('');
  const [aiTarget, setAiTarget]           = useState('');
  const [aiLoading, setAiLoading]         = useState(false);
  const [aiPreview, setAiPreview]         = useState<{ nodes: FlowNode[]; edges: { source: string; target: string; label?: string }[]; entry_label: string | null } | null>(null);

  useEffect(() => {
    if (!isNew && id) {
      api.get(`/bot-flows/${id}`)
        .then((r) => setFlow(r.data))
        .finally(() => setLoading(false));
    }
  }, [id, isNew]);

  const save = async () => {
    if (!flow.name.trim()) { toast.error('请填写流程名称'); return; }
    setSaving(true);
    try {
      if (isNew) {
        const { data } = await api.post('/bot-flows', flow);
        toast.success('Bot flow 创建成功');
        navigate(`/bot-flows/${data.id}`, { replace: true });
      } else {
        await api.put(`/bot-flows/${id}`, flow);
        toast.success('Bot flow 已保存');
      }
    } finally {
      setSaving(false);
    }
  };

  const addNode = (type: string) => {
    const newId = `node-${Date.now()}`;
    const node: FlowNode = { id: newId, type, data: {} };
    setFlow((f) => ({
      ...f,
      flow_graph: {
        ...f.flow_graph,
        nodes: [...f.flow_graph.nodes, node],
      },
    }));
    setSelectedNodeId(newId);
  };

  const updateNodeData = (nodeId: string, key: string, value: unknown) => {
    setFlow((f) => ({
      ...f,
      flow_graph: {
        ...f.flow_graph,
        nodes: f.flow_graph.nodes.map((n) =>
          n.id === nodeId ? { ...n, data: { ...n.data, [key]: value } } : n
        ),
      },
    }));
  };

  const removeNode = (nodeId: string) => {
    setFlow((f) => ({
      ...f,
      flow_graph: {
        nodes: f.flow_graph.nodes.filter((n) => n.id !== nodeId),
        edges: f.flow_graph.edges.filter((e) => e.source !== nodeId && e.target !== nodeId),
      },
    }));
    if (selectedNodeId === nodeId) setSelectedNodeId(null);
  };

  // ── AI append ──────────────────────────────────────────────────────
  const openAiModal = () => {
    const lastNode = flow.flow_graph.nodes[flow.flow_graph.nodes.length - 1];
    setAiTarget(selectedNodeId ?? lastNode?.id ?? '');
    setAiPreview(null);
    setAiInstruction('');
    setAiOpen(true);
  };

  const generateNodes = async () => {
    setAiLoading(true);
    setAiPreview(null);
    try {
      const { data } = await api.post('/ai/append-nodes', {
        nodes: flow.flow_graph.nodes.map((n) => ({ id: n.id, type: n.type, data: n.data })),
        target: aiTarget || undefined,
        instruction: aiInstruction || undefined,
      });
      setAiPreview(data.data);
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message;
      toast.error(msg ?? 'AI 生成失败，请重试');
    } finally {
      setAiLoading(false);
    }
  };

  const applyAiNodes = () => {
    if (!aiPreview || aiPreview.nodes.length === 0) return;
    const firstId = aiPreview.nodes[0].id;
    setFlow((f) => {
      const newEdges = [...aiPreview.edges];
      if (aiTarget && f.flow_graph.nodes.some((n) => n.id === aiTarget)) {
        newEdges.push({ source: aiTarget, target: firstId, label: aiPreview.entry_label ?? undefined });
      } else {
        // chain from the last node without outgoing edges (flow tail)
        const tail = [...f.flow_graph.nodes].reverse()
          .find((n) => !f.flow_graph.edges.some((e) => e.source === n.id))
          ?? f.flow_graph.nodes[f.flow_graph.nodes.length - 1];
        if (tail) newEdges.push({ source: tail.id, target: firstId });
      }
      return {
        ...f,
        flow_graph: {
          nodes: [...f.flow_graph.nodes, ...aiPreview.nodes],
          edges: [...f.flow_graph.edges, ...newEdges],
        },
      };
    });
    setSelectedNodeId(firstId);
    setAiOpen(false);
    setAiPreview(null);
    setAiInstruction('');
    toast.success('已插入 AI 节点，检查后请点击「保存流程」');
  };

  const addEdge = (source: string, target: string, label?: string) => {
    setFlow((f) => ({
      ...f,
      flow_graph: {
        ...f.flow_graph,
        edges: [...f.flow_graph.edges, { source, target, label }],
      },
    }));
  };

  const selectedNode = flow.flow_graph.nodes.find((n) => n.id === selectedNodeId);

  if (loading) return <div className="p-6 text-gray-400">加载中...</div>;

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left panel — node tree */}
      <div className="w-64 border-r border-gray-200 bg-white flex flex-col shrink-0 overflow-hidden">
        <div className="px-3 py-2 border-b border-gray-100 flex items-center justify-between">
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">节点</h3>
          <div className="flex items-center gap-2">
            <button
              onClick={openAiModal}
              title="用 AI 追加一段节点"
              className="text-xs text-violet-600 hover:text-violet-700"
            >
              ✨ AI
            </button>
            <div className="relative group">
              <button className="text-xs text-brand-600">+ 添加</button>
            <div className="absolute left-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-10 hidden group-hover:block min-w-[160px]">
              {NODE_TYPES.map((t) => (
                <button
                  key={t.value}
                  onClick={() => addNode(t.value)}
                  className="w-full text-left px-3 py-2 text-xs hover:bg-gray-50 text-gray-700"
                >
                  {t.label}
                </button>
              ))}
            </div>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {flow.flow_graph.nodes.map((node) => (
            <button
              key={node.id}
              onClick={() => setSelectedNodeId(node.id)}
              className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-gray-50 border-b border-gray-50 ${
                selectedNodeId === node.id ? 'bg-brand-50 border-l-2 border-l-brand-500' : ''
              }`}
            >
              <NodeIcon type={node.type} />
              <span className="truncate flex-1">{nodeLabel(node)}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Center — flow graph visualization (simplified tree) */}
      <div className="flex-1 overflow-auto bg-gray-50 p-6">
        <div className="flex flex-col items-center gap-2">
          {flow.flow_graph.nodes.map((node, idx) => {
            const outEdges = flow.flow_graph.edges.filter((e) => e.source === node.id);
            return (
              <div key={node.id} className="flex flex-col items-center gap-2">
                <div
                  onClick={() => setSelectedNodeId(node.id)}
                  className={`rounded-xl border-2 px-5 py-3 text-sm font-medium cursor-pointer transition select-none min-w-[200px] text-center ${
                    selectedNodeId === node.id
                      ? 'border-brand-500 bg-brand-50 text-brand-700'
                      : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300'
                  }`}
                >
                  <span className="block text-[11px] text-gray-400 mb-0.5">{NODE_TYPES.find((t) => t.value === node.type)?.label ?? node.type}</span>
                  {nodeLabel(node)}
                </div>
                {outEdges.map((edge) => (
                  <div key={edge.target} className="flex flex-col items-center gap-0">
                    <div className="w-px h-6 bg-gray-300" />
                    {edge.label && (
                      <span className="text-[10px] text-gray-400 bg-white border border-gray-200 rounded px-1">{edge.label}</span>
                    )}
                    <div className="w-px h-2 bg-gray-300" />
                  </div>
                ))}
                {idx === flow.flow_graph.nodes.length - 1 && outEdges.length === 0 && null}
              </div>
            );
          })}
        </div>
      </div>

      {/* Right panel — node properties + flow settings */}
      <div className="w-72 border-l border-gray-200 bg-white flex flex-col shrink-0 overflow-hidden">
        {/* Flow settings at top */}
        <div className="p-3 border-b border-gray-100 space-y-2">
          <input
            value={flow.name}
            onChange={(e) => setFlow((f) => ({ ...f, name: e.target.value }))}
            placeholder="机器人流程名称"
            className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500"
          />

          <select
            value={flow.trigger_type}
            onChange={(e) => setFlow((f) => ({ ...f, trigger_type: e.target.value }))}
            className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 bg-white focus:outline-none"
          >
            <option value="keyword">关键词</option>
            <option value="any_message">所有消息</option>
            <option value="intent">意图</option>
            <option value="event">事件</option>
          </select>

          {flow.trigger_type === 'keyword' && (
            <div>
              <div className="flex gap-1 mb-1">
                <input
                  value={keywordInput}
                  onChange={(e) => setKeywordInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && keywordInput.trim()) {
                      const kw = keywordInput.trim();
                      setFlow((f) => ({
                        ...f,
                        trigger_config: {
                          ...f.trigger_config,
                          keywords: [...((f.trigger_config.keywords as string[]) ?? []), kw],
                        },
                      }));
                      setKeywordInput('');
                    }
                  }}
                  placeholder="添加关键词（回车确认）"
                  className="flex-1 text-xs border border-gray-200 rounded px-2 py-1 focus:outline-none"
                />
              </div>
              <div className="flex flex-wrap gap-1">
                {((flow.trigger_config.keywords as string[]) ?? []).map((kw) => (
                  <span key={kw} className="text-[11px] bg-brand-100 text-brand-700 rounded-full px-2 py-0.5 flex items-center gap-1">
                    {kw}
                    <button
                      onClick={() =>
                        setFlow((f) => ({
                          ...f,
                          trigger_config: {
                            ...f.trigger_config,
                            keywords: ((f.trigger_config.keywords as string[]) ?? []).filter((k) => k !== kw),
                          },
                        }))
                      }
                      className="hover:text-red-600 text-xs"
                    >×</button>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Node properties */}
        <div className="flex-1 overflow-y-auto p-3">
          {selectedNode ? (
            <NodeEditor node={selectedNode} onChange={updateNodeData} onRemove={removeNode} onAddEdge={addEdge} nodes={flow.flow_graph.nodes} />
          ) : (
            <p className="text-xs text-gray-400">选择一个节点以编辑其属性。</p>
          )}
        </div>

        {/* Save button */}
        <div className="p-3 border-t border-gray-100">
          <button
            onClick={save}
            disabled={saving}
            className="w-full bg-brand-600 hover:bg-brand-700 text-white text-sm rounded-lg py-2 transition disabled:opacity-40"
          >
            {saving ? '保存中...' : '保存流程'}
          </button>
          <button
            onClick={() => navigate('/bot-flows')}
            className="w-full mt-1 text-xs text-gray-500 hover:text-gray-700 py-1"
          >
            返回列表
          </button>
        </div>
      </div>

      {/* ── AI append modal ───────────────────────────────────────── */}
      {aiOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => !aiLoading && setAiOpen(false)}>
          <div className="bg-white rounded-xl w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-gray-900 mb-1">✨ AI 追加节点</h2>
            <p className="text-xs text-gray-400 mb-4">描述要追加的内容，AI 会设计接下来的节点并接入当前流程。</p>

            <label className="block text-xs text-gray-500 mb-1">接入点（新节点接在该节点之后）</label>
            <select
              value={aiTarget}
              onChange={(e) => setAiTarget(e.target.value)}
              className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 mb-3 bg-white focus:outline-none focus:ring-2 focus:ring-violet-500"
            >
              <option value="">流程末尾</option>
              {flow.flow_graph.nodes.map((n) => (
                <option key={n.id} value={n.id}>{nodeLabel(n)}</option>
              ))
              }
            </select>

            <label className="block text-xs text-gray-500 mb-1">追加需求（可选）</label>
            <textarea
              value={aiInstruction}
              onChange={(e) => setAiInstruction(e.target.value)}
              disabled={aiLoading}
              rows={4}
              placeholder="例如：询问订单号，如果查到物流信息就播报，否则引导联系人工客服。"
              className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 resize-none mb-3 focus:outline-none focus:ring-2 focus:ring-violet-500 disabled:bg-gray-50"
            />

            {!aiPreview && (
              <div className="flex justify-end gap-2">
                <button onClick={() => setAiOpen(false)} disabled={aiLoading} className="px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50">取消</button>
                <button
                  onClick={generateNodes}
                  disabled={aiLoading}
                  className="px-4 py-2 text-sm rounded-lg bg-gradient-to-r from-violet-600 to-indigo-600 text-white hover:from-violet-700 hover:to-indigo-700 disabled:opacity-50"
                >
                  {aiLoading ? '生成中…（约 10-20 秒）' : '生成节点'}
                  </button>
              </div>
            )}

            {aiLoading && (
              <div className="text-center py-6">
                <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-violet-600" />
                <p className="text-xs text-gray-400 mt-2">AI 正在设计节点…</p>
              </div>
            )}

            {aiPreview && (
              <>
                <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 mb-3">
                  <p className="text-xs font-medium text-gray-700 mb-2">将插入 {aiPreview.nodes.length} 个节点：</p>
                  <div className="space-y-1">
                    {aiPreview.nodes.map((n) => {
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
                  <button onClick={generateNodes} disabled={aiLoading} className="px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50">重新生成</button>
                  <button onClick={() => { setAiPreview(null); }} className="px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50">放弃</button>
                  <button onClick={applyAiNodes} className="px-4 py-2 text-sm rounded-lg bg-brand-600 text-white hover:bg-brand-700">插入到流程</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function nodeLabel(node: FlowNode): string {
  switch (node.type) {
    case 'send_message':  return (node.data.text as string | undefined)?.slice(0, 30) || '发送消息';
    case 'collect_input': return `询问：${node.data.variable ?? 'input'}`;
    case 'condition':     return `如果 ${node.data.variable ?? '?'} ${node.data.operator ?? '='} ${node.data.value ?? '?'}`;
    case 'set_variable':  return `设置 ${node.data.variable ?? '?'}`;
    case 'api_call':      return `API：${node.data.url as string ?? ''}`.slice(0, 30);
    case 'handoff':       return '转接人工';
    case 'end':           return '结束';
    default:              return node.type;
  }
}

function NodeIcon({ type }: { type: string }) {
  const icons: Record<string, string> = {
    send_message:  '💬',
    collect_input: '✏️',
    condition:     '🔀',
    set_variable:  '📝',
    api_call:      '🔌',
    handoff:       '👤',
    end:           '🏁',
  };
  return <span className="text-base shrink-0">{icons[type] ?? '⚙️'}</span>;
}

function NodeEditor({
  node, onChange, onRemove, onAddEdge, nodes,
}: {
  node: FlowNode;
  onChange: (id: string, key: string, value: unknown) => void;
  onRemove: (id: string) => void;
  onAddEdge: (source: string, target: string, label?: string) => void;
  nodes: FlowNode[];
}) {
  const [edgeTarget, setEdgeTarget] = useState('');
  const [edgeLabel,  setEdgeLabel]  = useState('');

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-gray-700 uppercase tracking-wide">{node.type}</span>
        <button onClick={() => onRemove(node.id)} className="text-xs text-red-500 hover:underline">删除</button>
      </div>

      {node.type === 'send_message' && (
        <div>
          <label className="text-xs text-gray-500 mb-1 block">消息文本</label>
          <textarea
            value={(node.data.text as string) ?? ''}
            onChange={(e) => onChange(node.id, 'text', e.target.value)}
            rows={4}
            className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5 resize-none focus:outline-none focus:ring-1 focus:ring-brand-500"
          />
        </div>
      )}

      {node.type === 'collect_input' && (
        <>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">变量名</label>
            <input
              value={(node.data.variable as string) ?? ''}
              onChange={(e) => onChange(node.id, 'variable', e.target.value)}
              placeholder="例如：user_name"
              className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none"
            />
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">超时时间（秒）</label>
            <input
              type="number"
              value={(node.data.timeout_seconds as number) ?? ''}
              onChange={(e) => onChange(node.id, 'timeout_seconds', Number(e.target.value))}
              className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none"
            />
          </div>
        </>
      )}

      {node.type === 'condition' && (
        <>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">变量</label>
            <input
              value={(node.data.variable as string) ?? ''}
              onChange={(e) => onChange(node.id, 'variable', e.target.value)}
              className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none"
            />
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">运算符</label>
            <select
              value={(node.data.operator as string) ?? 'eq'}
              onChange={(e) => onChange(node.id, 'operator', e.target.value)}
              className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white focus:outline-none"
            >
              <option value="eq">=（等于）</option>
              <option value="neq">≠（不等于）</option>
              <option value="contains">包含</option>
              <option value="gte">≥</option>
              <option value="lte">≤</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">值</label>
            <input
              value={(node.data.value as string) ?? ''}
              onChange={(e) => onChange(node.id, 'value', e.target.value)}
              className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none"
            />
          </div>
        </>
      )}

      {node.type === 'set_variable' && (
        <>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">变量</label>
            <input value={(node.data.variable as string) ?? ''} onChange={(e) => onChange(node.id, 'variable', e.target.value)} className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none" />
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">值</label>
            <input value={(node.data.value as string) ?? ''} onChange={(e) => onChange(node.id, 'value', e.target.value)} className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none" />
          </div>
        </>
      )}

      {node.type === 'handoff' && (
        <div>
          <label className="text-xs text-gray-500 mb-1 block">转接提示语</label>
          <textarea
            value={(node.data.handoff_message as string) ?? ''}
            onChange={(e) => onChange(node.id, 'handoff_message', e.target.value)}
            rows={3}
            className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5 resize-none focus:outline-none"
          />
        </div>
      )}

      {/* Edge connector */}
      <div className="border-t border-gray-100 pt-3">
        <p className="text-xs font-medium text-gray-500 mb-2">连接到</p>
        <select
          value={edgeTarget}
          onChange={(e) => setEdgeTarget(e.target.value)}
          className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white focus:outline-none mb-1"
        >
          <option value="">选择目标节点</option>
          {nodes.filter((n) => n.id !== node.id).map((n) => (
            <option key={n.id} value={n.id}>{nodeLabel(n)}</option>
          ))}
        </select>
        {node.type === 'condition' && (
          <input
            value={edgeLabel}
            onChange={(e) => setEdgeLabel(e.target.value)}
            placeholder="分支标签（true / false）"
            className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none mb-1"
          />
        )}
        <button
          disabled={!edgeTarget}
          onClick={() => { onAddEdge(node.id, edgeTarget, edgeLabel || undefined); setEdgeTarget(''); setEdgeLabel(''); }}
          className="w-full text-xs bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg py-1.5 transition disabled:opacity-40"
        >
          添加连接
        </button>
      </div>
    </div>
  );
}
