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

export function createEvalClient({ api, email, password, fetchImpl = fetch }) {
  let accessToken = null;
  let relogins = 0;
  // Set once the session is lost: the pass checks it after every run, since
  // a caller may catch the error (the rule test turns a failed call into its
  // own error state) and the pass must stop all the same.
  let lost = null;

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
      res = await fetchImpl(`${api}/api/auth/login`, {
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
      return fetchImpl(`${api}${path}`, { ...init, headers });
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

  return {
    login,
    apiFetch,
    rawFetch,
    get relogins() {
      return relogins;
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
