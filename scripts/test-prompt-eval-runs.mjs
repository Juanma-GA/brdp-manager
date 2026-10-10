// Tests for the saved prompt-eval runs (C3, Part 2): scripts/prompt-eval/runs.mjs
// (save, list, import baseline-<commit>/, choose the reference) and the
// comparator without directories (scripts/compare-prompt-eval.mjs: the
// latest run vs the previous run of another commit, --against <commit>).
// Works on temporary directories with the two example reports of
// scripts/prompt-eval/compare-fixtures/ (commits aaaaaaa and bbbbbbb, the
// second with one regression). Plain Node:
//
//     node scripts/test-prompt-eval-runs.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compareRunDirs, main as compareMain, pickSavedRuns } from "./compare-prompt-eval.mjs";
import {
  appendComparison,
  importBaselines,
  latestRun,
  latestRunOfCommit,
  listRuns,
  previousRunOfOtherCommit,
  runDirName,
  runStamp,
  saveRun,
} from "./prompt-eval/runs.mjs";
import { cleanupLeftoverProjects, createEvalClient, EVAL_PROJECT_PREFIX, LoginError, SessionLostError } from "./prompt-eval/session.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "prompt-eval", "compare-fixtures");

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

// A report dir as run-prompt-eval.mjs leaves it: responses.json (from a
// fixture, with the header rewritten) + report.md.
function reportDir(root, fixture, header) {
  const dir = fs.mkdtempSync(path.join(root, "report-"));
  const data = JSON.parse(fs.readFileSync(path.join(FIXTURES, fixture, "responses.json"), "utf8"));
  data.header = { ...data.header, ...header };
  fs.writeFileSync(path.join(dir, "responses.json"), JSON.stringify(data));
  fs.writeFileSync(path.join(dir, "report.md"), `# report ${header.commit}\n`);
  return dir;
}
function save(root, runsDir, fixture, header) {
  return saveRun({ reportDir: reportDir(root, fixture, header), commit: header.commit, generatedAt: header.generatedAt, runsDir });
}
// Runs compareMain, capturing what it prints.
function runCompare(argv, dirs) {
  const out = [];
  const err = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = console.error;
  process.stdout.write = (chunk) => {
    out.push(String(chunk));
    return true;
  };
  console.error = (...a) => err.push(a.join(" "));
  try {
    const code = compareMain(argv, dirs);
    return { code, out: out.join(""), err: err.join("\n") };
  } finally {
    process.stdout.write = origOut;
    console.error = origErr;
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-eval-runs-"));
try {
  console.log("runStamp / runDirName");
  check("UTC stamp", runStamp("2026-09-29T11:21:05.123Z") === "20260929-112105");
  check("dir name <commit>-<stamp>", runDirName("6355e1e", "2026-09-29T11:21:05Z") === "6355e1e-20260929-112105");

  console.log("saveRun / listRuns");
  const promptEvalDir = path.join(root, "prompt-eval");
  const runsDir = path.join(promptEvalDir, "runs");
  fs.mkdirSync(promptEvalDir, { recursive: true });
  const r1 = save(root, runsDir, "before", { commit: "aaaaaaa", generatedAt: "2026-09-28T10:00:00Z" });
  check("saved to runs/<commit>-<time>", path.basename(r1) === "aaaaaaa-20260928-100000");
  check("both files copied", fs.existsSync(path.join(r1, "responses.json")) && fs.existsSync(path.join(r1, "report.md")));
  const twin = save(root, runsDir, "before", { commit: "aaaaaaa", generatedAt: "2026-09-28T10:00:00Z" });
  check("a second run in the same second never overwrites the first", path.basename(twin) === "aaaaaaa-20260928-100000-2" && fs.existsSync(r1));
  fs.rmSync(twin, { recursive: true });
  save(root, runsDir, "after", { commit: "bbbbbbb", generatedAt: "2026-09-29T10:00:00Z" });
  const runs = listRuns({ runsDir });
  check("two runs, oldest first", runs.map((r) => r.commit).join() === "aaaaaaa,bbbbbbb", JSON.stringify(runs));
  check("latest run", latestRun(runs).commit === "bbbbbbb");
  check("previous run of another commit", previousRunOfOtherCommit(runs, latestRun(runs)).commit === "aaaaaaa");
  check("latest run of a commit (prefix)", latestRunOfCommit(runs, "aaaa").commit === "aaaaaaa");
  check("no run of an unknown commit", latestRunOfCommit(runs, "ccccccc") === null);

  console.log("comparator without directories");
  const auto = runCompare([], { runsDir, promptEvalDir });
  check("latest vs previous of another commit: exit 1 (the fixture has a regression)", auto.code === 1, auto.err);
  check("names the two runs", auto.out.includes("aaaaaaa-20260928-100000") && auto.out.includes("bbbbbbb-20260929-100000"), auto.out.slice(0, 300));
  check("reports the regression", /regression/i.test(auto.out));
  const against = runCompare(["--against", "aaaaaaa"], { runsDir, promptEvalDir });
  check("--against <commit>: same pair", against.code === 1 && against.out.includes("aaaaaaa-20260928-100000"));
  const noRef = runCompare(["--against", "ccccccc"], { runsDir, promptEvalDir });
  check("--against an unknown commit: exit 2 with a message", noRef.code === 2 && noRef.err.includes("No saved run of commit ccccccc"), noRef.err);

  console.log("another run of the same commit, and partial runs");
  save(root, runsDir, "after", { commit: "bbbbbbb", generatedAt: "2026-09-29T12:00:00Z" });
  const sameCommit = listRuns({ runsDir });
  check("a second run of the same commit still compares with the other commit", previousRunOfOtherCommit(sameCommit, latestRun(sameCommit)).commit === "aaaaaaa");
  save(root, runsDir, "before", { commit: "ddddddd", generatedAt: "2026-09-30T09:00:00Z", partial: true });
  save(root, runsDir, "after", { commit: "eeeeeee", generatedAt: "2026-09-30T10:00:00Z" });
  const withPartial = listRuns({ runsDir });
  check("partial flag read from the header", withPartial.find((r) => r.commit === "ddddddd").partial === true);
  check("a partial run is never preferred as the reference", previousRunOfOtherCommit(withPartial, latestRun(withPartial)).commit === "bbbbbbb");
  check("…nor as --against's run when a full one exists", latestRunOfCommit(withPartial, "bbbb").name === "bbbbbbb-20260929-120000");
  const onlyPartial = withPartial.filter((r) => r.commit === "ddddddd" || r.commit === "eeeeeee");
  check("a partial run is used when it is the only one of another commit", previousRunOfOtherCommit(onlyPartial, latestRun(onlyPartial)).commit === "ddddddd");

  console.log("first run: no reference yet");
  const lonelyRuns = path.join(root, "lonely", "runs");
  save(root, lonelyRuns, "before", { commit: "aaaaaaa", generatedAt: "2026-09-28T10:00:00Z" });
  const lonely = pickSavedRuns({ runsDir: lonelyRuns, promptEvalDir: path.join(root, "lonely") });
  check("a single run becomes the reference", Boolean(lonely.error) && lonely.error.includes("it becomes the reference"), JSON.stringify(lonely));
  const empty = pickSavedRuns({ runsDir: path.join(root, "none", "runs"), promptEvalDir: path.join(root, "none") });
  check("no runs at all: a message, never a crash", Boolean(empty.error) && empty.error.includes("No saved runs"));

  console.log("importing baseline-<commit>/");
  const importRoot = path.join(root, "import");
  const baseline = path.join(importRoot, "baseline-6355e1e");
  fs.mkdirSync(baseline, { recursive: true });
  const base = JSON.parse(fs.readFileSync(path.join(FIXTURES, "before", "responses.json"), "utf8"));
  base.header = { ...base.header, commit: "6355e1e", generatedAt: "2026-09-27T08:30:00Z" };
  fs.writeFileSync(path.join(baseline, "responses.json"), JSON.stringify(base));
  fs.writeFileSync(path.join(baseline, "report.md"), "# baseline\n");
  fs.mkdirSync(path.join(importRoot, "baseline-notahash"), { recursive: true });
  const importedRuns = path.join(importRoot, "runs");
  const created = importBaselines({ promptEvalDir: importRoot, runsDir: importedRuns });
  check("baseline-6355e1e imported with its header's time", created.join() === "6355e1e-20260927-083000", JSON.stringify(created));
  check("the baseline directory is left in place", fs.existsSync(path.join(baseline, "responses.json")));
  check("importing again adds nothing", importBaselines({ promptEvalDir: importRoot, runsDir: importedRuns }).length === 0);
  save(root, importedRuns, "after", { commit: "fffffff", generatedAt: "2026-09-30T10:00:00Z" });
  const vsBaseline = pickSavedRuns({ runsDir: importedRuns, promptEvalDir: importRoot });
  check("the next run compares with the imported baseline", vsBaseline.before?.commit === "6355e1e" && vsBaseline.after?.commit === "fffffff", JSON.stringify(vsBaseline));

  // Barrido final 2/2, Part 7: the comparison goes into report.md too (the
  // working copy and the saved run's copy), the same text the console shows.
  console.log("comparison section in report.md");
  const p7 = path.join(root, "part7", "runs");
  const firstDir = save(root, p7, "before", { commit: "aaaaaaa", generatedAt: "2026-09-28T10:00:00Z" });
  const firstRuns = listRuns({ runsDir: p7 });
  const firstReport = path.join(firstDir, "report.md");
  const firstBefore = fs.readFileSync(firstReport, "utf8");
  const noPrevious = appendComparison({ reportFiles: [firstReport], previous: previousRunOfOtherCommit(firstRuns, firstRuns[0]), compare: () => { throw new Error("never called"); } });
  const firstAfter = fs.readFileSync(firstReport, "utf8");
  check("no previous run: report.md says so, no error", firstAfter.startsWith(firstBefore) && firstAfter.includes("## Comparison with the previous run") && firstAfter.includes("this run is the reference for the next one"), firstAfter.slice(-300));
  check("… and the console gets the same section", firstAfter.endsWith(noPrevious));
  const secondDir = save(root, p7, "after", { commit: "bbbbbbb", generatedAt: "2026-09-29T10:00:00Z" });
  const runs7 = listRuns({ runsDir: p7 });
  const current = runs7.find((r) => r.dir === secondDir);
  const previous = previousRunOfOtherCommit(runs7, current);
  const working = path.join(root, "part7", "report.md");
  fs.copyFileSync(path.join(secondDir, "report.md"), working);
  const expectedText = compareRunDirs(previous.dir, secondDir, { casesFile: path.join(FIXTURES, "cases.json"), beforeName: previous.name, afterName: current.name }).text;
  appendComparison({
    reportFiles: [working, path.join(secondDir, "report.md")],
    previous,
    compare: () => compareRunDirs(previous.dir, secondDir, { casesFile: path.join(FIXTURES, "cases.json"), beforeName: previous.name, afterName: current.name }).text,
  });
  for (const [name, file] of [["working report.md", working], ["saved run's report.md", path.join(secondDir, "report.md")]]) {
    const text = fs.readFileSync(file, "utf8");
    check(`${name}: has the comparison with the previous run`, text.includes("## Comparison with the previous run") && text.includes(previous.name) && text.includes(expectedText.trimEnd()), text.slice(-400));
    check(`${name}: lists the regression`, /Regressions?/i.test(text.split("## Comparison with the previous run")[1] || ""));
  }
  const broken = path.join(root, "part7", "broken.md");
  fs.writeFileSync(broken, "# r\n");
  appendComparison({ reportFiles: [broken], previous, compare: () => { throw new Error("responses.json unreadable"); } });
  check("a failed comparison says why in report.md", fs.readFileSync(broken, "utf8").includes("failed: responses.json unreadable"));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

// ── Remates B, Part 3: the session never expires mid-pass ────────────────
// A fake backend: tokens "t1", "t2"…; a token is valid until the test
// expires it; /api/projects lists and deletes.
function fakeBackend({ goodPassword = "pw", loginFailsFrom = Infinity } = {}) {
  const state = { logins: 0, valid: new Set(), calls: [], projects: [] };
  const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  state.fetch = async (url, init = {}) => {
    const u = new URL(url);
    state.calls.push(`${init.method || "GET"} ${u.pathname}`);
    if (u.pathname === "/api/auth/login") {
      state.logins += 1;
      const body = JSON.parse(init.body);
      if (body.password !== goodPassword || state.logins >= loginFailsFrom) return json(401, { detail: "Invalid email or password" });
      const token = `t${state.logins}`;
      state.valid.add(token);
      return json(200, { access_token: token });
    }
    const token = (init.headers?.Authorization || "").replace(/^Bearer /, "");
    if (!state.valid.has(token)) return json(401, { detail: "Not authenticated" });
    if (u.pathname === "/api/projects" && (init.method || "GET") === "GET") return json(200, state.projects);
    const del = /^\/api\/projects\/([^/]+)$/.exec(u.pathname);
    if (del && init.method === "DELETE") {
      state.projects = state.projects.filter((p) => p.id !== del[1]);
      return json(204);
    }
    return json(200, { ok: true, path: u.pathname });
  };
  state.expireAll = () => state.valid.clear();
  return state;
}

{
  const be = fakeBackend();
  const client = createEvalClient({ api: "http://fake", email: "a@x", password: "pw", fetchImpl: be.fetch });
  await client.login();
  check("session: first login", be.logins === 1);
  be.expireAll();
  const r = await client.apiFetch("/api/llm-proxy", { method: "POST", body: "{}" });
  check("session: a 401 logs in again once and repeats the call", r.ok === true && be.logins === 2 && client.relogins === 1, JSON.stringify(be.calls));
  check("session: the repeated call is the same request", be.calls.filter((c) => c === "POST /api/llm-proxy").length === 2);
  be.expireAll();
  const raw = await client.rawFetch("/api/projects/p1/ai-extract/parse", { method: "POST", body: new FormData() });
  check("session: rawFetch (multipart upload) re-logs in too", raw.status === 200 && be.logins === 3);
}
{
  // Re-login fails (the account changed mid-pass): SessionLostError, and the
  // client remembers it so the pass stops even if a caller swallowed it.
  const be = fakeBackend({ loginFailsFrom: 2 });
  const client = createEvalClient({ api: "http://fake", email: "a@x", password: "pw", fetchImpl: be.fetch });
  await client.login();
  be.expireAll();
  let err = null;
  try {
    await client.apiFetch("/api/llm-proxy", { method: "POST", body: "{}" });
  } catch (e) {
    err = e;
  }
  check("session: unrecoverable → SessionLostError", err instanceof SessionLostError && /logging in again failed/.test(err.message), err?.message);
  check("session: lost is remembered", client.lost instanceof SessionLostError);
  check("session: no retry loop (one re-login attempt)", be.logins === 2, String(be.logins));
}
{
  // Wrong credentials at the start: a clear error, one attempt, no loop.
  const be = fakeBackend();
  const client = createEvalClient({ api: "http://fake", email: "a@x", password: "wrong", fetchImpl: be.fetch });
  let err = null;
  try {
    await client.login();
  } catch (e) {
    err = e;
  }
  check("bad credentials: LoginError with the reason", err instanceof LoginError && /Login failed for a@x \(HTTP 401/.test(err.message) && /PROMPT_EVAL_EMAIL/.test(err.message), err?.message);
  check("bad credentials: one login attempt only", be.logins === 1);
  const none = createEvalClient({ api: "http://fake", email: "", password: "", fetchImpl: be.fetch });
  let err2 = null;
  try {
    await none.login();
  } catch (e) {
    err2 = e;
  }
  check("missing credentials: LoginError, no request", err2 instanceof LoginError && be.logins === 1);
}
{
  // --cleanup: deletes only "Prompt Eval — …" projects the user can delete,
  // lists them; with nothing to delete it says so.
  const be = fakeBackend();
  be.projects = [
    { id: "a", name: `${EVAL_PROJECT_PREFIX}S1000D 4.2 — 1`, effective_role: "editor" },
    { id: "b", name: `${EVAL_PROJECT_PREFIX}DITA 1.3 Xpath2.0 — 2`, effective_role: "editor" },
    { id: "c", name: "Lufthansa CMM", effective_role: "editor" },
    { id: "d", name: `${EVAL_PROJECT_PREFIX}S1000D 4.1 — 3`, effective_role: "viewer" },
  ];
  const client = createEvalClient({ api: "http://fake", email: "a@x", password: "pw", fetchImpl: be.fetch });
  await client.login();
  be.expireAll(); // cleanup after a long pass: the token has expired
  const logged = [];
  const out = await cleanupLeftoverProjects(client, { log: (l) => logged.push(l) });
  check("--cleanup: deletes the two leftovers it can delete", JSON.stringify(out.deleted) === JSON.stringify([`${EVAL_PROJECT_PREFIX}S1000D 4.2 — 1`, `${EVAL_PROJECT_PREFIX}DITA 1.3 Xpath2.0 — 2`]), JSON.stringify(out));
  check("--cleanup: never another project", be.projects.map((p) => p.id).join() === "c,d");
  check("--cleanup: re-logs in when the token expired", client.relogins === 1);
  check("--cleanup: lists them", logged.filter((l) => l.startsWith("Deleted leftover project:")).length === 2 && logged.at(-1) === "Deleted 2 leftover project(s).", logged.join(" | "));
  const logged2 = [];
  const out2 = await cleanupLeftoverProjects(client, { log: (l) => logged2.push(l) });
  check("--cleanup with nothing: says so and ends ok", out2.deleted.length === 0 && logged2.join() === 'No leftover "Prompt Eval — …" projects: nothing to delete.', logged2.join());
}
// Against the real backend, when it is up: a 401 from the real server
// (an invalid token sent once) is recovered, and --cleanup deletes a real
// leftover project.
{
  const API = process.env.PROMPT_EVAL_API_URL || "http://localhost:8000";
  const email = process.env.PROMPT_EVAL_EMAIL || "admin@example.com";
  const password = process.env.PROMPT_EVAL_PASSWORD || "AdminTest123!";
  const up = await fetch(`${API}/api/auth/login`, { method: "OPTIONS" }).then((r) => r.status < 500, () => false);
  if (!up) console.log("  (backend not reachable: real-server session checks skipped)");
  else {
    let spoil = false;
    const fetchImpl = (url, init = {}) => {
      if (spoil && init.headers?.Authorization) {
        spoil = false;
        return fetch(url, { ...init, headers: { ...init.headers, Authorization: "Bearer expired" } });
      }
      return fetch(url, init);
    };
    const client = createEvalClient({ api: API, email, password, fetchImpl });
    await client.login();
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
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
