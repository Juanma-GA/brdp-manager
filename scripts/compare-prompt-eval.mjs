#!/usr/bin/env node
// Compares two runs of scripts/run-prompt-eval.mjs (C2b, Part 2).
//
// Usage:
//   node scripts/compare-prompt-eval.mjs <reference-dir> <new-dir> [--cases <cases.json>]
//   e.g. node scripts/compare-prompt-eval.mjs scripts/prompt-eval/baseline-a89f562 scripts/prompt-eval/report
//
// Each directory holds the `responses.json` the harness writes (report.md is
// not needed: the per-run results are all in responses.json).
//
// Prints, as markdown:
//   - regressions: every check whose pass rate drops (3/3 -> 2/3, PASS -> FAIL);
//   - improvements: every check whose pass rate goes up;
//   - "revisar a mano": the manual checks (never a regression);
//   - new and disappeared cases, and new and disappeared checks of common cases;
//   - the size of each system prompt (characters, average over the case's
//     runs), before and after, per case and per module (case type).
// Exits 1 if there is any regression, 0 otherwise (2 on a usage error).
//
// Rules:
//   - A check is compared by its pass RATE (passes / runs), so a check that was
//     already 2/3 and stays 2/3 is not a regression, and two runs with a
//     different number of repetitions still compare.
//   - A run that errored counts as "not passed" for every check of the case --
//     a case that now errors is a regression, not a silence (HR7).
//   - A check is identified by its type and its position among the case's
//     checks of the same type ("contains#2" = the case's second `contains`),
//     since responses.json does not store the check's pattern. Adding a check
//     of another type, or appending one at the end, keeps every key stable.
//   - A check of type `manual`, or one whose every run came back "manual"
//     (e.g. names_in_vocabulary with no vocabulary), goes to "revisar a mano".
//   - Deterministic Ask answers have no system prompt; they are left out of the
//     size averages (a case with no prompt at all shows "—").
//   - The module of a case comes from responses.json's `type` (written since
//     C2b); for older runs it is looked up in the cases file by id.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CASES = path.join(__dirname, "prompt-eval", "cases.json");
const EPSILON = 1e-9;
const USAGE = "Usage: node scripts/compare-prompt-eval.mjs <reference-dir> <new-dir> [--cases <cases.json>]";

export function loadReport(dir) {
  const file = fs.existsSync(dir) && fs.statSync(dir).isDirectory() ? path.join(dir, "responses.json") : dir;
  if (!fs.existsSync(file)) throw new Error(`No responses.json in ${dir}`);
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  // The very first harness wrote a bare array; since then {header, cases}.
  if (Array.isArray(data)) return { header: {}, cases: data };
  if (!Array.isArray(data.cases)) throw new Error(`${file}: no "cases" array`);
  return { header: data.header || {}, cases: data.cases };
}

export function loadCaseTypes(casesFile) {
  if (!casesFile || !fs.existsSync(casesFile)) return {};
  const { cases } = JSON.parse(fs.readFileSync(casesFile, "utf8"));
  return Object.fromEntries((cases || []).map((c) => [c.id, c.type]));
}

// One case of responses.json -> { id, type, runs, errored, checks: Map(key -> {...}), promptSize }
export function summarizeCase(caseData, caseTypes = {}) {
  const runs = caseData.runs || [];
  const okRuns = runs.filter((r) => !r.error);
  const checks = new Map();
  for (const run of okRuns) {
    const seen = {};
    for (const c of run.checks || []) {
      seen[c.type] = (seen[c.type] || 0) + 1;
      const key = `${c.type}#${seen[c.type]}`;
      if (!checks.has(key)) checks.set(key, { key, type: c.type, statuses: [], detail: c.detail || "" });
      checks.get(key).statuses.push(c.status);
    }
  }
  for (const check of checks.values()) {
    check.passes = check.statuses.filter((s) => s === "pass").length;
    check.manual = check.type === "manual" || (check.statuses.length > 0 && check.statuses.every((s) => s === "manual"));
  }
  const prompts = okRuns.map((r) => r.systemPrompt).filter((p) => typeof p === "string");
  return {
    id: caseData.id,
    type: caseData.type || caseTypes[caseData.id] || "unknown",
    runs: runs.length,
    errored: runs.length - okRuns.length,
    checks,
    promptSize: prompts.length ? prompts.reduce((a, p) => a + p.length, 0) / prompts.length : null,
  };
}

function rate(passes, runs) {
  return runs > 0 ? passes / runs : 0;
}

