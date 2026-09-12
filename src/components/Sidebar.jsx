import { NavLink, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useProjectContext } from '../context/ProjectContext';
import styles from './Sidebar.module.css';

/**
 * v2 sidebar: BRDP Projects / Settings at the top level, and -- only while
 * inside a project route (projectId present in the URL) -- the project's
 * own sub-nav (Config/Records/Generate), matching the mockup. Real
 * <NavLink>s, not onClick+setState, so the active route drives the
 * highlighted item and the URL is always the source of truth (docs/v2 §5:
 * "la app real necesita URLs de verdad").
 */
export default function Sidebar({ collapsed, onToggleCollapse }) {
  const { t } = useTranslation();
  const { projectId } = useParams();
  const { projects } = useProjectContext();
  const activeProject = projects.find((p) => p.id === projectId);

  const navItemClass = ({ isActive }) => `${styles.navItem} ${isActive ? styles.active : ''}`;

  return (
    <aside className={`${styles.sidebar} ${collapsed ? styles.collapsed : ''}`}>
      <button
        className={styles.collapseToggle}
        onClick={onToggleCollapse}
        aria-label={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
        title={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
      >
        ☰
      </button>

      {!collapsed && <div className={styles.sectionLabel}>{t('sidebar.navigation')}</div>}
      <nav className={styles.nav}>
        <NavLink to="/projects" className={navItemClass} title={collapsed ? t('nav.projects') : undefined}>
          <span className={styles.navIcon}>📋</span>
          {!collapsed && <span className={styles.navLabel}>{t('nav.projects')}</span>}
        </NavLink>
        <NavLink to="/settings" className={navItemClass} title={collapsed ? t('nav.settings') : undefined}>
          <span className={styles.navIcon}>⚙️</span>
          {!collapsed && <span className={styles.navLabel}>{t('nav.settings')}</span>}
        </NavLink>
      </nav>

      {projectId && activeProject && (
        <>
          <div className={styles.divider} />
          {!collapsed && (
            <>
              <NavLink to="/projects" className={styles.backLink}>
                ← {t('nav.allProjects')}
              </NavLink>
              <div className={styles.projectName}>{activeProject.name}</div>
              <div className={styles.projectStandard}>{activeProject.standard}</div>
            </>
          )}
          <nav className={styles.nav}>
            <NavLink to={`/projects/${projectId}/config`} className={navItemClass} title={collapsed ? t('nav.config') : undefined}>
              <span className={styles.navIcon}>📑</span>
              {!collapsed && <span className={styles.navLabel}>{t('nav.config')}</span>}
            </NavLink>
            <NavLink to={`/projects/${projectId}/records`} className={navItemClass} title={collapsed ? t('nav.records') : undefined}>
              <span className={styles.navIcon}>📄</span>
              {!collapsed && <span className={styles.navLabel}>{t('nav.records')}</span>}
            </NavLink>
            <NavLink to={`/projects/${projectId}/generate`} className={navItemClass} title={collapsed ? t('nav.generate') : undefined}>
              <span className={styles.navIcon}>🧬</span>
              {!collapsed && <span className={styles.navLabel}>{t('nav.generate')}</span>}
            </NavLink>
          </nav>
        </>
      )}

      <div className={styles.footer}>
        <div>
          <span className={styles.footerIcon}>ℹ️</span>
          {!collapsed && t('sidebar.footer')}
        </div>
      </div>
    </aside>
  );
}
