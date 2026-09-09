import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { authFetchJson, configureAuth, getStoredRefreshToken, storeRefreshToken } from '../services/apiClient';

const AuthContext = createContext();

export function AuthProvider({ children }) {
  const [accessToken, setAccessTokenState] = useState(null);
  const [user, setUser] = useState(null);
  // null = still resolving the initial silent-refresh attempt; the router
  // must not redirect to /login until this settles, or a real logged-in
  // user gets bounced on every page reload before the refresh completes.
  const [isLoading, setIsLoading] = useState(true);
  const accessTokenRef = useRef(null);

  const setAccessToken = useCallback((token) => {
    accessTokenRef.current = token;
    setAccessTokenState(token);
  }, []);

  const logout = useCallback(async () => {
    const refreshToken = getStoredRefreshToken();
    setAccessToken(null);
    storeRefreshToken(null);
    setUser(null);
    if (refreshToken) {
      try {
        await fetch('/api/auth/logout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: refreshToken }),
        });
      } catch {
        // Best-effort revocation -- the client-side session is already gone
        // either way (tokens cleared above).
      }
    }
  }, [setAccessToken]);

  useEffect(() => {
    configureAuth({
      getAccessToken: () => accessTokenRef.current,
      setAccessToken,
      onSessionExpired: () => {
        setUser(null);
      },
    });
  }, [setAccessToken]);

  // On mount, try to restore a session from the stored refresh token --
  // this is what makes "refresh (F5) keeps you logged in" actually true,
  // instead of just "the route exists".
  useEffect(() => {
    let cancelled = false;
    async function restore() {
      const refreshToken = getStoredRefreshToken();
      if (!refreshToken) {
        setIsLoading(false);
        return;
      }
      try {
        const res = await fetch('/api/auth/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: refreshToken }),
        });
        if (!res.ok) throw new Error('refresh failed');
        const data = await res.json();
        if (cancelled) return;
        setAccessToken(data.access_token);
        storeRefreshToken(data.refresh_token);
        const me = await authFetchJson('/api/auth/me');
        if (!cancelled) setUser(me);
      } catch {
        if (!cancelled) {
          setAccessToken(null);
          storeRefreshToken(null);
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    restore();
    return () => {
      cancelled = true;
    };
  }, [setAccessToken]);

  const login = useCallback(
    async (email, password) => {
      const data = await authFetchJson('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      setAccessToken(data.access_token);
      storeRefreshToken(data.refresh_token);
      const me = await authFetchJson('/api/auth/me');
      setUser(me);
      return me;
    },
    [setAccessToken]
  );

  const value = {
    user,
    accessToken,
    isAuthenticated: !!user,
    isLoading,
    login,
    logout,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuthContext() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuthContext must be used within AuthProvider');
  }
  return context;
}
