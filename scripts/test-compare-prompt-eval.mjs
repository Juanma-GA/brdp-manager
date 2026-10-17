// Tests for scripts/compare-prompt-eval.mjs (C2b, Part 2), over the two
// example reports in scripts/prompt-eval/compare-fixtures/.
//
// Run: node scripts/test-compare-prompt-eval.mjs

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compareReports, formatComparison, loadReport, loadCaseTypes } from "./compare-prompt-eval.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(__dirname, "prompt-eval", "compare-fixtures");
const BEFORE = path.join(FIX, "before");
const AFTER = path.join(FIX, "after");
const CASES = path.join(FIX, "cases.json");
const SCRIPT = path.join(__dirname, "compare-prompt-eval.mjs");

let passed = 0;
let failed = 0;
function check(name, cond, extra = "") {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${extra ? " -- " + extra : ""}`);
  }
}

function runCli(args) {
  try {
    const out = execFileSync("node", [SCRIPT, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status, out: String(err.stdout || ""), err: String(err.stderr || "") };
  }
}

const before = loadReport(BEFORE);
const after = loadReport(AFTER);
const caseTypes = loadCaseTypes(CASES);
const r = compareReports(before, after, { caseTypes });
const find = (rows, id, key) => rows.find((x) => x.id === id && x.key === key);

console.log("Regressions");
check("3/3 -> 2/3 is a regression", find(r.regressions, "ask-a", "contains#1")?.after === "UNSTABLE 2/3");
check("PASS -> FAIL is a regression", find(r.regressions, "sr-names", "xpath_valid#1")?.after === "FAIL 0/3");
check("the second check of a type is keyed on its own (contains#2)", !!find(r.regressions, "sr-names", "contains#2") && !find(r.regressions, "sr-names", "contains#1"));
check("a case whose every run errored is a regression, with the errors shown", find(r.regressions, "rule-err", "xml_well_formed#1")?.after === "FAIL 0/3 (3 error)");
check("a check already 2/3 that stays 2/3 is not a regression", !find(r.regressions, "rt-titled", "rule_test_verdict_correct#1"));
check("...nor an improvement", !find(r.improvements, "rt-titled", "rule_test_verdict_correct#1"));
check("an unchanged 3/3 check is neither", !find(r.regressions, "ask-a", "max_paragraphs#1") && !find(r.improvements, "ask-a", "max_paragraphs#1"));
check("exactly the four expected regressions", r.regressions.length === 4, JSON.stringify(r.regressions.map((x) => `${x.id}/${x.key}`)));

console.log("Improvements");
check("FAIL -> PASS is an improvement", find(r.improvements, "sp-b", "contains#1")?.before === "FAIL 0/3");
check("exactly one improvement", r.improvements.length === 1);

console.log("Manual checks");
check("a manual check is listed apart", !!r.manual.find((m) => m.id === "sp-b" && m.key === "manual#1"));
check("a check whose every run came back 'manual' is listed apart", !!r.manual.find((m) => m.id === "sr-names" && m.key === "names_in_vocabulary#1"));
check("a manual check of a new case is listed, marked new", !!r.manual.find((m) => m.id === "fresh" && m.isNew));
check("manual checks are never regressions", !r.regressions.some((x) => x.key.startsWith("manual") || x.key.startsWith("names_in_vocabulary")));

console.log("Cases");
check("new case", JSON.stringify(r.newCases) === JSON.stringify(["fresh"]));
check("disappeared case", JSON.stringify(r.removedCases) === JSON.stringify(["gone"]));
check("a new case is not a regression", !r.regressions.some((x) => x.id === "fresh"));

console.log("Prompt sizes");
const size = (id) => r.promptSizes.find((p) => p.id === id);
check("average over the case's runs (1990/2000/2010 -> 2000)", size("sp-b").before === 2000 && size("sp-b").after === 1800);
check("a deterministic Ask case has no prompt size", size("ask-det").before === null && size("ask-det").after === null);
check("an errored case has no size on that side", size("rule-err").before === 3000 && size("rule-err").after === null);
check("module of an old report (no `type`) comes from the cases file", size("gone").type === "ask" && size("sp-b").type === "suggest-proposal");
const mod = (t) => r.moduleSizes.find((m) => m.type === t);
check("module average uses only cases with a prompt on both sides", mod("ask").before === 1000 && mod("ask").after === 900 && mod("ask").cases === 1 && mod("ask").onlyOneSide === 2);
check("suggest-rule: the errored case is counted apart", mod("suggest-rule").cases === 1 && mod("suggest-rule").onlyOneSide === 1 && mod("suggest-rule").before === 4000);
const withoutTypes = compareReports(before, after, {});
check("without a cases file an old case's module is 'unknown' (but types written by the new report still count)", withoutTypes.promptSizes.find((p) => p.id === "gone").type === "unknown" && withoutTypes.promptSizes.find((p) => p.id === "sp-b").type === "suggest-proposal");

console.log("Report text");
const text = formatComparison(r, { beforeName: "before", afterName: "after", beforeHeader: before.header, afterHeader: after.header });
check("header names both commits and marks uncommitted changes", text.includes("commit aaaaaaa") && text.includes("commit bbbbbbb + uncommitted"));
check("regression row", text.includes("| ask-a | contains#1 | PASS 3/3 | UNSTABLE 2/3 | must mention X |"));
check("'Revisar a mano' section", text.includes("## Revisar a mano (3)"));
check("module size row with change", text.includes("| suggest-proposal | 2000 | 1800 | -200 (-10.0%) | 1 | 0 |"));
check("closing line counts the regressions", text.trim().endsWith("**4 regression(s).**"));
const otherModel = formatComparison(r, { beforeHeader: { ...before.header, model: "a" }, afterHeader: { ...after.header, model: "b" } });
check("warns when the two runs used different models", otherModel.includes("different models"));

console.log("CLI");
const withReg = runCli([BEFORE, AFTER, "--cases", CASES]);
check("exits 1 when there is a regression", withReg.code === 1, `code ${withReg.code}`);
check("prints the report", withReg.out.includes("## Regressions (4)"));
const same = runCli([AFTER, AFTER, "--cases", CASES]);
check("exits 0 comparing a run with itself", same.code === 0, `code ${same.code}`);
check("...and says there are no regressions", same.out.includes("No regressions."));
const reverse = runCli([AFTER, BEFORE, "--cases", CASES]);
check("reversed: the improvement becomes the regression (exit 1)", reverse.code === 1 && reverse.out.includes("| sp-b | contains#1 | PASS 3/3 | FAIL 0/3 |"));
const bad = runCli([BEFORE]);
check("usage error exits 2", bad.code === 2);
const missing = runCli([BEFORE, path.join(FIX, "does-not-exist")]);
check("a directory without responses.json exits 2", missing.code === 2 && /No responses\.json/.test(missing.err));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
