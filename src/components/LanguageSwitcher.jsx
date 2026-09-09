import { useTranslation } from 'react-i18next';
import { setLanguage } from '../i18n';
import styles from './LanguageSwitcher.module.css';

export default function LanguageSwitcher() {
  const { t, i18n } = useTranslation();
  return (
    <label className={styles.wrapper}>
      <span className={styles.label}>{t('language')}</span>
      <select
        className={styles.select}
        value={i18n.language}
        onChange={(e) => setLanguage(e.target.value)}
        aria-label={t('language')}
      >
        <option value="en">EN</option>
        <option value="es">ES</option>
      </select>
    </label>
  );
}
