/**
 * Central fetch wrapper for the v2 FastAPI backend. Injects the current
 * access token, and on a 401 tries exactly one silent refresh (via the
 * stored refresh token) before giving the caller the original 401 --
 * never retries more than once, to avoid looping forever against a
 * genuinely-expired session.
 *
 * AuthContext registers its token getters/setters here at mount via
 * configureAuth() instead of importing AuthContext directly, so plain
 * modules (llmAPI.js, api/*.js) can call authFetch() without depending on
 * React context.
 */

const REFRESH_TOKEN_KEY = 'brdp_v2_refresh_token';

let getAccessToken = () => null;
let setAccessToken = () => {};
let onSessionExpired = () => {};

export function configureAuth({ getAccessToken: get, setAccessToken: set, onSessionExpired: onExpired }) {
  getAccessToken = get;
  setAccessToken = set;
  onSessionExpired = onExpired;
}

export function getStoredRefreshToken() {
  try {
    return localStorage.getItem(REFRESH_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function storeRefreshToken(token) {
  try {
    if (token) {
      localStorage.setItem(REFRESH_TOKEN_KEY, token);
    } else {
      localStorage.removeItem(REFRESH_TOKEN_KEY);
    }
  } catch {
    // localStorage unavailable (private browsing, etc.) -- session just
    // won't survive a reload, not a functional blocker.
  }
}

// Refresh tokens rotate on use (backend/app/api/routes/auth.py: the old one
// is revoked the instant a new pair is issued), so two callers racing with
// the SAME stored refresh token is a real failure mode, not a hypothetical
// one -- React 18 StrictMode double-invokes AuthContext's mount effect in
// dev, and this exact race was caught live: the first request rotates the
// token and succeeds, the second (still holding the now-revoked token)
// gets a genuine 401 from the backend and would otherwise log a perfectly
// valid session out. Every caller (authFetch's 401 handler, AuthContext's
// restore-on-mount) must go through this single in-flight promise instead
// of each firing its own request.
let refreshPromise = null;

export async function refreshAccessToken() {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const refreshToken = getStoredRefreshToken();
    if (!refreshToken) return false;

    const res = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (!res.ok) return false;

    const data = await res.json();
    setAccessToken(data.access_token);
    storeRefreshToken(data.refresh_token);
    return true;
  })();

  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

export async function authFetch(path, options = {}) {
  const token = getAccessToken();
  const headers = { ...(options.headers || {}) };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  let response = await fetch(path, { ...options, headers });

  if (response.status === 401 && getStoredRefreshToken()) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      const retryHeaders = { ...(options.headers || {}), Authorization: `Bearer ${getAccessToken()}` };
      response = await fetch(path, { ...options, headers: retryHeaders });
    }
  }

  if (response.status === 401) {
    setAccessToken(null);
    storeRefreshToken(null);
    onSessionExpired();
  }

  return response;
}

export async function authFetchJson(path, options = {}) {
  const response = await authFetch(path, options);
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body = await response.json();
      detail = body.detail || detail;
    } catch {
      // response body wasn't JSON -- keep statusText
    }
    const error = new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
    error.status = response.status;
    throw error;
  }
  if (response.status === 204) return null;
  return response.json();
}
