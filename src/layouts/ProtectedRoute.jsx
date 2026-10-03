import { Navigate, useLocation } from 'react-router-dom';
import { useAuthContext } from '../context/AuthContext';
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
  const { isAuthenticated, isLoading, user } = useAuthContext();
  const location = useLocation();

  if (isLoading) return <div style={{ padding: 24 }}>…</div>;
  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  if (user?.must_change_password) {
    return <ForceChangePasswordPage />;
  }
  return children;
}
