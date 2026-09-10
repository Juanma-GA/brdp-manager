import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuthContext } from '../context/AuthContext';
import styles from './LoginPage.module.css';

export default function LoginPage() {
  const { t } = useTranslation();
  const { login } = useAuthContext();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    // Not the native `required` attribute -- its browser tooltip follows
    // the browser/OS locale, not this app's own language selector (a real
    // i18n bug, confirmed by forcing the OS locale to es-ES independent of
    // the app's language setting and observing the tooltip text change).
    if (!email.trim() || !password.trim()) {
      setError(t('validation.required'));
      return;
    }
    setIsSubmitting(true);
    try {
      await login(email, password);
      const from = location.state?.from || '/projects';
      navigate(from, { replace: true });
    } catch {
      setError(t('login.error'));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className={styles.page}>
      <form className={styles.card} onSubmit={handleSubmit}>
        <h1 className={styles.title}>{t('login.title')}</h1>
        <label className={styles.label} htmlFor="login-email">
          {t('login.email')}
        </label>
        <input
          id="login-email"
          type="email"
          className={styles.input}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="username"
        />
        <label className={styles.label} htmlFor="login-password">
          {t('login.password')}
        </label>
        <input
          id="login-password"
          type="password"
          className={styles.input}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
        />
        {error && <p className={styles.error}>{error}</p>}
        <button type="submit" className={styles.submit} disabled={isSubmitting}>
          {isSubmitting ? '…' : t('login.submit')}
        </button>
      </form>
    </div>
  );
}
