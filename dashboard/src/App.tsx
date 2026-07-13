import React, { useState, useEffect } from 'react';
import { hasToken, clearToken } from './api';
import LoginPage from './pages/LoginPage';
import StatsPage from './pages/StatsPage';
import MemoriesPage from './pages/MemoriesPage';
import MemoryDetail from './pages/MemoryDetail';
import GraphPage from './pages/GraphPage';
import ValidationPage from './pages/ValidationPage';
import AuditPage from './pages/AuditPage';
import UsersPage from './pages/UsersPage';

// ---- Route types ----
type RouteKey = '' | 'memories' | 'graph' | 'validation' | 'audit' | 'memory-detail' | 'users';

function parseHash(): { route: RouteKey; param?: string } {
  const raw = window.location.hash.replace(/^#\/?/, '');
  if (raw.startsWith('memory/')) {
    return { route: 'memory-detail', param: raw.slice('memory/'.length) };
  }
  if (['', 'memories', 'graph', 'validation', 'audit', 'users'].includes(raw)) {
    return { route: raw as RouteKey };
  }
  return { route: '' };
}

function setHash(route: RouteKey, param?: string) {
  if (route === 'memory-detail' && param) {
    window.location.hash = `#memory/${param}`;
  } else {
    window.location.hash = route ? `#${route}` : '#';
  }
}

// ---- Nav item ----
interface NavItemProps {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
}

function NavItem({ label, icon, active, onClick }: NavItemProps) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium transition
        ${active
          ? 'bg-indigo-600/30 text-indigo-300 border border-indigo-700/50'
          : 'text-gray-400 hover:text-gray-200 hover:bg-gray-700/50'
        }`}
    >
      <span className="shrink-0 w-5 h-5">{icon}</span>
      <span>{label}</span>
    </button>
  );
}

// ---- Icons (inline SVG) ----
const Icons = {
  Stats: (
    <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round"
        d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
    </svg>
  ),
  Memories: (
    <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round"
        d="M4 6h16M4 10h16M4 14h16M4 18h16" />
    </svg>
  ),
  Graph: (
    <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <circle cx="5" cy="12" r="2" />
      <circle cx="19" cy="5" r="2" />
      <circle cx="19" cy="19" r="2" />
      <line x1="7" y1="11" x2="17" y2="6" />
      <line x1="7" y1="13" x2="17" y2="18" />
    </svg>
  ),
  Validation: (
    <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round"
        d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  ),
  Audit: (
    <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round"
        d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
    </svg>
  ),
  Logout: (
    <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round"
        d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
    </svg>
  ),
  Menu: (
    <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  ),
  Close: (
    <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
    </svg>
  ),
  Users: (
    <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round"
        d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  ),
};

// ---- Main App ----
export default function App() {
  const [{ route, param }, setRouteState] = useState(() => parseHash());
  const [authenticated, setAuthenticated] = useState(hasToken);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    function onHashChange() {
      setRouteState(parseHash());
    }
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  function navigate(r: RouteKey, p?: string) {
    setHash(r, p);
    setRouteState({ route: r, param: p });
    setSidebarOpen(false);
  }

  function handleLogin() {
    setAuthenticated(true);
    navigate('');
  }

  function handleLogout() {
    clearToken();
    setAuthenticated(false);
    navigate('');
  }

  // Always show login if not authenticated
  if (!authenticated) {
    return <LoginPage onLogin={handleLogin} />;
  }

  // Route → component
  let content: React.ReactNode;
  if (route === 'memory-detail' && param) {
    content = (
      <MemoryDetail
        memoryId={param}
        onBack={() => navigate('memories')}
        onNavigate={id => navigate('memory-detail', id)}
      />
    );
  } else if (route === 'memories') {
    content = <MemoriesPage onViewMemory={id => navigate('memory-detail', id)} />;
  } else if (route === 'graph') {
    content = <GraphPage />;
  } else if (route === 'validation') {
    content = <ValidationPage />;
  } else if (route === 'audit') {
    content = <AuditPage />;
  } else if (route === 'users') {
    content = <UsersPage />;
  } else {
    content = <StatsPage />;
  }

  const navItems: { label: string; route: RouteKey; icon: React.ReactNode }[] = [
    { label: 'Stats',      route: '',           icon: Icons.Stats },
    { label: 'Memories',   route: 'memories',   icon: Icons.Memories },
    { label: 'Graph',      route: 'graph',      icon: Icons.Graph },
    { label: 'Validation', route: 'validation', icon: Icons.Validation },
    { label: 'Audit',      route: 'audit',      icon: Icons.Audit },
    { label: 'Users',      route: 'users',      icon: Icons.Users },
  ];

  const activeRoute = route === 'memory-detail' ? 'memories' : route as RouteKey;

  return (
    <div className="min-h-screen bg-gray-900 flex">
      {/* Mobile sidebar backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/60 z-20 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`
          fixed top-0 left-0 h-full z-30 w-64 bg-gray-900 border-r border-gray-800 flex flex-col
          transform transition-transform duration-200 ease-in-out
          ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
          lg:relative lg:translate-x-0 lg:flex
        `}
      >
        {/* Logo */}
        <div className="px-5 py-5 border-b border-gray-800">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center shrink-0">
              <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
              </svg>
            </div>
            <div>
              <p className="text-white font-semibold text-sm leading-tight">Koda Memory</p>
              <p className="text-gray-500 text-xs">Admin Dashboard</p>
            </div>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {navItems.map(item => (
            <NavItem
              key={item.route}
              label={item.label}
              icon={item.icon}
              active={activeRoute === item.route}
              onClick={() => navigate(item.route)}
            />
          ))}
        </nav>

        {/* Logout */}
        <div className="px-3 py-4 border-t border-gray-800">
          <button
            onClick={handleLogout}
            className="w-full flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium
                       text-gray-400 hover:text-red-400 hover:bg-red-900/20 transition"
          >
            <span className="w-5 h-5 shrink-0">{Icons.Logout}</span>
            <span>Sign Out</span>
          </button>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile header */}
        <header className="lg:hidden flex items-center justify-between px-4 py-3 border-b border-gray-800 bg-gray-900">
          <button
            onClick={() => setSidebarOpen(true)}
            className="p-2 text-gray-400 hover:text-gray-200 rounded-lg hover:bg-gray-700 transition"
          >
            <span className="w-5 h-5 block">{Icons.Menu}</span>
          </button>
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded bg-indigo-600 flex items-center justify-center">
              <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
              </svg>
            </div>
            <span className="text-white font-semibold text-sm">Koda Memory</span>
          </div>
          <button
            onClick={handleLogout}
            className="p-2 text-gray-400 hover:text-red-400 rounded-lg hover:bg-gray-700 transition"
            title="Sign out"
          >
            <span className="w-5 h-5 block">{Icons.Logout}</span>
          </button>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-auto p-4 sm:p-6 lg:p-8">
          {content}
        </main>
      </div>
    </div>
  );
}
