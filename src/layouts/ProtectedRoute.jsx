import { Navigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuthContext } from '../context/AuthContext';
import ErrorNotice from '../components/ErrorNotice';
import ForceChangePasswordPage from '../pages/ForceChangePasswordPage';

/**
 * Gate for every authenticated route. `isLoading` covers the initial
 * silent-refresh attempt (AuthContext) -- without waiting for it, a
 * genuinely logged-in user gets bounced to /login on every F5 before the
 * refresh has a chance to complete.
 *
 * must_change_password (docs request: Create user/admin Reset password
 * both set it) renders the forced screen INSTEAD of `children` -- since
 * every route in the app goes through this same component, that alone
 * blocks navigation to anything else, with no per-route special-casing
 * and no sidebar/header rendered around it (children here is normally
 * <AppLayout/>, so this branch replaces the entire app shell, same as
 * the !isAuthenticated branch above it).
 */
export default function ProtectedRoute({ children }) {
  const { isAuthenticated, isLoading, user, connectionError, retryRestore } = useAuthContext();
  const location = useLocation();
  const { t } = useTranslation();

  if (isLoading) return <div style={{ padding: 24 }}>…</div>;
  // AACF 2, Part 1: the server did not answer, so whether there is a
  // session is unknown -- never /login, the URL stays, and Retry restores
  // the session in place (the same page renders once it answers).
  if (connectionError) {
    return (
      <div style={{ padding: 24, maxWidth: 640 }} data-testid="connection-error-screen">
        <h1 style={{ fontSize: 20, margin: '0 0 12px' }}>{t('auth.connectionTitle')}</h1>
        <ErrorNotice message={t('auth.connectionFailed')} onRetry={retryRestore} testId="connection-error" />
      </div>
    );
  }
  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  if (user?.must_change_password) {
    return <ForceChangePasswordPage />;
  }
  return children;
}
