import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import Header from '../components/Header';
import Sidebar from '../components/Sidebar';

export default function AppLayout() {
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
