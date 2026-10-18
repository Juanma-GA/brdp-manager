import { useTranslation } from 'react-i18next';
import { useAuthContext } from '../context/AuthContext';
import { authFetchJson } from '../services/apiClient';
import styles from './LanguageSwitcher.module.css';

// Language is a server-side account setting (docs request: Opción B, not
// localStorage) -- same PATCH /api/auth/me + updateUser pattern
// ProfileSection already uses for display_name (no separate hook exists
// to extract/reuse here, so this mirrors that exact inline call rather
// than inventing a new abstraction for one more field on the same
// endpoint). i18n.changeLanguage() is called directly here too, for
// immediate UI feedback before the PATCH round trip resolves --
// AuthContext's updateUser() re-applies it again from the server's own
// confirmed response, a harmless no-op unless the two ever disagree.
export default function LanguageSwitcher() {
  const { t, i18n } = useTranslation();
  const { updateUser } = useAuthContext();

  const handleChange = async (lng) => {
    i18n.changeLanguage(lng);
    try {
      const updated = await authFetchJson('/api/auth/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferred_language: lng }),
      });
      updateUser(updated);
    } catch {
      // Best-effort persistence -- the UI already reflects the chosen
      // language for this session either way; a failed PATCH just means
      // it won't follow the account to another login until retried.
    }
  };

  return (
    <label className={styles.wrapper}>
      <span className={styles.label}>{t('language')}</span>
      <select
        className={styles.select}
        value={i18n.language}
        onChange={(e) => handleChange(e.target.value)}
        aria-label={t('language')}
      >
        <option value="en">EN</option>
        <option value="es">ES</option>
      </select>
    </label>
  );
}
