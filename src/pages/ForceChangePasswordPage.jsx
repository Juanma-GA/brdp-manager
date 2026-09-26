import { useTranslation } from 'react-i18next';
import ChangePasswordForm from '../components/ChangePasswordForm';
import styles from './ForceChangePasswordPage.module.css';

/**
 * ProtectedRoute renders this INSTEAD OF the requested route (no
 * AppLayout/sidebar at all, same as LoginPage) whenever the signed-in
 * user still has must_change_password=True (a fresh Create user or an
 * admin's Reset password, docs request) -- reuses ChangePasswordForm
 * as-is, just with its own heading/explanation swapped in, so there is
 * still only one change-password form in this codebase.
 */
export default function ForceChangePasswordPage() {
  const { t } = useTranslation();
  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <ChangePasswordForm
          title={t('forcePasswordChange.title')}
          description={t('forcePasswordChange.description')}
        />
      </div>
    </div>
  );
}
