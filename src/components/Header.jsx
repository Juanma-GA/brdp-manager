import { useTranslation } from 'react-i18next';
import { useAuthContext } from '../context/AuthContext';
import LanguageSwitcher from './LanguageSwitcher';
import styles from './Header.module.css';

/**
 * v2 header: app name + signed-in user + logout. The per-feature action
 * buttons (Generate, AI Extract, BRDP Assistant, BREXdoc) that used to
 * live here moved into the project-scoped pages that actually need them
 * (RecordsPage, GeneratePage) now that navigation is real routes instead
 * of a single global page (docs/v2 §5).
 */
export default function Header() {
  const { t } = useTranslation();
  const { user, logout } = useAuthContext();

  return (
    <header className={styles.header}>
      <div className={styles.container}>
        <h1 className={styles.title}>
          <span>
            <strong>{t('appName')}</strong>
          </span>
        </h1>
        <div className={styles.buttons}>
          <LanguageSwitcher />
          {user && (
            <>
              <span className={styles.userInfo}>
                {user.display_name} · {user.global_role}
              </span>
              <button className={styles.secondaryBtn} onClick={logout}>
                Logout
              </button>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
