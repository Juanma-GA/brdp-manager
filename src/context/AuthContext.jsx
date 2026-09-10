import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import {
  authFetchJson,
  configureAuth,
  getStoredRefreshToken,
  refreshAccessToken,
  storeRefreshToken,
} from '../services/apiClient';

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
  // instead of just "the route exists". Goes through the shared
  // refreshAccessToken() (apiClient.js) rather than its own fetch: React 18
  // StrictMode double-invokes this effect in dev, and refresh tokens
  // rotate on use, so two independent calls racing on the same stored
  // token would have the second one legitimately rejected as already
  // revoked -- logging out a session that was never actually invalid.
  useEffect(() => {
    let cancelled = false;
    async function restore() {
      const refreshToken = getStoredRefreshToken();
      if (!refreshToken) {
        setIsLoading(false);
        return;
      }
      try {
        const refreshed = await refreshAccessToken();
        if (!refreshed) throw new Error('refresh failed');
        if (cancelled) return;
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

  // Lets a component that just PATCHed /api/auth/me (SettingsPage's own
  // Display Name edit) hand back the fresh User it already got in the
  // response, without a redundant extra GET -- every other piece of UI
  // reading `user` (e.g. the Header) picks up the change immediately since
  // it's the same context value.
  const updateUser = useCallback((updatedUser) => {
    setUser(updatedUser);
  }, []);

  const value = {
    user,
    accessToken,
    isAuthenticated: !!user,
    isLoading,
    login,
    logout,
    updateUser,
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
