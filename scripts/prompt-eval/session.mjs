// Prompt eval (Remates B, Part 3): the backend session of
// scripts/run-prompt-eval.mjs, in its own module so it can be tested
// without logging in on import.
//
// A full pass (93 cases × 3 runs) lasts longer than an access token
// (access_token_expire_minutes = 45): the last cases got 401 and the temp
// projects were left behind. Now every request that gets a 401 logs in
// again ONCE and repeats itself -- the correction round and the Proposal
// check included, since they go through the same client. A case never
// "fails quality" because of a 401: if the session cannot be recovered the
// pass stops with SessionLostError and a clear message.
//
// A 401 on the login itself (wrong credentials) is never retried: it stops
// at once with the reason.
//
//   const client = createEvalClient({ api, email, password, fetchImpl });
//   await client.login();
//   await client.apiFetch(path, options)  -- JSON in, JSON out (204 → null)
//   await client.rawFetch(path, init)     -- any body (FormData), the Response
//   await client.llmProxy(payload)        -- POST /api/llm-proxy, waiting out
//                                            the per-minute limit (below)
//   await cleanupLeftoverProjects(client, { log })
//
// Temp projects are named "Prompt Eval — <standard> — <timestamp>"
// (EVAL_PROJECT_PREFIX).

export const EVAL_PROJECT_PREFIX = "Prompt Eval — ";

export class SessionLostError extends Error {
  constructor(message) {
    super(message);
    this.name = "SessionLostError";
  }
}

// Protecciones 2a: the per-user limit on AI requests. Over the per-minute
// limit the request waits what the server says (retry_after_seconds) and is
// sent again, like the app (src/api/llmRateLimit.js) -- a pass never fails a
// case because of it. Over the per-day limit nothing would work for hours:
// the pass stops with this error, which says the limit and when to retry.
export class LlmLimitError extends SessionLostError {
  constructor(message) {
    super(message);
    this.name = "LlmLimitError";
  }
}

// An unattended pass waits longer than the app before giving up: each wait
// is under 60 s, so this is ~20 minutes for ONE request at most.
export const EVAL_RATE_LIMIT_MAX_WAITS = 20;

export class LoginError extends Error {
  constructor(message) {
    super(message);
    this.name = "LoginError";
  }
}

