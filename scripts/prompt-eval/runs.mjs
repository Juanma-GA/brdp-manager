// Saved prompt-eval runs (C3, Part 2) -- shared by scripts/run-prompt-eval.mjs
// (saves every run and compares it with the previous one) and
// scripts/compare-prompt-eval.mjs (picks the two runs to compare when it is
// called without directories).
//
// Layout: scripts/prompt-eval/runs/<commit>-<YYYYMMDD-HHMMSS>/{report.md,
// responses.json} (UTC time; gitignored -- they hold real LLM answers).
// The commit is the short hash the run's header records; whether the
// working tree had uncommitted changes stays in the header.
//
// Choosing a reference:
//   - latestRun: the most recent run (by the time in its name).
//   - previousRunOfOtherCommit: the most recent run of any OTHER commit
//     than the given run's. Full runs (no --only / --cases) are preferred
//     over partial ones, so a quick "--only one-case" run never becomes
//     the reference of the next full pass; a partial run is used only when
//     no full run of another commit exists.
//   - latestRunOfCommit(commit): the most recent run of that commit
//     (prefix match on the hash, full runs preferred) -- "--against".
//
// Importing earlier baselines: a directory scripts/prompt-eval/baseline-<commit>/
// with a responses.json (how references were kept before this change, e.g.
// baseline-6355e1e) is copied into runs/ the first time runs are listed, as
// <commit>-<time of its header's generatedAt>, unless a run of that commit
// already exists there. The baseline directory itself is left untouched.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROMPT_EVAL_DIR = __dirname;
export const RUNS_DIR = path.join(__dirname, "runs");

const RUN_NAME_RE = /^([0-9a-f]{4,40}|unknown)-(\d{8}-\d{6})(?:-\d+)?$/;

// "2026-09-29T11:21:05.123Z" -> "20260929-112105" (UTC).
export function runStamp(isoDate) {
  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid date: ${isoDate}`);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

export function runDirName(commit, isoDate) {
  return `${commit || "unknown"}-${runStamp(isoDate)}`;
}

function readHeader(dir) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dir, "responses.json"), "utf8"));
    return Array.isArray(data) ? {} : data.header || {};
  } catch {
    return {};
  }
}

// Copies scripts/prompt-eval/baseline-<commit>/ into runs/ (see above).
// Returns the names of the runs it created.
export function importBaselines({ promptEvalDir = PROMPT_EVAL_DIR, runsDir = path.join(promptEvalDir, "runs") } = {}) {
  if (!fs.existsSync(promptEvalDir)) return [];
  const created = [];
  for (const entry of fs.readdirSync(promptEvalDir, { withFileTypes: true })) {
    const m = entry.isDirectory() && /^baseline-([0-9a-f]{4,40})$/.exec(entry.name);
    if (!m) continue;
    const source = path.join(promptEvalDir, entry.name);
    if (!fs.existsSync(path.join(source, "responses.json"))) continue;
    const commit = m[1];
    const existing = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter((n) => n.startsWith(`${commit}-`)) : [];
    if (existing.length > 0) continue;
    const header = readHeader(source);
    const when = header.generatedAt || fs.statSync(path.join(source, "responses.json")).mtime.toISOString();
    const name = runDirName(commit, when);
    const target = path.join(runsDir, name);
    fs.mkdirSync(target, { recursive: true });
    for (const file of ["responses.json", "report.md"]) {
      if (fs.existsSync(path.join(source, file))) fs.copyFileSync(path.join(source, file), path.join(target, file));
    }
    created.push(name);
  }
  return created;
}

// Every saved run, oldest first: [{ name, dir, commit, stamp, partial }].
export function listRuns({ runsDir = RUNS_DIR } = {}) {
  if (!fs.existsSync(runsDir)) return [];
  return fs
    .readdirSync(runsDir, { withFileTypes: true })
    .map((e) => (e.isDirectory() ? RUN_NAME_RE.exec(e.name) : null))
    .filter(Boolean)
    .filter((m) => fs.existsSync(path.join(runsDir, m[0], "responses.json")))
    .map((m) => {
      const dir = path.join(runsDir, m[0]);
      return { name: m[0], dir, commit: m[1], stamp: m[2], partial: Boolean(readHeader(dir).partial) };
    })
    .sort((a, b) => (a.stamp === b.stamp ? a.name.localeCompare(b.name) : a.stamp.localeCompare(b.stamp)));
}

// The most recent of `runs`, full runs first (a partial one only if there
// is no full one).
function mostRecent(runs) {
  const full = runs.filter((r) => !r.partial);
  const pool = full.length ? full : runs;
  return pool.length ? pool[pool.length - 1] : null;
}

export function latestRun(runs) {
  return runs.length ? runs[runs.length - 1] : null;
}

export function previousRunOfOtherCommit(runs, run) {
  if (!run) return null;
  return mostRecent(runs.filter((r) => r.commit !== run.commit && r.stamp <= run.stamp && r.name !== run.name));
}

export function latestRunOfCommit(runs, commit) {
  const c = String(commit || "").toLowerCase();
  if (!c) return null;
  return mostRecent(runs.filter((r) => r.commit.startsWith(c) || c.startsWith(r.commit)));
}

// Saves a run: copies the report and responses the harness just wrote into
// runs/<commit>-<time>/. Returns the new run's directory.
export function saveRun({ reportDir, commit, generatedAt, runsDir = RUNS_DIR }) {
  const name = runDirName(commit, generatedAt);
  let target = path.join(runsDir, name);
  // Two runs in the same second (tests): never overwrite one.
  for (let i = 2; fs.existsSync(target); i++) target = path.join(runsDir, `${name}-${i}`);
  fs.mkdirSync(target, { recursive: true });
  for (const file of ["report.md", "responses.json"]) fs.copyFileSync(path.join(reportDir, file), path.join(target, file));
  return target;
}

// Barrido final 2/2, Part 7: the comparison with the previous run of another
// commit -- Regressions, Improvements, Review by hand, prompt sizes -- as a
// section of report.md, not only on the console. `compare()` returns the
// comparison text (compare-prompt-eval.mjs's formatComparison) or throws.
// Appended to every file of `reportFiles` (the working report and the saved
// run's copy); returns the section, for the console. With no previous run
// the section says so (this run is the reference); a comparison that fails
// says why -- never an empty or missing section (HR7).
export function comparisonSection({ previous, compare }) {
  const lines = ["", "## Comparison with the previous run", ""];
  if (!previous) {
    lines.push("No earlier run of another commit to compare with: this run is the reference for the next one.");
    return lines.join("\n") + "\n";
  }
  lines.push(`Compared with \`${previous.name}\` (the previous run of another commit).`, "");
  try {
    lines.push(compare().trimEnd());
  } catch (err) {
    lines.push(`The comparison with ${previous.name} failed: ${err.message}`);
  }
  return lines.join("\n") + "\n";
}

export function appendComparison({ reportFiles, previous, compare }) {
  const section = comparisonSection({ previous, compare });
  for (const file of reportFiles) fs.appendFileSync(file, section);
  return section;
}
