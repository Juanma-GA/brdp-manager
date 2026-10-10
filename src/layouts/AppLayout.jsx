import { useTranslation } from 'react-i18next';
import { useAuthContext } from '../context/AuthContext';
import { Outlet } from 'react-router-dom';
import Header from '../components/Header';
import Sidebar from '../components/Sidebar';

export default function AppLayout() {
  // AACF 3 (HR1): the sidebar's collapsed state is an interface
  // preference stored on the server (users.ui_preferences), so it follows
  // the person to any browser. With nothing stored, today's default:
  // collapsed.
  const { user, saveUiPreference, uiPreferenceSaveFailed, dismissUiPreferenceNotice } = useAuthContext();
  const { t } = useTranslation();
  const stored = user?.ui_preferences?.sidebar_collapsed;
  const sidebarCollapsed = typeof stored === 'boolean' ? stored : true;

  const toggleCollapse = () => {
    saveUiPreference('sidebar_collapsed', !sidebarCollapsed);
  };

  return (
    <div className="appContainer">
      <Header />
      <div className="workspaceRow">
        <Sidebar collapsed={sidebarCollapsed} onToggleCollapse={toggleCollapse} />
        <main className="mainContent">
          {uiPreferenceSaveFailed && (
            <div className="uiPreferenceNotice" role="status" data-testid="ui-preference-save-failed">
              <span>{t('uiPreferences.saveFailed')}</span>
              <button type="button" onClick={dismissUiPreferenceNotice} aria-label={t('uiPreferences.dismiss')}>
                ×
              </button>
            </div>
          )}
          <Outlet />
        </main>
      </div>
    </div>
  );
}
