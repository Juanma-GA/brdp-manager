import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuthContext } from '../context/AuthContext';
import { authFetchJson, getStoredRefreshToken } from '../services/apiClient';
import Button from './Button';
import styles from './ChangePasswordForm.module.css';

// Must match backend/app/core/security.py's MIN_PASSWORD_LENGTH -- there's
// no shared-across-runtimes constant to import, so this client-side
// pre-check (saves a round trip for the common case) is a separate copy;
// the backend's own check is what actually enforces the policy.
const MIN_PASSWORD_LENGTH = 8;

/**
 * Shared between Settings > Profile (a subsection under the existing
 * Display Name form, `withDivider`) and the force-change-password gate a
 * fresh Create user/admin Reset password account hits right after login
 * (docs request: reuse this exact form, don't build a second one --
 * `title`/`description` let that screen override the heading/explanation
 * text without duplicating the fields/submit/validation logic below).
 *
 * Always clears the caller's own `must_change_password` flag locally via
 * AuthContext after a successful change, regardless of which context
 * rendered it -- harmless no-op when it was already false (the Settings
 * case), and exactly what lifts ProtectedRoute's gate in the forced case.
 */
export default function ChangePasswordForm({ withDivider = false, title, description }) {
  const { t } = useTranslation();
  const { user, updateUser } = useAuthContext();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setError(t('settings.profile.changePassword.tooShort', { count: MIN_PASSWORD_LENGTH }));
      return;
    }
    if (newPassword !== confirmPassword) {
      setError(t('settings.profile.changePassword.mismatch'));
      return;
    }
    setSaving(true);
    try {
      await authFetchJson('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          current_password: currentPassword,
          new_password: newPassword,
          current_refresh_token: getStoredRefreshToken(),
        }),
      });
      // Same no-separate-success-message pattern as the Display Name form
      // -- clearing the fields is the visible confirmation.
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      if (user?.must_change_password) {
        updateUser({ ...user, must_change_password: false });
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {withDivider && <div className={styles.divider} />}
      <h4 className={styles.subsectionTitle}>{title ?? t('settings.profile.changePassword.title')}</h4>
      <p className={styles.fieldDescription}>
        {description ?? t('settings.profile.changePassword.sessionsWarning')}
      </p>
      <form onSubmit={handleSubmit}>
        <div className={styles.formGroup}>
          <label className={styles.label}>{t('settings.profile.changePassword.current')}</label>
          <input
            className={styles.input}
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
          />
        </div>
        <div className={styles.formGroup}>
          <label className={styles.label}>{t('settings.profile.changePassword.new')}</label>
          <input
            className={styles.input}
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
          />
        </div>
        <div className={styles.formGroup}>
          <label className={styles.label}>{t('settings.profile.changePassword.confirm')}</label>
          <input
            className={styles.input}
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
          />
        </div>
        {error && <p className={styles.statusInvalid}>{error}</p>}
        <Button type="submit" disabled={saving}>
          {saving ? t('settings.profile.changePassword.saving') : t('settings.profile.changePassword.save')}
        </Button>
      </form>
    </>
  );
}
