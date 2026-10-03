import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import Header from '../components/Header';
import Sidebar from '../components/Sidebar';

export default function AppLayout() {
  // HR1 (AACF: no localStorage/sessionStorage as authoritative state --
  // Postgres is truth) has one deliberate, explicitly-agreed exception:
  // this. Decided directly with the user (see the language-preference
  // round, which moved TO the server specifically so it would NOT be
  // this kind of exception) -- sidebarCollapsed stays in localStorage
  // because it is a per-device/per-screen display preference, not
  // business data: it carries no meaning about the account, the data, or
  // who's allowed to see what, and losing or desyncing it across devices
  // has zero security or correctness implication (worst case, the
  // sidebar opens the "wrong" width on a new device until re-toggled).
  // preferred_language is the contrasting case that IS treated as HR1
  // data -- it is account identity/preference that must follow the user
  // everywhere, so it lives in Postgres (users.preferred_language) via
  // AuthContext instead.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    const saved = localStorage.getItem('sidebarCollapsed');
    return saved === null ? true : saved === 'true';
  });

  const toggleCollapse = () => {
    setSidebarCollapsed((c) => {
      const next = !c;
      localStorage.setItem('sidebarCollapsed', next.toString());
      return next;
    });
  };

  return (
    <div className="appContainer">
      <Header />
      <div className="workspaceRow">
        <Sidebar collapsed={sidebarCollapsed} onToggleCollapse={toggleCollapse} />
        <main className="mainContent">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
