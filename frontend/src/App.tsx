import { useEffect } from 'react';
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

function AppShell() {
  const { user, logout } = useAuthStore();

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Narrow sidebar nav */}
      <nav className="w-14 bg-gray-900 flex flex-col items-center py-3 gap-1 shrink-0">
        <div className="text-white font-black text-lg mb-3">O</div>
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            title={item.label}
            className={({ isActive }) =>
              `w-10 h-10 rounded-lg flex items-center justify-center text-lg transition ${
                isActive ? 'bg-brand-600' : 'hover:bg-gray-700'
              }`
            }
          >
            {item.icon}
          </NavLink>
        ))}

        {/* Spacer */}
        <div className="flex-1" />

        <button
          onClick={logout}
          title={`退出登录 (${user?.name})`}
          className="w-10 h-10 rounded-lg flex items-center justify-center text-gray-400 hover:bg-gray-700 hover:text-white transition text-sm"
        >
          ⎋
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