function label(passes, runs) {
  if (runs === 0) return "—";
  const verdict = passes === runs ? "PASS" : passes === 0 ? "FAIL" : "UNSTABLE";
  return `${verdict} ${passes}/${runs}`;
}

export function compareReports(before, after, { caseTypes = {} } = {}) {
  const a = new Map(before.cases.map((c) => [c.id, summarizeCase(c, caseTypes)]));
  const b = new Map(after.cases.map((c) => [c.id, summarizeCase(c, caseTypes)]));
  const result = {
    regressions: [],
    improvements: [],
    manual: [],
    newCases: [...b.keys()].filter((id) => !a.has(id)),
    removedCases: [...a.keys()].filter((id) => !b.has(id)),
    newChecks: [],
    removedChecks: [],
    promptSizes: [],
    moduleSizes: [],
  };

  for (const [id, after_] of b) {
    const before_ = a.get(id);
    if (!before_) {
      for (const check of after_.checks.values()) if (check.manual) result.manual.push({ id, key: check.key, detail: check.detail, isNew: true });
      continue;
    }
    // Keys from both sides: a check missing on one side because every run of
    // the case errored there still compares (0 passes).
    const keys = new Set([...before_.checks.keys(), ...after_.checks.keys()]);
    for (const key of keys) {
      const cb = before_.checks.get(key);
      const ca = after_.checks.get(key);
      const allErroredBefore = !cb && before_.errored === before_.runs && before_.runs > 0;
      const allErroredAfter = !ca && after_.errored === after_.runs && after_.runs > 0;
      if (!cb && !allErroredBefore) {
        result.newChecks.push({ id, key });
        if (ca?.manual) result.manual.push({ id, key, detail: ca.detail, isNew: true });
        continue;
      }
      if (!ca && !allErroredAfter) {
        result.removedChecks.push({ id, key });
        continue;
      }
      if (cb?.manual || ca?.manual) {
        result.manual.push({ id, key, detail: (ca || cb).detail });
        continue;
      }
      const passesBefore = cb ? cb.passes : 0;
      const passesAfter = ca ? ca.passes : 0;
      const rb = rate(passesBefore, before_.runs);
      const ra = rate(passesAfter, after_.runs);
      const row = {
        id,
        key,
        before: label(passesBefore, before_.runs) + (before_.errored ? ` (${before_.errored} error)` : ""),
        after: label(passesAfter, after_.runs) + (after_.errored ? ` (${after_.errored} error)` : ""),
        detail: (ca || cb).detail,
      };
      if (ra < rb - EPSILON) result.regressions.push(row);
      else if (ra > rb + EPSILON) result.improvements.push(row);
    }
  }

  // Prompt sizes, per case and per module.
  const ids = [...new Set([...a.keys(), ...b.keys()])];
  const modules = new Map();
  for (const id of ids) {
    const cb = a.get(id);
    const ca = b.get(id);
    const type = ca?.type !== "unknown" && ca?.type ? ca.type : cb?.type || "unknown";
    const row = { id, type, before: cb?.promptSize ?? null, after: ca?.promptSize ?? null };
    result.promptSizes.push(row);
    if (!modules.has(type)) modules.set(type, { type, before: [], after: [], onlyOneSide: 0 });
    // Per module, only the cases with a prompt on BOTH sides -- a new case,
    // a disappeared one or one that errored would otherwise move the average
    // without any prompt having changed.
    if (row.before != null && row.after != null) {
      modules.get(type).before.push(row.before);
      modules.get(type).after.push(row.after);
    } else if (row.before != null || row.after != null) modules.get(type).onlyOneSide++;
  }
  const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
  for (const m of modules.values()) {
    result.moduleSizes.push({ type: m.type, before: avg(m.before), after: avg(m.after), cases: m.before.length, onlyOneSide: m.onlyOneSide });
  }
  result.moduleSizes.sort((x, y) => x.type.localeCompare(y.type));
  return result;
}

function fmtSize(n) {
  return n == null ? "—" : String(Math.round(n));
}

function fmtDelta(before, after) {
  if (before == null || after == null) return "—";
  const d = Math.round(after - before);
  const pct = before ? ` (${d >= 0 ? "+" : ""}${((100 * (after - before)) / before).toFixed(1)}%)` : "";
  return `${d >= 0 ? "+" : ""}${d}${pct}`;
}

