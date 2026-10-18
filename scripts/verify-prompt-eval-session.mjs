// The prompt-eval session against the REAL running backend (moved out of
// scripts/test-prompt-eval-runs.mjs, which runs in `npm run check` and must
// not depend on a backend): a 401 from the real server (an invalid token
// sent once) is recovered by logging in again, and --cleanup deletes a real
// leftover "Prompt Eval — …" project.
//
// Needs the development backend (uvicorn on PROMPT_EVAL_API_URL, default
// http://localhost:8000) and an admin account (PROMPT_EVAL_EMAIL /
// PROMPT_EVAL_PASSWORD, default the dev admin). If the backend is not there,
// or does not accept that account, it says so and exits with 2 -- never a
// failure that looks like a bug of the app.
//
//     node scripts/verify-prompt-eval-session.mjs
import { cleanupLeftoverProjects, createEvalClient, EVAL_PROJECT_PREFIX, LoginError } from "./prompt-eval/session.mjs";

let passed = 0;
let failed = 0;
function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`);
  }
}

const API = process.env.PROMPT_EVAL_API_URL || "http://localhost:8000";
const email = process.env.PROMPT_EVAL_EMAIL || "admin@example.com";
const password = process.env.PROMPT_EVAL_PASSWORD || "AdminTest123!";
const up = await fetch(`${API}/api/auth/login`, { method: "OPTIONS" }).then((r) => r.status < 500, () => false);
if (!up) {
  console.log(`No backend answers at ${API}: start the development backend (or set PROMPT_EVAL_API_URL).`);
  process.exit(2);
}
let spoil = false;
const fetchImpl = (url, init = {}) => {
  if (spoil && init.headers?.Authorization) {
    spoil = false;
    return fetch(url, { ...init, headers: { ...init.headers, Authorization: "Bearer expired" } });
  }
  return fetch(url, init);
};
const client = createEvalClient({ api: API, email, password, fetchImpl });
try {
  await client.login();
} catch (err) {
  if (!(err instanceof LoginError)) throw err;
  console.log(
    `The backend at ${API} does not accept ${email} (${err.message}). It is probably not the development ` +
      "backend, or its admin was never created: set PROMPT_EVAL_EMAIL / PROMPT_EVAL_PASSWORD, or create the " +
      "dev admin (backend/scripts/create_admin_user.py)."
  );
  process.exit(2);
}
const project = await client.apiFetch("/api/projects", {
  method: "POST",
  body: JSON.stringify({ name: `${EVAL_PROJECT_PREFIX}leftover check — ${Date.now()}`, standard: "S1000D 4.2", project_config: {}, seed_from_catalog: false }),
});
spoil = true;
const listed = await client.apiFetch("/api/projects");
check("real backend: a real 401 is recovered by logging in again", Array.isArray(listed) && client.relogins === 1);
const logged = [];
const out = await cleanupLeftoverProjects(client, { log: (l) => logged.push(l) });
check("real backend: --cleanup deletes the leftover", out.deleted.includes(project.name), JSON.stringify(out));
const after = await client.apiFetch("/api/projects");
check("real backend: it is gone (not in the Trash list either)", !after.some((p) => p.id === project.id));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
