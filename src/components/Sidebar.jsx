import styles from './Sidebar.module.css';

/**
 * Sidebar component with navigation
 * Displays navigation buttons for different pages
 * @param {Object} props - Component props
 * @param {string} props.currentPage - Currently active page
 * @param {Function} props.onNavigate - Callback when navigation button is clicked
 * @param {boolean} props.collapsed - Whether the sidebar is collapsed to icon-only width
 * @param {Function} props.onToggleCollapse - Callback to toggle collapsed state
 * @returns {JSX.Element} Sidebar element with navigation buttons
 */
export default function Sidebar({ currentPage, onNavigate, collapsed, onToggleCollapse }) {
  return (
    <aside className={`${styles.sidebar} ${collapsed ? styles.collapsed : ''}`}>
      <button
        className={styles.collapseToggle}
        onClick={onToggleCollapse}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        ☰
      </button>

      {!collapsed && <div className={styles.sectionLabel}>Navigation</div>}
      <nav className={styles.nav}>
        <button
          onClick={() => onNavigate('brdp')}
          className={`${styles.navItem} ${currentPage === 'brdp' ? styles.active : ''}`}
          title={collapsed ? 'BRDP Records' : undefined}
        >
          <span className={styles.navIcon}>📋</span>
          {!collapsed && <span className={styles.navLabel}>BRDP Records</span>}
        </button>
        <button
          onClick={() => onNavigate('settings')}
          className={`${styles.navItem} ${currentPage === 'settings' ? styles.active : ''}`}
          title={collapsed ? 'Settings' : undefined}
        >
          <span className={styles.navIcon}>⚙️</span>
          {!collapsed && <span className={styles.navLabel}>Settings</span>}
        </button>
      </nav>

      <div className={styles.footer}>
        <div>
          <span className={styles.footerIcon}>ℹ️</span>
          {!collapsed && 'BRDP Manager v1.0'}
        </div>
      </div>
    </aside>
  );
}
