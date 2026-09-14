import { useEffect, useState } from 'react';
import { BrowserRouter, NavLink, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { useAuthStore } from './stores/useAuthStore';
import LoginPage from './pages/LoginPage';
import InboxPage from './pages/InboxPage';
import BotFlowListPage from './pages/bot/BotFlowListPage';
import BotFlowEditorPage from './pages/bot/BotFlowEditorPage';
import BroadcastPage from './pages/broadcast/BroadcastPage';
import AnalyticsPage from './pages/analytics/AnalyticsPage';
import ChannelsPage from './pages/settings/ChannelsPage';
import CompanySettingsPage from './pages/settings/CompanySettingsPage';
import AgentsSettingsPage from './pages/settings/AgentsSettingsPage';
import MetaAppsPage from './pages/settings/MetaAppsPage';
import AiConfigPage from './pages/settings/AiConfigPage';
import VoiceAgentsPage from './pages/settings/VoiceAgentsPage';
import SystemDashboardPage from './pages/system/SystemDashboardPage';
import SystemCompaniesPage from './pages/system/SystemCompaniesPage';
import SystemUsersPage from './pages/system/SystemUsersPage';
import ContactsPage from './pages/contacts/ContactsPage';
import AgentChatPage from './pages/agent/AgentChatPage';

function RequireAuth({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function AgentOnly({ children }: { children: React.ReactNode }) {
  const role = useAuthStore((s) => s.user?.role);
  if (role !== 'agent') return <Navigate to="/inbox" replace />;
  return <>{children}</>;
}

interface NavItem {
  to?: string;
  icon: string;
  label: string;
  children?: NavItem[];
}

const NAV_ITEMS: NavItem[] = [
  { to: '/inbox', icon: '💬', label: '收件箱' },
  { to: '/bot-flows', icon: '🤖', label: '机器人' },
  { to: '/broadcast', icon: '📢', label: '群发' },
  { to: '/voice-agents', icon: '☎️', label: '智能外呼' },
  { to: '/analytics', icon: '📊', label: '分析' },
  { icon: '⚙️', label: '设置', children: [
    { to: '/channels', icon: '📱', label: '渠道' },
    { to: '/settings/meta-apps', icon: '🔑', label: 'Meta 应用' },
    { to: '/settings/ai', icon: '✨', label: 'AI 配置' },
    { to: '/settings/company', icon: '🏢', label: '公司' },
    { to: '/settings/agents', icon: '👥', label: '客服' },
  ]},
];

function AppShell() {
  const { user, logout } = useAuthStore();
  const [expanded, setExpanded] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const isSuperAdmin = user?.role === 'super_admin';

  const navItems: NavItem[] = isSuperAdmin
    ? [
        { to: '/inbox', icon: '💬', label: '收件箱' },
        { to: '/agent', icon: '🎧', label: '客服聊天' },
        { to: '/bot-flows', icon: '🤖', label: '机器人' },
        { to: '/broadcast', icon: '📢', label: '群发' },
        { to: '/voice-agents', icon: '☎️', label: '智能外呼' },
        { to: '/contacts', icon: '👥', label: '联系人' },
        { to: '/analytics', icon: '📊', label: '分析' },
        { to: '/system', icon: '🔧', label: '系统管理' },
        { icon: '⚙️', label: '设置', children: [
          { to: '/channels', icon: '📱', label: '渠道' },
          { to: '/settings/meta-apps', icon: '🔑', label: 'Meta 应用' },
          { to: '/settings/ai', icon: '✨', label: 'AI 配置' },
          { to: '/settings/company', icon: '🏢', label: '公司' },
          { to: '/settings/agents', icon: '👥', label: '客服' },
        ]},
      ]
    : [
        { to: '/inbox', icon: '💬', label: '收件箱' },
        { to: '/bot-flows', icon: '🤖', label: '机器人' },
        { to: '/broadcast', icon: '📢', label: '群发' },
        { to: '/voice-agents', icon: '☎️', label: '智能外呼' },
        { to: '/analytics', icon: '📊', label: '分析' },
        { icon: '⚙️', label: '设置', children: [
          { to: '/channels', icon: '📱', label: '渠道' },
          { to: '/settings/meta-apps', icon: '🔑', label: 'Meta 应用' },
          { to: '/settings/ai', icon: '✨', label: 'AI 配置' },
          { to: '/settings/company', icon: '🏢', label: '公司' },
          { to: '/settings/agents', icon: '👥', label: '客服' },
        ]},
      ];

  const renderNavItem = (item: NavItem, isChild = false) => {
    if (item.to) {
      return (
        <NavLink
          key={item.to}
          to={item.to}
          title={item.label}
          className={({ isActive }) =>
            `flex items-center gap-2 px-2 rounded-lg transition ${
              isActive ? 'bg-brand-600 text-white' : 'text-gray-300 hover:bg-gray-700 hover:text-white'
            } ${isChild ? 'text-sm py-1.5' : 'py-2'}`
          }
        >
          <span className="text-lg">{item.icon}</span>
          {expanded && <span>{item.label}</span>}
        </NavLink>
      );
    }

    return (
      <div
        key={item.label}
        onClick={() => item.children && setSettingsOpen(!settingsOpen)}
        className={`flex items-center gap-2 px-2 rounded-lg transition cursor-pointer text-gray-400 hover:text-white hover:bg-gray-700 ${isChild ? 'text-sm py-1.5' : 'py-2'}`}
      >
        <span className="text-lg">{item.icon}</span>
        {expanded && <span>{item.label}</span>}
        {item.children && expanded && (
          <span className="ml-auto text-xs">{settingsOpen ? '▼' : '▶'}</span>
        )}
      </div>
    );
  };

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar — hover 展开，悬停时显示完整菜单与子菜单 */}
      <nav
        aria-expanded={expanded}
        className="bg-gray-900 flex flex-col py-3 shrink-0 transition-all duration-200"
        style={{ width: expanded ? '200px' : '56px' }}
        onMouseEnter={() => setExpanded(true)}
        onMouseLeave={() => { setExpanded(false); setSettingsOpen(false); }}
      >
        <div className={`px-3 mb-3 font-black text-white text-xl transition-opacity ${expanded ? 'opacity-100' : 'opacity-0'}`}>
          红浪漫会所
        </div>
        {!expanded && <div className="w-10 h-10 mx-auto mb-3 bg-brand-600 rounded-lg flex items-center justify-center text-white font-bold">O</div>}

        <div className="flex-1 flex flex-col gap-1 px-2 overflow-y-auto">
          {navItems.map((item) => (
            <div key={item.label}>
              {item.children ? (
                <>
                  {renderNavItem(item)}
                  {settingsOpen && expanded && item.children && (
                    <div className="ml-4 mt-1 space-y-1 border-l border-gray-700 pl-2">
                      {item.children.map(child => renderNavItem(child, true))}
                    </div>
                  )}
                </>
              ) : (
                renderNavItem(item)
              )}
            </div>
          ))}
        </div>

        {/* 用户信息与退出 */}
        <div className="px-2 mt-2 border-t border-gray-800 pt-2">
          {expanded ? (
            <div className="px-2 py-2 flex items-center gap-2 text-gray-400">
              <div className="w-8 h-8 rounded-full bg-gray-700 flex items-center justify-center text-sm">
                {user?.name?.charAt(0) || 'U'}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm text-white truncate">{user?.name}</div>
                <div className="text-xs truncate">{user?.email}</div>
              </div>
              <button
                onClick={logout}
                className="p-1 hover:bg-gray-700 rounded text-gray-400 hover:text-white"
                title="退出登录"
              >
                ⎋
              </button>
            </div>
          ) : (
            <button
              onClick={logout}
              title={`退出登录 (${user?.name})`}
              className="w-10 h-10 rounded-lg flex items-center justify-center text-gray-400 hover:bg-gray-700 hover:text-white transition"
            >
              ⎋
            </button>
          )}
        </div>
      </nav>

      {/* Page content */}
      <div className="flex-1 overflow-hidden">
        <Outlet />
      </div>
    </div>
  );
}

export default function App() {
  const hydrate = useAuthStore((s) => s.hydrate);

  useEffect(() => { hydrate(); }, []);

  return (
    <BrowserRouter>
      <Toaster position="top-right" />
      <Routes>
        <Route path="/login" element={<LoginPage />} />

        <Route
          element={
            <RequireAuth>
              <AppShell />
            </RequireAuth>
          }
        >
          <Route path="/inbox"            element={<InboxPage />} />
          <Route path="/bot-flows"        element={<BotFlowListPage />} />
          <Route path="/bot-flows/:id"    element={<BotFlowEditorPage />} />
          <Route path="/broadcast"         element={<BroadcastPage />} />
          <Route path="/analytics"         element={<AnalyticsPage />} />
          <Route path="/channels"          element={<ChannelsPage />} />
          <Route path="/settings/meta-apps" element={<MetaAppsPage />} />
          <Route path="/settings/ai"       element={<AiConfigPage />} />
          <Route path="/voice-agents"     element={<VoiceAgentsPage />} />
          <Route path="/contacts"         element={<ContactsPage />} />
          <Route path="/settings/company"  element={<CompanySettingsPage />} />
          <Route path="/settings/agents"   element={<AgentsSettingsPage />} />
          <Route path="/system"           element={<SystemDashboardPage />} />
          <Route path="/system/companies" element={<SystemCompaniesPage />} />
          <Route path="/system/users"     element={<SystemUsersPage />} />
        </Route>

        <Route path="*" element={<Navigate to="/inbox" replace />} />
      </Routes>

      {/* Standalone pages — no AppShell sidebar */}
      <Routes>
        <Route path="/agent" element={
          <RequireAuth><AgentOnly><AgentChatPage /></AgentOnly></RequireAuth>
        } />
      </Routes>
    </BrowserRouter>
  );
}
