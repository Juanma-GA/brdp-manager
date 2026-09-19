import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff } from 'lucide-react';
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
  // Per-field, not a single form-level message -- replaces the native
  // `required` attribute's own per-field browser tooltip (see the i18n fix:
  // that tooltip's language followed the browser/OS locale, not this app's
  // selector), so the replacement needs to keep pointing at the exact
  // field that's empty, not summarize it in one banner at the top.
  const [fieldErrors, setFieldErrors] = useState({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    const errors = { email: !email.trim(), password: !password.trim() };
    setFieldErrors(errors);
    if (errors.email || errors.password) return;
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
          className={`${styles.input} ${fieldErrors.email ? styles.inputError : ''}`}
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            setFieldErrors((f) => ({ ...f, email: false }));
          }}
          autoComplete="username"
        />
        {fieldErrors.email && <p className={styles.fieldError}>{t('validation.required')}</p>}
        <label className={styles.label} htmlFor="login-password">
          {t('login.password')}
        </label>
        <div className={styles.passwordWrapper}>
          <input
            id="login-password"
            type={showPassword ? 'text' : 'password'}
            className={`${styles.input} ${styles.passwordInput} ${fieldErrors.password ? styles.inputError : ''}`}
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setFieldErrors((f) => ({ ...f, password: false }));
            }}
            autoComplete="current-password"
          />
          <button
            type="button"
            className={styles.passwordToggle}
            onClick={() => setShowPassword((v) => !v)}
            aria-label={t(showPassword ? 'password.hide' : 'password.show')}
          >
            {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>
        {fieldErrors.password && <p className={styles.fieldError}>{t('validation.required')}</p>}
        {error && <p className={styles.error}>{error}</p>}
        <button type="submit" className={styles.submit} disabled={isSubmitting}>
          {isSubmitting ? '…' : t('login.submit')}
        </button>
      </form>
    </div>
  );
}
