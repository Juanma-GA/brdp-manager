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
import { main as compareMain, pickSavedRuns } from "./compare-prompt-eval.mjs";
import {
  importBaselines,
  latestRun,
  latestRunOfCommit,
  listRuns,
  previousRunOfOtherCommit,
  runDirName,
  runStamp,
  saveRun,
} from "./prompt-eval/runs.mjs";

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
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
