import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './TemporaryPasswordModal.module.css';

/**
 * Shown exactly once, right after Create user or admin Reset password
 * (docs request) -- the temporary password never appears anywhere else
 * again after this modal closes; the backend never stores it in
 * plaintext, so there is nowhere to look it up later either.
 */
export default function TemporaryPasswordModal({ email, temporaryPassword, onClose }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(temporaryPassword);
      setCopied(true);
    } catch {
      // Clipboard API unavailable (e.g. an insecure context) -- the value
      // is still shown in plain text and selectable by hand either way.
    }
  };

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <h3 className={styles.title}>{t('settings.userManagement.tempPassword.title')}</h3>
        <p className={styles.warningText}>
          {t('settings.userManagement.tempPassword.onlyShownOnce', { email })}
        </p>
        <div className={styles.passwordRow}>
          <code className={styles.passwordValue}>{temporaryPassword}</code>
          <button type="button" className={styles.copyButton} onClick={handleCopy}>
            {copied ? t('settings.userManagement.tempPassword.copied') : t('settings.userManagement.tempPassword.copy')}
          </button>
        </div>
        <button type="button" className={styles.closeButton} onClick={onClose}>
          {t('settings.userManagement.tempPassword.close')}
        </button>
      </div>
    </div>
  );
}
