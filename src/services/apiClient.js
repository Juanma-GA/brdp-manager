/**
 * Central fetch wrapper for the v2 FastAPI backend. Injects the current
 * access token, and on a 401 tries exactly one silent refresh (via the
 * HttpOnly refresh_token cookie the browser sends automatically) before
 * giving the caller the original 401 -- never retries more than once, to
 * avoid looping forever against a genuinely-expired session.
 *
 * AuthContext registers its token getters/setters here at mount via
 * configureAuth() instead of importing AuthContext directly, so plain
 * modules (llmAPI.js, api/*.js) can call authFetch() without depending on
 * React context.
 */

let getAccessToken = () => null;
let setAccessToken = () => {};
let onSessionExpired = () => {};

export function configureAuth({ getAccessToken: get, setAccessToken: set, onSessionExpired: onExpired }) {
  getAccessToken = get;
  setAccessToken = set;
  onSessionExpired = onExpired;
}

// The refresh token itself is no longer readable from JS at all -- the
// backend sets it as an HttpOnly cookie (Set-Cookie on login/refresh,
// cleared via Set-Cookie on logout), scoped to path=/api/auth. Every fetch
// below needs credentials: 'include' so the browser actually attaches and
// receives it.
//
// This also retires the old cross-tab race workaround: refresh tokens
// rotate on use, so two callers racing on the same stored localStorage
// value used to need a manual re-read-and-retry after a 401 (otherwise the
// loser of the race got logged out even though the session was still
// valid). Cookies are shared natively by the browser across tabs, so a
// plain retry with credentials: 'include' now picks up whatever
// refresh_token cookie is currently valid -- no bookkeeping needed. The
// refreshPromise cache below still matters on its own: it keeps concurrent
// callers on the SAME page (React 18 StrictMode's double-mount, or
// authFetch's 401 handler racing AuthContext's restore-on-mount) from
// firing independent /refresh requests that would race each other.
let refreshPromise = null;

async function doRefresh() {
  const res = await fetch('/api/auth/refresh', {
    method: 'POST',
    credentials: 'include',
  });
  if (!res.ok) return false;

  const data = await res.json();
  setAccessToken(data.access_token);
  return true;
}

export async function refreshAccessToken() {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    if (await doRefresh()) return true;

    // Refresh tokens rotate on use, so two tabs (or React 18 StrictMode's
    // double-mounted restore effect within one tab) racing on the same
    // cookie value can have the loser's first attempt see an
    // already-rotated, now-revoked token and fail. One retry is enough:
    // by the time this second request goes out, the browser's cookie jar
    // already holds whichever value won the race (cookie updates from the
    // winner's response land in the shared jar immediately, before this
    // retry is dispatched) -- no need to inspect or compare values, since
    // the cookie isn't readable from JS in the first place.
    return doRefresh();
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

  let response = await fetch(path, { ...options, headers, credentials: 'include' });

  if (response.status === 401) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      const retryHeaders = { ...(options.headers || {}), Authorization: `Bearer ${getAccessToken()}` };
      response = await fetch(path, { ...options, headers: retryHeaders, credentials: 'include' });
    }
  }

  if (response.status === 401) {
    setAccessToken(null);
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
