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

function RequireAuth({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

const NAV_ITEMS = [
  { to: '/inbox',      icon: '💬', label: '收件箱' },
  { to: '/bot-flows',  icon: '🤖', label: '机器人' },
  { to: '/broadcast',  icon: '📢', label: '群发' },
  { to: '/analytics',  icon: '📊', label: '分析' },
];

const SIDEBAR_COLLAPSED_KEY = 'omniclick-sidebar-collapsed';

function AppShell() {
  const { user, logout } = useAuthStore();

  // Sidebar state persists across reloads
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true'; } catch { return false; }
  });

  useEffect(() => {
    try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed)); } catch { /* private mode */ }
  }, [collapsed]);

  const itemClass = (isActive: boolean) =>
    `h-10 rounded-lg flex items-center text-sm transition ${
      collapsed ? 'w-10 mx-auto justify-center text-lg' : 'w-full px-3 gap-3'
    } ${isActive ? 'bg-brand-600 text-white' : 'text-gray-300 hover:bg-gray-700 hover:text-white'}`;

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar nav — collapsible (icon rail ⇄ expanded with labels) */}
      <nav
        aria-expanded={!collapsed}
        className={`${collapsed ? 'w-14 items-center' : 'w-48 items-stretch px-2'} bg-gray-900 flex flex-col py-3 gap-1 shrink-0 transition-all duration-200`}
      >
        {/* Brand */}
        <div className={`text-white font-black mb-3 h-8 flex items-center ${collapsed ? 'text-lg justify-center' : 'text-base px-1 gap-2'}`}>
          <span className={collapsed ? '' : 'w-6 h-6 rounded bg-brand-600 flex items-center justify-center text-sm shrink-0'}>O</span>
          {!collapsed && <span className="truncate">OmniClick</span>}
        </div>

        {NAV_ITEMS.map((item) => (
          <NavLink key={item.to} to={item.to} title={item.label} className={({ isActive }) => itemClass(isActive)}>
            <span className="text-lg shrink-0">{item.icon}</span>
            {!collapsed && <span className="truncate">{item.label}</span>}
          </NavLink>
        ))}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Collapse toggle */}
        <button
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? '展开菜单' : '收起菜单'}
          className={`h-9 rounded-lg flex items-center text-sm text-gray-400 hover:bg-gray-700 hover:text-white transition ${
            collapsed ? 'w-10 mx-auto justify-center text-base' : 'w-full px-3 gap-3'
          }`}
        >
          <span className="text-base shrink-0">{collapsed ? '»' : '«'}</span>
          {!collapsed && <span className="truncate">收起菜单</span>}
        </button>

        <button
          onClick={logout}
          title={`退出登录 (${user?.name})`}
          className={`h-10 rounded-lg flex items-center text-sm text-gray-400 hover:bg-gray-700 hover:text-white transition ${
            collapsed ? 'w-10 mx-auto justify-center' : 'w-full px-3 gap-3'
          }`}
        >
          <span className="text-lg shrink-0">⎋</span>
          {!collapsed && <span className="truncate">退出 ({user?.name})</span>}
        </button>
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
          <Route path="/inbox"      element={<InboxPage />} />
          <Route path="/bot-flows"  element={<BotFlowListPage />} />
          <Route path="/bot-flows/:id" element={<BotFlowEditorPage />} />
          <Route path="/broadcast"  element={<BroadcastPage />} />
          <Route path="/analytics"  element={<AnalyticsPage />} />
        </Route>

        <Route path="*" element={<Navigate to="/inbox" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
