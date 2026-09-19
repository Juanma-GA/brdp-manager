import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import i18n from '../i18n';
import { authFetchJson, configureAuth, refreshAccessToken } from '../services/apiClient';

const AuthContext = createContext();

// The one place a User's preferred_language turns into the actual active
// UI language (docs request: server-side account setting, not
// localStorage) -- called from both places this app ever learns who the
// current user is: the mount-time silent-refresh restore below, and
// login(). NULL (no preference chosen yet -- a pre-migration account, or
// one that just hasn't touched the language switcher) intentionally
// falls back to the same 'en' i18n/index.js already boots with, so this
// is a no-op for that case rather than a second competing default.
function applyPreferredLanguage(me) {
  if (me?.preferred_language) {
    i18n.changeLanguage(me.preferred_language);
  }
}

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
    setAccessToken(null);
    setUser(null);
    try {
      // The refresh_token cookie travels with this request on its own
      // (credentials: 'include') -- the backend reads it, revokes it, and
      // clears it via Set-Cookie. No body needed any more.
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
      });
    } catch {
      // Best-effort revocation -- the client-side session is already gone
      // either way (access token cleared above).
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

  // On mount, try to restore a session from the refresh_token cookie --
  // this is what makes "refresh (F5) keeps you logged in" actually true,
  // instead of just "the route exists". There's no readable client-side
  // value any more to check first (the cookie is HttpOnly), so this always
  // attempts the refresh and lets the backend say yes or no. Goes through
  // the shared refreshAccessToken() (apiClient.js) rather than its own
  // fetch: React 18 StrictMode double-invokes this effect in dev, and
  // refresh tokens rotate on use, so two independent calls racing on the
  // same cookie would have the second one legitimately rejected as already
  // revoked -- logging out a session that was never actually invalid.
  // refreshAccessToken() caches the in-flight promise so both callers
  // await the same network call instead of each firing their own.
  useEffect(() => {
    let cancelled = false;
    async function restore() {
      try {
        const refreshed = await refreshAccessToken();
        if (!refreshed) throw new Error('refresh failed');
        if (cancelled) return;
        const me = await authFetchJson('/api/auth/me');
        if (!cancelled) {
          setUser(me);
          applyPreferredLanguage(me);
        }
      } catch {
        if (!cancelled) {
          setAccessToken(null);
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
      const me = await authFetchJson('/api/auth/me');
      setUser(me);
      applyPreferredLanguage(me);
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
    applyPreferredLanguage(updatedUser);
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
