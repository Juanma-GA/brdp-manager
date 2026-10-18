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
  // AACF 2, Part 1: a restore the server could not answer (no network, or
  // a 5xx -- the backend down behind the proxy) is not "no session": the
  // app shows "could not connect" with Retry (ProtectedRoute), keeps the
  // URL, and never sends the person to /login. Only the server saying
  // there is no session (refresh false, /me 401) does that. No automatic
  // retry loop: Retry is the person's choice.
  const [connectionError, setConnectionError] = useState(false);
  const [restoreToken, setRestoreToken] = useState(0);
  const retryRestore = useCallback(() => {
    setConnectionError(false);
    setIsLoading(true);
    setRestoreToken((n) => n + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function restore() {
      try {
        const refreshed = await refreshAccessToken();
        if (!refreshed) {
          if (!cancelled) setAccessToken(null);
          return;
        }
        if (cancelled) return;
        const me = await authFetchJson('/api/auth/me');
        if (!cancelled) {
          setUser(me);
          applyPreferredLanguage(me);
        }
      } catch (err) {
        if (cancelled) return;
        if (err?.network || (typeof err?.status === 'number' && err.status >= 500)) {
          setConnectionError(true);
        } else {
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
  }, [setAccessToken, restoreToken]);

  const login = useCallback(
    async (email, password) => {
      const data = await authFetchJson('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      setAccessToken(data.access_token);
      const me = await authFetchJson('/api/auth/me');
      setConnectionError(false);
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

  // AACF 3 (HR1): interface preferences (sidebar collapsed, Records panel
  // width) live in users.ui_preferences on the server and follow the person
  // to any browser. Optimistic: the value applies at once; the PATCH sends
  // only the changed key and the server merges it with the rest (two tabs
  // never overwrite each other). null removes the key (back to the
  // default). If saving fails the value still holds for this session and a
  // discreet, non-blocking notice is shown once (uiPreferenceSaveFailed).
  const [uiPreferenceSaveFailed, setUiPreferenceSaveFailed] = useState(false);
  const preferenceFailureShownRef = useRef(false);
  const saveUiPreference = useCallback(async (key, value) => {
    setUser((current) => {
      if (!current) return current;
      const next = { ...(current.ui_preferences || {}) };
      if (value === null) delete next[key];
      else next[key] = value;
      return { ...current, ui_preferences: next };
    });
    try {
      await authFetchJson('/api/auth/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ui_preferences: { [key]: value } }),
      });
    } catch {
      if (!preferenceFailureShownRef.current) {
        preferenceFailureShownRef.current = true;
        setUiPreferenceSaveFailed(true);
      }
    }
  }, []);
  const dismissUiPreferenceNotice = useCallback(() => setUiPreferenceSaveFailed(false), []);

  const value = {
    user,
    accessToken,
    isAuthenticated: !!user,
    isLoading,
    connectionError,
    retryRestore,
    login,
    logout,
    updateUser,
    saveUiPreference,
    uiPreferenceSaveFailed,
    dismissUiPreferenceNotice,
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
