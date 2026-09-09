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

async function refreshAccessToken() {
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