function cell(text) {
  return String(text ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").slice(0, 160);
}

export function formatComparison(result, { beforeName = "before", afterName = "after", beforeHeader = {}, afterHeader = {} } = {}) {
  const lines = [];
  lines.push(`# Prompt eval comparison`);
  lines.push("");
  lines.push(`- Reference: ${beforeName}${beforeHeader.commit ? ` (commit ${beforeHeader.commit}${beforeHeader.uncommittedChanges ? " + uncommitted" : ""}, ${beforeHeader.runs ?? "?"} run(s))` : ""}`);
  lines.push(`- New: ${afterName}${afterHeader.commit ? ` (commit ${afterHeader.commit}${afterHeader.uncommittedChanges ? " + uncommitted" : ""}, ${afterHeader.runs ?? "?"} run(s))` : ""}`);
  if (beforeHeader.model && afterHeader.model && beforeHeader.model !== afterHeader.model) {
    lines.push(`- **Warning: different models** (${beforeHeader.model} vs ${afterHeader.model}) -- the comparison is not like for like.`);
  }
  lines.push("");

  lines.push(`## Regressions (${result.regressions.length})`);
  lines.push("");
  if (result.regressions.length) {
    lines.push("| Case | Check | Before | After | Detail |");
    lines.push("|---|---|---|---|---|");
    for (const r of result.regressions) lines.push(`| ${r.id} | ${r.key} | ${r.before} | ${r.after} | ${cell(r.detail)} |`);
  } else lines.push("None.");
  lines.push("");

  lines.push(`## Improvements (${result.improvements.length})`);
  lines.push("");
  if (result.improvements.length) {
    lines.push("| Case | Check | Before | After | Detail |");
    lines.push("|---|---|---|---|---|");
    for (const r of result.improvements) lines.push(`| ${r.id} | ${r.key} | ${r.before} | ${r.after} | ${cell(r.detail)} |`);
  } else lines.push("None.");
  lines.push("");

  lines.push(`## Revisar a mano (${result.manual.length})`);
  lines.push("");
  if (result.manual.length) for (const m of result.manual) lines.push(`- ${m.id} / ${m.key}${m.isNew ? " (new)" : ""}: ${cell(m.detail)}`);
  else lines.push("None.");
  lines.push("");

  lines.push(`## Cases`);
  lines.push("");
  lines.push(`- New (${result.newCases.length}): ${result.newCases.join(", ") || "none"}`);
  lines.push(`- Disappeared (${result.removedCases.length}): ${result.removedCases.join(", ") || "none"}`);
  if (result.newChecks.length) lines.push(`- New checks in existing cases: ${result.newChecks.map((c) => `${c.id}/${c.key}`).join(", ")}`);
  if (result.removedChecks.length) lines.push(`- Disappeared checks in existing cases: ${result.removedChecks.map((c) => `${c.id}/${c.key}`).join(", ")}`);
  lines.push("");

  lines.push(`## System prompt size by module (characters, average per case)`);
  lines.push("");
  lines.push("Only cases with a system prompt on both sides are averaged; cases with a prompt on one side only (new, disappeared, errored) are counted apart.");
  lines.push("");
  lines.push("| Module | Before | After | Change | Cases compared | One side only |");
  lines.push("|---|---|---|---|---|---|");
  for (const m of result.moduleSizes) lines.push(`| ${m.type} | ${fmtSize(m.before)} | ${fmtSize(m.after)} | ${fmtDelta(m.before, m.after)} | ${m.cases} | ${m.onlyOneSide} |`);
  lines.push("");

  lines.push(`## System prompt size by case (characters, average over its runs)`);
  lines.push("");
  lines.push("| Case | Module | Before | After | Change |");
  lines.push("|---|---|---|---|---|");
  for (const p of result.promptSizes) lines.push(`| ${p.id} | ${p.type} | ${fmtSize(p.before)} | ${fmtSize(p.after)} | ${fmtDelta(p.before, p.after)} |`);
  lines.push("");

  lines.push(result.regressions.length ? `**${result.regressions.length} regression(s).**` : "No regressions.");
  return lines.join("\n") + "\n";
}

function main(argv) {
  const positional = [];
  let casesFile = DEFAULT_CASES;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--cases") casesFile = path.resolve(argv[++i]);
    else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log(USAGE);
      return 0;
    } else positional.push(argv[i]);
  }
  if (positional.length !== 2) {
    console.error(USAGE);
    return 2;
  }
  const [beforeDir, afterDir] = positional;
  let before, after;
  try {
    before = loadReport(beforeDir);
    after = loadReport(afterDir);
  } catch (err) {
    console.error(err.message);
    return 2;
  }
  const result = compareReports(before, after, { caseTypes: loadCaseTypes(casesFile) });
  process.stdout.write(
    formatComparison(result, { beforeName: beforeDir, afterName: afterDir, beforeHeader: before.header, afterHeader: after.header })
  );
  return result.regressions.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
