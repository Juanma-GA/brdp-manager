import { Navigate, useLocation } from 'react-router-dom';
import { useAuthContext } from '../context/AuthContext';

/**
 * Gate for every authenticated route. `isLoading` covers the initial
 * silent-refresh attempt (AuthContext) -- without waiting for it, a
 * genuinely logged-in user gets bounced to /login on every F5 before the
 * refresh has a chance to complete.
 */
export default function ProtectedRoute({ children }) {
  const { isAuthenticated, isLoading } = useAuthContext();
  const location = useLocation();

  if (isLoading) return <div style={{ padding: 24 }}>…</div>;
  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return children;
}
