import { usePresenceStore } from '../../stores/usePresenceStore';

const STATUS_STYLE: Record<string, string> = {
  online: 'bg-green-500',
  busy:   'bg-yellow-500',
  away:   'bg-gray-400',
};

const STATUS_LABEL: Record<string, string> = {
  online: '在线',
  busy:   '忙碌',
  away:   '离开',
};

export default function PresenceSidebar() {
  const agents = usePresenceStore((s) => Object.values(s.agents));

  return (
    <div className="w-56 border-l border-gray-200 bg-white flex flex-col shrink-0 overflow-hidden">
      <div className="px-3 py-2 border-b border-gray-100">
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">在线客服</h3>
      </div>

      <div className="flex-1 overflow-y-auto">
        {agents.length === 0 ? (
          <p className="text-xs text-gray-400 px-3 py-4">暂无在线客服</p>
        ) : (
          agents.map((agent) => (
            <div key={agent.agentId} className="flex items-center gap-2 px-3 py-2 hover:bg-gray-50">
              <span
                className={`w-2 h-2 rounded-full shrink-0 ${STATUS_STYLE[agent.status] ?? 'bg-gray-300'}`}
                title={STATUS_LABEL[agent.status] ?? agent.status}
              />
              <div className="min-w-0">
                <p className="text-xs font-medium text-gray-700 truncate">{agent.name ?? agent.agentId}</p>
                <p className="text-[11px] text-gray-400">{agent.workload ?? 0} 个会话</p>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
