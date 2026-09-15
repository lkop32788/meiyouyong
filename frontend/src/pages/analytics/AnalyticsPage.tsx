import { useEffect, useState } from 'react';
import api from '../../lib/api';

type Tab = 'overview' | 'volume' | 'agents' | 'channel' | 'sla';

interface Overview {
  total_conversations: number;
  avg_first_response: number | null;
  avg_resolution: number | null;
  sla_compliance_pct: number | null;
  csat_avg: number | null;
  bot_containment_pct: number | null;
}

interface SLABreach {
  conversation_id: string;
  last_message_preview: string;
  age_seconds: number;
  threshold_seconds: number;
  agent_name: string | null;
}

interface AgentRow {
  agent_id: string;
  name: string;
  conversations_handled: number;
  avg_first_response_seconds: number | null;
  avg_resolution_seconds: number | null;
  avg_csat_score: number | null;
  online_seconds: number;
}

function fmt(seconds: number | null): string {
  if (seconds == null) return '—';
  if (seconds < 60) return `${Math.round(seconds)} 秒`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟`;
  return `${Math.floor(seconds / 3600)} 小时 ${Math.round((seconds % 3600) / 60)} 分`;
}

const DATE_RANGES = [
  { label: '今天', days: 0 },
  { label: '7 天', days: 7 },
  { label: '30 天', days: 30 },
];

export default function AnalyticsPage() {
  const [tab, setTab]           = useState<Tab>('overview');
  const [rangeDays, setRange]   = useState(7);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [volumeTrend, setVolumeTrend] = useState<Array<{ date: string; total: number; avg_first_response: number | null }>>([]);
  const [agents, setAgents]     = useState<AgentRow[]>([]);
  const [channels, setChannels] = useState<Array<{ channel_type: string; total: number; sla_pct: number | null }>>([]);
  const [breaches, setBreaches] = useState<SLABreach[]>([]);
  const [heatmap, setHeatmap]   = useState<[number, number, number][]>([]);
  const [loading, setLoading]   = useState(false);
  const [failed, setFailed]     = useState<string[]>([]);

  const dateFrom = rangeDays === 0
    ? new Date().toISOString().slice(0, 10)
    : new Date(Date.now() - rangeDays * 86400000).toISOString().slice(0, 10);
  const dateTo = new Date().toISOString().slice(0, 10);

  useEffect(() => {
    setLoading(true);
    const params = `?date_from=${dateFrom}&date_to=${dateTo}`;

    // allSettled, not all: a single failing endpoint used to reject the whole
    // batch, so none of the six setters ran and every tab rendered blank with
    // no hint as to which call broke.
    Promise.allSettled([
      api.get(`/analytics/overview${params}`),
      api.get(`/analytics/volume-trend${params}`),
      api.get(`/analytics/channel-breakdown${params}`),
      api.get(`/analytics/agent-performance?date=${dateTo}`),
      api.get(`/analytics/sla-breaches`),
      api.get(`/analytics/hourly-heatmap?weeks=4`),
    ]).then(([ov, vt, ch, ag, sl, hm]) => {
      const broken: string[] = [];

      if (ov.status === 'fulfilled') setOverview(ov.value.data);     else broken.push('总览');
      if (vt.status === 'fulfilled') setVolumeTrend(vt.value.data);  else broken.push('话务量');
      if (ch.status === 'fulfilled') setChannels(ch.value.data);     else broken.push('渠道分布');
      if (ag.status === 'fulfilled') setAgents(ag.value.data);       else broken.push('客服绩效');
      if (sl.status === 'fulfilled') setBreaches(sl.value.data);     else broken.push('SLA');
      if (hm.status === 'fulfilled') setHeatmap(hm.value.data);      else broken.push('热力图');

      setFailed(broken);
    }).finally(() => setLoading(false));
  }, [rangeDays]);

  const maxVol = Math.max(...heatmap.map(([,,v]) => v), 1);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between shrink-0">
        <h1 className="text-lg font-bold text-gray-900">数据分析</h1>
        <div className="flex gap-1">
          {DATE_RANGES.map((r) => (
            <button
              key={r.days}
              onClick={() => setRange(r.days)}
              className={`text-xs px-3 py-1.5 rounded-lg transition ${rangeDays === r.days ? 'bg-brand-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tabs */}
      <div className="bg-white border-b border-gray-200 px-6 flex gap-1 shrink-0">
        {(['overview', 'volume', 'agents', 'channel', 'sla'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`text-sm px-4 py-2.5 border-b-2 transition ${tab === t ? 'border-brand-600 text-brand-600 font-medium' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
          >
            {t === 'overview' ? '总览' : t === 'volume' ? '话务量' : t === 'agents' ? '客服绩效' : t === 'channel' ? '渠道' : 'SLA'}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-6 bg-gray-50">
        {!loading && failed.length > 0 && (
          <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
            以下数据加载失败，其余部分仍可查看：{failed.join('、')}
          </div>
        )}

        {loading && <p className="text-sm text-gray-400 text-center mt-8">加载数据中...</p>}

        {!loading && tab === 'overview' && overview && (
          <div className="space-y-6">
            {/* KPI Cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {[
                { label: '会话总数', value: overview.total_conversations?.toLocaleString() ?? '—', sub: '个会话' },
                { label: '平均首次响应', value: fmt(overview.avg_first_response), sub: '平均耗时' },
                { label: 'SLA 达标率', value: overview.sla_compliance_pct != null ? `${overview.sla_compliance_pct.toFixed(1)}%` : '—', sub: '合规率' },
                { label: '满意度 (CSAT)', value: overview.csat_avg != null ? overview.csat_avg.toFixed(1) : '—', sub: '满分 5 分' },
              ].map((kpi) => (
                <div key={kpi.label} className="bg-white rounded-xl border border-gray-200 p-4">
                  <p className="text-2xl font-bold text-gray-900">{kpi.value}</p>
                  <p className="text-sm text-gray-600 mt-0.5">{kpi.label}</p>
                  <p className="text-xs text-gray-400">{kpi.sub}</p>
                </div>
              ))}
            </div>

            {/* Heatmap */}
            <div className="bg-white rounded-xl border border-gray-200 p-4">
              <h3 className="text-sm font-semibold text-gray-700 mb-3">繁忙时段热力图（最近 4 周）</h3>
              <div className="overflow-x-auto">
                <div className="flex gap-0.5 text-[10px] text-gray-400 mb-1 ml-6">
                  {Array.from({ length: 24 }, (_, i) => (
                    <div key={i} className="w-5 text-center">{i}</div>
                  ))}
                </div>
                {['周日', '周一', '周二', '周三', '周四', '周五', '周六'].map((day, d) => (
                  <div key={day} className="flex items-center gap-0.5 mb-0.5">
                    <span className="text-[10px] text-gray-400 w-6 text-right mr-0.5">{day}</span>
                    {Array.from({ length: 24 }, (_, h) => {
                      const cell = heatmap.find(([cd, ch]) => cd === d && ch === h);
                      const vol  = cell ? cell[2] : 0;
                      const intensity = Math.round((vol / maxVol) * 100);
                      return (
                        <div
                          key={h}
                          title={`${day} ${h}:00 — ${vol} 个会话`}
                          className="w-5 h-5 rounded-sm transition"
                          style={{ backgroundColor: vol === 0 ? '#f3f4f6' : `rgba(37,99,235,${intensity / 100 * 0.85 + 0.05})` }}
                        />
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {!loading && tab === 'volume' && (
          <div className="bg-white rounded-xl border border-gray-200 p-4">
            <h3 className="text-sm font-semibold text-gray-700 mb-4">每日会话量</h3>
            {volumeTrend.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-8">暂无数据</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="border-b border-gray-100">
                  <tr className="text-left text-gray-500 text-xs">
                    <th className="py-2 font-medium">日期</th>
                    <th className="py-2 font-medium">总数</th>
                    <th className="py-2 font-medium">平均首次响应</th>
                    <th className="py-2 font-medium">SLA 达标</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {volumeTrend.map((row) => (
                    <tr key={row.date}>
                      <td className="py-2 text-gray-900">{row.date}</td>
                      <td className="py-2 font-medium">{row.total}</td>
                      <td className="py-2 text-gray-500">{fmt(row.avg_first_response)}</td>
                      <td className="py-2 text-gray-500">{(row as never as { met_sla_count: number }).met_sla_count ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {!loading && tab === 'agents' && (
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-700">客服绩效 — {dateTo}</h3>
              <button
                onClick={async () => {
                  await api.post('/analytics/export', { type: 'agents', date_from: dateFrom, date_to: dateTo });
                  alert('导出任务已提交，请稍后刷新页面查看。');
                }}
                className="text-xs text-brand-600 hover:underline"
              >
                导出 CSV
              </button>
            </div>
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr className="text-left text-gray-500 text-xs">
                  <th className="px-4 py-3 font-medium">客服</th>
                  <th className="px-4 py-3 font-medium">处理量</th>
                  <th className="px-4 py-3 font-medium">平均响应</th>
                  <th className="px-4 py-3 font-medium">平均解决</th>
                  <th className="px-4 py-3 font-medium">满意度</th>
                  <th className="px-4 py-3 font-medium">在线时长</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {agents.length === 0 ? (
                  <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400 text-sm">暂无数据</td></tr>
                ) : agents.map((ag) => (
                  <tr key={ag.agent_id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium text-gray-900">{ag.name}</td>
                    <td className="px-4 py-3">{ag.conversations_handled}</td>
                    <td className="px-4 py-3 text-gray-500">{fmt(ag.avg_first_response_seconds)}</td>
                    <td className="px-4 py-3 text-gray-500">{fmt(ag.avg_resolution_seconds)}</td>
                    <td className="px-4 py-3">
                      {ag.avg_csat_score != null ? (
                        <span className="font-medium text-amber-600">{ag.avg_csat_score.toFixed(1)}</span>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-3 text-gray-500">{fmt(ag.online_seconds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!loading && tab === 'channel' && (
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100">
              <h3 className="text-sm font-semibold text-gray-700">渠道分布</h3>
            </div>
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr className="text-left text-gray-500 text-xs">
                  <th className="px-4 py-3 font-medium">渠道</th>
                  <th className="px-4 py-3 font-medium">总数</th>
                  <th className="px-4 py-3 font-medium">平均首次响应</th>
                  <th className="px-4 py-3 font-medium">SLA 达标率</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {channels.length === 0 ? (
                  <tr><td colSpan={4} className="px-4 py-8 text-center text-gray-400 text-sm">暂无数据</td></tr>
                ) : channels.map((ch) => (
                  <tr key={ch.channel_type} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium text-gray-900 capitalize">{ch.channel_type}</td>
                    <td className="px-4 py-3">{ch.total}</td>
                    <td className="px-4 py-3 text-gray-500">{fmt((ch as never as { avg_first_response: number }).avg_first_response)}</td>
                    <td className="px-4 py-3">
                      {ch.sla_pct != null ? `${ch.sla_pct.toFixed(1)}%` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!loading && tab === 'sla' && (
          <div className="space-y-4">
            <div className={`rounded-xl border p-4 flex items-center gap-3 ${breaches.length > 0 ? 'bg-red-50 border-red-200' : 'bg-green-50 border-green-200'}`}>
              <span className="text-2xl">{breaches.length > 0 ? '🔴' : '✅'}</span>
              <div>
                <p className={`font-semibold ${breaches.length > 0 ? 'text-red-700' : 'text-green-700'}`}>
                  {breaches.length > 0
                    ? `${breaches.length} 个会话正在超出 SLA 时限`
                    : '所有会话均在 SLA 时限内'}
                </p>
                <p className="text-xs text-gray-500 mt-0.5">实时更新</p>
              </div>
            </div>

            {breaches.length > 0 && (
              <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr className="text-left text-gray-500 text-xs">
                      <th className="px-4 py-3 font-medium">会话</th>
                      <th className="px-4 py-3 font-medium">已等待</th>
                      <th className="px-4 py-3 font-medium">SLA 时限</th>
                      <th className="px-4 py-3 font-medium">客服</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {breaches.map((b) => (
                      <tr key={b.conversation_id} className="hover:bg-gray-50">
                        <td className="px-4 py-3 text-gray-700 max-w-[200px] truncate">{b.last_message_preview || '（无消息）'}</td>
                        <td className="px-4 py-3 font-medium text-red-600">{fmt(b.age_seconds)}</td>
                        <td className="px-4 py-3 text-gray-500">{fmt(b.threshold_seconds)}</td>
                        <td className="px-4 py-3 text-gray-500">{b.agent_name ?? '未分配'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
