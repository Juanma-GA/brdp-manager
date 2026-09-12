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
// valid session out.
//
// Two distinct races, two distinct guards, both needed:
//  1. Same page, concurrent callers (StrictMode's double-mount; authFetch's
//     401 handler racing AuthContext's restore-on-mount) -- guarded by
//     caching the in-flight promise so they all await the SAME network
//     call instead of each firing their own.
//  2. Different browser tabs of the same origin, each with their own JS
//     module state (so the in-flight promise above can't see across
//     tabs), sharing the one thing that IS cross-tab: localStorage. If tab
//     B's request loses the race, tab A has by then already written the
//     new refresh token to localStorage -- so before giving up, re-read it
//     and retry once with whatever is actually stored now, instead of
//     assuming a 401 here always means the session itself is dead.
let refreshPromise = null;

async function doRefresh(refreshToken) {
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
}

export async function refreshAccessToken() {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const refreshToken = getStoredRefreshToken();
    if (!refreshToken) return false;

    if (await doRefresh(refreshToken)) return true;

    // Failed -- but another tab may have rotated the token out from under
    // us between our read and our request. Only worth retrying if the
    // stored value actually moved; if it's unchanged, the 401 is real.
    const currentToken = getStoredRefreshToken();
    if (currentToken && currentToken !== refreshToken) {
      return doRefresh(currentToken);
    }
    return false;
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