async function readDetail(res) {
  let detail = res.statusText;
  try {
    const body = await res.json();
    detail = body.detail || detail;
  } catch {
    // not JSON, keep statusText
  }
  return detail;
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A cut connection, not an answer of the backend: Node's fetch says
// "fetch failed" (cause ECONNRESET, UND_ERR_SOCKET, ...) or "other side
// closed" -- typically a keep-alive connection uvicorn had already closed.
// Retried once before it counts as an error.
const SOCKET_CODES = new Set(['ECONNRESET', 'UND_ERR_SOCKET']);
export const SOCKET_RETRY_DELAY_MS = 250;
export function isSocketError(err) {
  if (!err) return false;
  const text = `${err.message || ''} ${err.cause?.message || ''}`;
  if (/fetch failed|other side closed/i.test(text)) return true;
  return SOCKET_CODES.has(err.code) || SOCKET_CODES.has(err.cause?.code);
}

export function createEvalClient({ api, email, password, fetchImpl = fetch, sleepImpl = realSleep, log = console.log }) {
  let accessToken = null;
  let relogins = 0;
  let rateLimitWaits = 0;
  // Set once the session is lost: the pass checks it after every run, since
  // a caller may catch the error (the rule test turns a failed call into its
  // own error state) and the pass must stop all the same.
  let lost = null;
  let socketRetries = 0;

  // One fetch; a socket error is retried once (the second one is thrown).
  async function fetchRetry(url, init) {
    try {
      return await fetchImpl(url, init);
    } catch (err) {
      if (!isSocketError(err)) throw err;
      socketRetries += 1;
      log(`  connection cut (${err.cause?.code || err.message}): retrying once`);
      await sleepImpl(SOCKET_RETRY_DELAY_MS);
      return fetchImpl(url, init);
    }
  }

  async function login() {
    if (!email || !password) {
      throw new LoginError(
        "Missing PROMPT_EVAL_EMAIL / PROMPT_EVAL_PASSWORD environment variables. " +
          "This script never reads credentials from a file -- set both env vars " +
          "(an admin account, since it needs to create/delete projects) before running it."
      );
    }
    let res;
    try {
      res = await fetchRetry(`${api}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
    } catch (err) {
      throw new LoginError(`Cannot reach the backend at ${api} to log in: ${err.message}`);
    }
    if (!res.ok) {
      const detail = await readDetail(res);
      throw new LoginError(
        `Login failed for ${email} (HTTP ${res.status}: ${JSON.stringify(detail)}). ` +
          "Check PROMPT_EVAL_EMAIL / PROMPT_EVAL_PASSWORD (an admin account)."
      );
    }
    accessToken = (await res.json()).access_token;
  }

  // One request; on a 401, log in again once and repeat it. A second 401
  // (or a login that fails then) means the session cannot be recovered.
  async function send(path, init) {
    const attempt = () => {
      const headers = { ...(init.headers || {}) };
      if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
      return fetchRetry(`${api}${path}`, { ...init, headers });
    };
    let res = await attempt();
    if (res.status !== 401) return res;
    try {
      await login();
    } catch (err) {
      lost = new SessionLostError(`The session expired during ${init.method || "GET"} ${path} and logging in again failed: ${err.message}`);
      throw lost;
    }
    relogins += 1;
    res = await attempt();
    if (res.status === 401) {
      lost = new SessionLostError(`${init.method || "GET"} ${path} still answers 401 after logging in again: the session cannot be recovered.`);
      throw lost;
    }
    return res;
  }

  async function apiFetch(path, options = {}) {
    const res = await send(path, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
    if (!res.ok) {
      const detail = await readDetail(res);
      throw new Error(`${options.method || "GET"} ${path} -> ${res.status}: ${JSON.stringify(detail)}`);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  async function rawFetch(path, init = {}) {
    return send(path, init);
  }

  // One chat request through the proxy, as the app sends it.
  async function llmProxy(payload) {
    const init = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ payload }) };
    for (let waits = 0; ; waits += 1) {
      const res = await send("/api/llm-proxy", init);
      if (res.ok) return res.json();
      const detail = await readDetail(res);
      if (res.status === 429 && detail?.code === "llm_rate_limited") {
        const seconds = Math.max(1, Number(detail.retry_after_seconds) || Number(res.headers.get("retry-after")) || 1);
        if (detail.window !== "minute" || waits >= EVAL_RATE_LIMIT_MAX_WAITS) {
          lost = new LlmLimitError(
            `The AI request limit of ${detail.limit} per ${detail.window} was reached; the server allows the next one in ${seconds} s. ` +
              "Raise LLM_CALLS_PER_MINUTE / LLM_CALLS_PER_DAY in backend/.env (0 = no limit) and restart the backend, or run the pass later."
          );
          throw lost;
        }
        rateLimitWaits += 1;
        log(`  waiting ${seconds} s: AI request limit of ${detail.limit} per minute reached`);
        await sleepImpl(seconds * 1000);
        continue;
      }
      throw new Error(`POST /api/llm-proxy -> ${res.status}: ${JSON.stringify(detail)}`);
    }
  }

  return {
    login,
    apiFetch,
    rawFetch,
    llmProxy,
    get relogins() {
      return relogins;
    },
    get rateLimitWaits() {
      return rateLimitWaits;
    },
    get socketRetries() {
      return socketRetries;
    },
    get accessToken() {
      return accessToken;
    },
    get lost() {
      return lost;
    },
  };
}

// --cleanup: the "Prompt Eval — …" projects left by earlier passes that this
// user can delete (projects have no owner; an admin can delete them all),
// deleted for good (permanent=true: they never go to the Trash) and listed.
// Returns { deleted: [names], failed: [{ name, error }] }.
export async function cleanupLeftoverProjects(client, { log = console.log } = {}) {
  const projects = await client.apiFetch("/api/projects");
  const leftovers = projects.filter((p) => p.name.startsWith(EVAL_PROJECT_PREFIX) && p.effective_role === "editor");
  if (leftovers.length === 0) {
    log("No leftover \"Prompt Eval — …\" projects: nothing to delete.");
    return { deleted: [], failed: [] };
  }
  const deleted = [];
  const failed = [];
  for (const p of leftovers) {
    try {
      await client.apiFetch(`/api/projects/${p.id}?permanent=true`, { method: "DELETE" });
      deleted.push(p.name);
      log(`Deleted leftover project: ${p.name}`);
    } catch (err) {
      failed.push({ name: p.name, error: err.message });
      log(`WARNING: could not delete ${p.name}: ${err.message}`);
    }
  }
  log(`Deleted ${deleted.length} leftover project(s)${failed.length ? `, ${failed.length} could not be deleted` : ""}.`);
  return { deleted, failed };
}
