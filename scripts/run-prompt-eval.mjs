#!/usr/bin/env node
// Fixed prompt-quality eval harness (Part 2 of the "refactor + prompt-eval
// harness + schema-facts polish" encargo). Runs the cases in
// scripts/prompt-eval/cases.json against the REAL configured LLM provider
// -- this is meant to be run by a human in an environment that can
// actually reach the provider (this sandbox cannot reach api.mistral.ai,
// see CLAUDE.md), never against the local mock. It exists so prompt
// quality can be checked repeatably instead of by hand every round.
//
// Usage (see CLAUDE.md for the full write-up):
//   PROMPT_EVAL_EMAIL=admin@example.com PROMPT_EVAL_PASSWORD=... \
//     node scripts/run-prompt-eval.mjs --runs 3
//
// What it does, for real, against real endpoints -- nothing is mocked or
// simulated by this script itself:
//   1. Logs in via POST /api/auth/login (credentials from environment
//      variables ONLY -- never written into this file or cases.json).
//   2. For each standard used by the cases, creates ONE temporary project
//      (POST /api/projects, admin-only) and creates every case's BRDP (and
//      any seedReferences) in it via POST .../brdps.
//   3. Launches the real embedding job (POST .../embeddings/compute) and
//      polls GET .../embeddings/status/{id} until it completes -- exactly
//      the same job Suggest Definition/Proposal gate on in the app.
//   4. For each case, --runs times: builds the exact same system prompt
//      the app would (using the real src/prompts/*.js modules from Part 1
//      of this round, fed with real /similar and /schema-cards responses),
//      sends it through the real POST /api/llm-proxy, and evaluates the
//      response against the case's `checks`.
//   5. Deletes every temporary project again at the end -- including on a
//      failure mid-run (try/finally), so a crashed run never leaves
//      synthetic projects behind.
//   6. Writes a per-case hit-rate table (e.g. "2/3") to stdout and to
//      scripts/prompt-eval/report/report.md, plus every full raw response
//      to scripts/prompt-eval/report/responses.json for manual reading.
//   6. (C3) Copies both files to scripts/prompt-eval/runs/<commit>-<time>/
//      and compares the run with the previous run of another commit
//      (scripts/compare-prompt-eval.mjs), printing the result and adding
//      it to report.md as "## Comparison with the previous run".
//      That report/ directory is gitignored -- eval output is a run
//      artifact, never something to commit.
//
// Checks that can't be verified automatically (worded "type": "manual" in
// cases.json) are always reported as "MANUAL REVIEW", never guessed at.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import { buildAskSystemPrompt } from "../src/prompts/askPrompt.js";
import { buildSuggestDefinitionPrompt } from "../src/prompts/suggestDefinitionPrompt.js";
import { buildSuggestProposalPrompt } from "../src/prompts/suggestProposalPrompt.js";
import {
  NOT_CHECKABLE_PREFIX,
  SUGGEST_RULE_USER_MESSAGE,
  buildSuggestRulePrompt,
  parseSuggestRuleResponse,
} from "../src/prompts/suggestRulePrompt.js";
import { ASK_TEMPERATURE, EXTRACT_MAX_TOKENS, FIND_DECISIONS_TEMPERATURE, RULE_PROPOSAL_CHECK_TEMPERATURE, RULE_TEST_MAX_TOKENS, RULE_TEST_REVIEW_TEMPERATURE, RULE_TEST_TEMPERATURE, SUGGEST_TEMPERATURE } from "../src/prompts/shared.js";
import { isTruncatedAnswer, truncatedAnswerError } from "../src/api/llmTruncation.js";

// The default output limit of every other use (llmAPI.js DEFAULT_MAX_TOKENS;
// not imported: llmAPI.js pulls in the browser's API client).
const DEFAULT_MAX_TOKENS = 4000;
import {
  buildRuleTestReviewPrompt,
  parseRuleTestReviewResponse,
  RULE_TEST_REVIEW_USER_MESSAGE,
} from "../src/prompts/ruleTestReviewPrompt.js";
import i18n from "../src/i18n/index.js";
import { ruleDescriptionText } from "../src/utils/ruleTestReasons.js";
import { DOMParser as XmlDomParser } from "@xmldom/xmldom";
import { analyzeRule, describeRule } from "../src/utils/ruleTestEngine.js";
import { exampleProblems, ruleTestVerdict } from "../src/utils/ruleTest.js";
import { cleanInternalNames } from "../src/utils/answerCleanup.js";
import { generateRuleTestExamples } from "../src/utils/ruleTestRun.js";
import { thresholdMismatch } from "../src/utils/ruleThreshold.js";
import { answerStructuralQuestion } from "../src/utils/structuralAnswer.js";
import { STANDARD_TO_RULE_FORMAT } from "../src/constants/ruleFormats.js";
import { wrapRuleXmlFragment } from "../src/api/generateBREX.js";
import { schemaLocationOf, wrapRuleInSchemaContexts } from "../src/utils/ruleSchemaContext.js";
import { splitMultiPathRules } from "../src/utils/ruleSplit.js";

// A case's "schemaLocation" read like the project's configuration would be.
function caseSchemaLocation(testCase) {
  const value = testCase.schemaLocation;
  const config = typeof value === "string" && value.includes("{schema}")
    ? { schemaLocation: "custom", schemaLocationPattern: value }
    : { schemaLocation: value };
  return schemaLocationOf(config, testCase.standard);
}
import { validateXML } from "xmllint-wasm";
import { distinctSchemaNames, languageCheck, aiFieldLanguageCheck, loadSchemaCards, parentsPresentedAsChildren, stripPlaceholders } from "./prompt-eval/checks.mjs";
import { compareRunDirs } from "./compare-prompt-eval.mjs";
import { appendComparison, importBaselines, listRuns, previousRunOfOtherCommit, saveRun } from "./prompt-eval/runs.mjs";
import { readPublicTemplate } from "./lib/readXlsx.mjs";
import { candidatesToDraft, draftCandidates } from "../src/utils/ruleExtractDraft.js";
import { findDecisions } from "../src/utils/textExtract.js";
import { FIND_DECISIONS_USER_MESSAGE } from "../src/prompts/extractFromTextPrompt.js";
import { UNFILLED_MARKER_RE } from "../src/utils/proposalMarkers.js";
import {
  STANDARD_TO_VOCABULARY_FILE,
  checkAgainstVocabulary,
  checkAnswerNames,
  checkRuleFormat,
  checkRuleNames,
  extractContextCandidates,
  extractRuleXPaths,
  invalidRuleXPaths,
  selectSchemaFactNames,
} from "../src/validation/schemaValidation.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const CASES_PATH = path.join(__dirname, "prompt-eval", "cases.json");
const REPORT_DIR = path.join(__dirname, "prompt-eval", "report");

const API = process.env.PROMPT_EVAL_API_URL || "http://localhost:8000";
const EMAIL = process.env.PROMPT_EVAL_EMAIL;
const PASSWORD = process.env.PROMPT_EVAL_PASSWORD;

// "Ajustes al juego de pruebas de prompts" round: the first pass against
// the real provider becomes the baseline every later run gets compared
// against, so the report must say exactly what produced it -- which
// commit (and whether the working tree had uncommitted changes on top of
// it, since those wouldn't be reproducible from git history alone), never
// just "trust me, nothing changed since last time".
function getGitInfo() {
  try {
    const hash = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
    const porcelain = execFileSync("git", ["status", "--porcelain"], { cwd: REPO_ROOT, encoding: "utf8" });
    const dirty = porcelain.trim().length > 0;
    return { commit: hash, dirty };
  } catch {
    return { commit: "unknown", dirty: false };
  }
}

function parseArgs(argv) {
  const args = { runs: 1 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--runs") args.runs = parseInt(argv[++i], 10);
    else if (argv[i] === "--cases") args.casesPath = argv[++i];
    else if (argv[i] === "--only") args.only = argv[++i];
  }
  return args;
}

// ---- Automatic checks -------------------------------------------------
// Each returns { status: "pass" | "fail" | "manual", detail }. "manual" is
// never a pass/fail guess -- it's reported as-is for a human to read.

function countParagraphs(text) {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0).length;
}

const MARKDOWN_PATTERNS = [
  /\*\*[^*]+\*\*/, // **bold**
  /__[^_]+__/, // __bold__
  /`[^`]+`/, // `code`
  /^#{1,6}\s/m, // # heading
  /^\s*[-*]\s+/m, // - bullet / * bullet
  /^\s*\d+\.\s+/m, // 1. numbered list
];

// Suggest Rule checks (Suggest Rule part 2, Part 6). `ctx` carries what a
// rule check needs beyond the raw answer: the parsed XML (fence and XML
// declaration stripped, exactly as the app parses it), the final rule the
// app would save (wrapped in the case's schema context blocks) and the
// standard's vocabulary. Well-formedness uses xmllint-wasm (already a
// dependency; no DOMParser in Node) on the same tolerant <root> wrapper the
// app's own checkWellFormed uses, so a Schematron fragment's undeclared
// sch: prefix never counts as an error.
async function xmlWellFormed(xml) {
  if (!xml || !xml.trim()) return { ok: false, error: "empty answer" };
  const result = await validateXML({ xml: { fileName: "rule.xml", contents: wrapRuleXmlFragment(xml) }, normalization: "format" });
  return result.valid ? { ok: true } : { ok: false, error: result.errors.map((e) => e.message).join(" / ").slice(0, 300) };
}

// A value list in BREX 4.x is one <objectValue> per value -- never a
// comparison predicate inside <objectPath> (Suggest Rule adjustments round).
function usesObjectValue(xml) {
  const hasObjectValue = /<objectValue\b/.test(xml);
  const paths = [...xml.matchAll(/<objectPath\b[^>]*>([\s\S]*?)<\/objectPath>/g)].map((m) => m[1]);
  const predicate = paths.find((p) => /\[[^\]]*(?:!=|=\s*['"]|=\s*&quot;|=\s*&apos;)[^\]]*\]/.test(p));
  if (!hasObjectValue) return { ok: false, detail: "no <objectValue>" };
  if (predicate) return { ok: false, detail: `value comparison predicate in objectPath: ${predicate.slice(0, 120)}` };
  return { ok: true, detail: `${(xml.match(/<objectValue\b/g) || []).length} objectValue element(s), no predicate` };
}

async function runCheck(check, answer, ctx = {}) {
  const flags = check.flags || "";
  // "xpath": only the rule's XPath expressions (objectPath/objpath, or
  // Schematron @context/@test), entity-decoded, one per line -- so a check
  // on the path never matches the objectUse text.
  // T3b: "description" = the rule's deterministic description (describeRule,
  // English -- what the panel shows in place of an LLM explanation);
  // "explanation" = the review's explanation (rule-review).
  // T4b: "reject_examples" = the final content of the rule-test examples
  // meant to be rejected (after the correction round), one per line.
  // "prompt" = the system prompt the case sent (rule test on DM metadata).
  // AI Extract: "title" / "definition" = the texts written for the
  // candidate (the answer is its proposal).
  const target =
    check.target === "text_candidates"
      ? (ctx.textCandidates || []).map((c) => [c.title, c.definition, c.proposal].filter(Boolean).join("\n")).join("\n\n")
      : check.target === "text_quotes"
      ? (ctx.textCandidates || []).map((c) => c.quote).join("\n")
      : check.target === "title"
      ? ctx.extract?.title ?? ""
      : check.target === "definition"
      ? ctx.extract?.definition ?? ""
      : check.target === "prompt"
      ? ctx.systemPrompt ?? ""
      : check.target === "description"
      ? ctx.description ?? ""
      : check.target === "explanation"
      ? ctx.review?.explanation ?? ""
      : check.target === "final"
      ? ctx.finalRule ?? ""
      : check.target === "reject_examples"
      ? (ctx.ruleTest?.examples || []).filter((ex) => ex.expected === "reject").map((ex) => ex.content).join("\n")
      : check.target === "xml"
        ? ctx.xml ?? ""
        : check.target === "xpath"
          ? extractRuleXPaths(ctx.xml || "").join("\n")
          : answer;
  switch (check.type) {
    case "equals": {
      // Exact text (AI Extract's literal texts, taken from the file).
      const ok = target === check.value;
      return { status: ok ? "pass" : "fail", detail: ok ? "exactly as expected" : `got: ${JSON.stringify(target).slice(0, 200)}` };
    }
    // AI Extract (2/2), free text: what code checked on the AI's decisions.
    case "text_candidates_count": {
      // "distinct": the candidates the code warns as a possible repetition
      // of an earlier one (unchecked, never merged) do not count.
      const all = ctx.textCandidates || [];
      const repeated = all.filter((c) => (c.warnings || []).some((w) => w.code === "possible_repetition")).length;
      const n = check.distinct ? all.length - repeated : all.length;
      const ok = n >= check.min && n <= check.max;
      const detail = check.distinct
        ? `${n} distinct decision(s) (${all.length} candidate(s), ${repeated} warned as a possible repetition), expected ${check.min}-${check.max}`
        : `${n} candidate(s), expected ${check.min}-${check.max}`;
      return { status: ok ? "pass" : "fail", detail };
    }
    case "text_quotes_literal": {
      const missing = (ctx.textCandidates || []).filter((c) => !c.quote_found);
      return { status: missing.length ? "fail" : "pass", detail: missing.length ? `not in the text: ${missing.map((c) => JSON.stringify(c.quote.slice(0, 80))).join("; ")}` : "every quote found literally in the text" };
    }
    case "text_identifier_detected": {
      const c = (ctx.textCandidates || []).find((x) => x.origin_identifier === check.identifier);
      return { status: c ? "pass" : "fail", detail: c ? `${check.identifier} read by code (${c.classification})` : `no candidate with ${check.identifier}` };
    }
    case "text_not_extracted": {
      const hits = (ctx.textCandidates || []).filter((c) => check.patterns.some((p) => new RegExp(p, "i").test(c.quote)));
      return { status: hits.length ? "fail" : "pass", detail: hits.length ? `extracted: ${hits.map((c) => JSON.stringify(c.quote.slice(0, 80))).join("; ")}` : "none of them extracted" };
    }
    case "text_drafted": {
      const bad = (ctx.textCandidates || []).filter((c) => (c.ai_fields || []).some((f) => !(c[f] || "").trim()));
      return { status: bad.length ? "fail" : "pass", detail: bad.length ? `${bad.length} candidate(s) without their texts` : "every candidate has its texts" };
    }
    case "extract_literal": {
      // The candidate needed nothing from the AI (its texts come from the
      // file and the catalog) and no LLM call was made.
      const ok = ctx.extract?.draft_status === "not_needed" && !ctx.llmCalled;
      return { status: ok ? "pass" : "fail", detail: ok ? "no LLM call: texts from the file / catalog" : `draft ${ctx.extract?.draft_status}, LLM called: ${!!ctx.llmCalled}` };
    }
    case "extract_drafted": {
      const ok = ctx.extract?.draft_status === "drafted";
      return { status: ok ? "pass" : "fail", detail: ok ? "written from a valid JSON answer" : `not written: ${ctx.extract?.error || ctx.extract?.draft_status}` };
    }
    case "no_placeholders": {
      const hit = target.match(new RegExp(UNFILLED_MARKER_RE.source, UNFILLED_MARKER_RE.flags.replace("g", "")));
      return { status: hit ? "fail" : "pass", detail: hit ? `placeholder left: ${hit[0]}` : "no placeholder" };
    }
    case "xml_well_formed": {
      const r = await xmlWellFormed(ctx.xml);
      return { status: r.ok ? "pass" : "fail", detail: r.ok ? "well-formed" : r.error };
    }
    case "rule_format_valid": {
      // Mejoras A, Part 3: the final rule (after the app's split) is a rule
      // of the format -- the same check as Accept / PUT …/approvals.
      const r = checkRuleFormat(ctx.finalRule || "", ctx.format);
      return { status: r.ok ? "pass" : "fail", detail: r.ok ? `a ${ctx.format} rule${ctx.splitTotal ? ` (split by the app into ${ctx.splitTotal})` : ""}` : `${r.problem.code} ${JSON.stringify(r.problem.params)}` };
    }
    case "rule_count": {
      // How many rule elements the final rule has (structureObjectRule /
      // objrule / sch:pattern), at least `min`.
      const count = (ctx.finalRule || "").match(/<(?:[\w.-]+:)?(?:structureObjectRule|objrule|pattern)\b/g)?.length || 0;
      const min = check.min ?? 1;
      return { status: count >= min ? "pass" : "fail", detail: `${count} rule element(s), expected at least ${min}` };
    }
    case "xpath_valid": {
      // Same parser and rule as the app's Accept gate (validation/schemaValidation.js):
      // every objectPath/objpath / @context / @test, entity-decoded, must parse.
      const count = extractRuleXPaths(ctx.xml || "").length;
      const invalid = invalidRuleXPaths(ctx.xml || "");
      if (invalid.length) return { status: "fail", detail: `invalid XPath: ${invalid.join(" | ").slice(0, 200)}` };
      return { status: "pass", detail: count ? `${count} XPath expression(s), all valid` : "no XPath expression in the answer" };
    }
    case "names_in_vocabulary": {
      const names = checkRuleNames(ctx.xml || "", ctx.vocabulary);
      if (!names.available) return { status: "manual", detail: `no schema vocabulary for ${ctx.standard}` };
      const bad = [...names.notFound, ...names.wrongType.map((w) => `${w.usedAs === "element" ? "<" + w.name + ">" : "@" + w.name} (wrong kind)`)];
      return { status: bad.length ? "fail" : "pass", detail: bad.length ? `not in the schema: ${bad.join(", ")}` : "every name exists" };
    }
    case "answer_names_in_vocabulary": {
      // Ask: the same check as the red warning under the answer in the app
      // (validation/schemaValidation.js); the names the BRDP's own notice already
      // reports are left out, as in the app.
      const names = checkAnswerNames(answer, ctx.vocabulary, ctx.vocabCheck);
      if (!names.available) return { status: "manual", detail: `no schema vocabulary for ${ctx.standard}` };
      const bad = [...names.notFound, ...names.wrongType.map((w) => `${w.usedAs === "element" ? "<" + w.name + ">" : "@" + w.name} (wrong kind)`)];
      return { status: bad.length ? "fail" : "pass", detail: bad.length ? `mentioned but not in the schema: ${bad.join(", ")}` : "no nonexistent name mentioned" };
    }
    case "answered_deterministically": {
      // C1, Part 2: whether Ask answered from the schema cards (no LLM call)
      // -- "expect": true for a structural question, false for one that
      // must still go to the LLM.
      const expect = check.expect !== false;
      const is = ctx.deterministic === true;
      return { status: is === expect ? "pass" : "fail", detail: is ? "answered from the schema, no LLM call" : "answered by the LLM" };
    }
    case "not_checkable": {
      const is = answer.trim().replace(/^```\w*\s*/, "").startsWith(NOT_CHECKABLE_PREFIX);
      const expect = check.expect !== false;
      return { status: is === expect ? "pass" : "fail", detail: expect ? `answer starts with ${NOT_CHECKABLE_PREFIX}` : `answer is a rule, not ${NOT_CHECKABLE_PREFIX}` };
    }
    // Rule test (Test de reglas T3, Part 4): the generation of discriminating
    // examples for a known correct rule. ctx.ruleTest is the result of the
    // shared generation (src/utils/ruleTestRun.js), as the panel gets it.
    case "rule_test_json_valid": {
      const r = ctx.ruleTest;
      const ok = r && !r.badResponse && r.status === "ready";
      return {
        status: ok ? "pass" : "fail",
        detail: ok ? "valid JSON with examples" : r?.truncated ? "the answer was cut off by the max_tokens limit" : `not usable: ${r?.error || "no answer"}`,
      };
    }
    case "rule_test_examples_valid": {
      const r = ctx.ruleTest;
      if (!r || r.status !== "ready") return { status: "fail", detail: "no examples" };
      // Barrido final 1/2: each invalid example with its exact reason (the
      // same English lines the correction round sends), not only its label.
      const bad = r.runs
        .map((run, i) => {
          if (run.validation.runnable) return null;
          const reasons = exampleProblems(run.validation, { standard: ctx.standard, schema: r.examples[i].schema });
          return `"${r.examples[i].label}" (${reasons.join("; ") || "not runnable"})`;
        })
        .filter(Boolean);
      const corrected = r.correction ? ` (correction round: ${r.correction.truncated ? "answer cut off by max_tokens" : `${r.correction.fixed}/${r.correction.attempted} fixed`})` : "";
      return { status: bad.length ? "fail" : "pass", detail: bad.length ? `still invalid after the correction round: ${bad.join(", ")}${corrected}` : `all ${r.examples.length} examples valid${corrected}` };
    }
    case "rule_test_accept_and_reject": {
      const r = ctx.ruleTest;
      if (!r || r.status !== "ready") return { status: "fail", detail: "no examples" };
      const expectations = new Set(r.examples.map((ex) => ex.expected));
      const ok = expectations.has("accept") && expectations.has("reject");
      return { status: ok ? "pass" : "fail", detail: `expectations: ${[...expectations].join(", ") || "none"}` };
    }
    case "rule_test_verdict_correct": {
      const r = ctx.ruleTest;
      if (!r || r.status !== "ready") return { status: "fail", detail: "no examples" };
      const verdict = ruleTestVerdict(r.examples, r.runs, ctx.analysis, r.proposalCheck, ctx.threshold);
      return { status: verdict.kind === "correct" ? "pass" : "fail", detail: `engine verdict: ${JSON.stringify(verdict)}` };
    }
    case "rule_test_verdict_review": {
      // "Revisar": a rule that does not implement the Proposal but whose
      // examples pass -- the separate Proposal check (Barrido final 1/2)
      // turns "correct" into "review", as in the app. Only a real mismatch
      // passes: "the Proposal could not be checked" is a review too, but
      // not the answer this case expects.
      const r = ctx.ruleTest;
      if (!r || r.status !== "ready") return { status: "fail", detail: "no examples" };
      const verdict = ruleTestVerdict(r.examples, r.runs, ctx.analysis, r.proposalCheck, ctx.threshold);
      return { status: verdict.kind === "review" && !verdict.unchecked ? "pass" : "fail", detail: `engine verdict: ${JSON.stringify(verdict)}` };
    }
    case "rule_proposal_check_level": {
      // Barrido final 3: the level of the separate Proposal check ("yes",
      // "partly", "no"). `expect`: the accepted levels -- a correct rule
      // whose Proposal also asks something no rule can check is "partly";
      // "yes" is never wrong there, "no" always is.
      const r = ctx.ruleTest;
      if (!r || r.status !== "ready") return { status: "fail", detail: "no examples" };
      const level = { implements: "yes", partial: "partly", mismatch: "no" }[r.proposalCheck?.status] || null;
      const expect = check.expect || ["yes", "partly"];
      const why = r.proposalCheck?.reason || r.proposalCheck?.error || "";
      return { status: level && expect.includes(level) ? "pass" : "fail", detail: `level: ${level || r.proposalCheck?.status || "no check"}${why ? ` (${why})` : ""}; expected ${expect.join(" or ")}` };
    }
    case "rule_test_verdict_incorrect": {
      // T3b: a known WRONG rule -- examples written from the decision must
      // expose it.
      const r = ctx.ruleTest;
      if (!r || r.status !== "ready") return { status: "fail", detail: "no examples" };
      const verdict = ruleTestVerdict(r.examples, r.runs, ctx.analysis, r.proposalCheck, ctx.threshold);
      return { status: verdict.kind === "incorrect" ? "pass" : "fail", detail: `engine verdict: ${JSON.stringify(verdict)}` };
    }
    case "rule_test_verdict_not_correct": {
      // Mejoras A, Part 4: a rule off by one level against its Proposal --
      // "incorrect" or "review" both pass; only "correct" fails.
      const r = ctx.ruleTest;
      if (!r || r.status !== "ready") return { status: "fail", detail: "no examples" };
      const verdict = ruleTestVerdict(r.examples, r.runs, ctx.analysis, r.proposalCheck, ctx.threshold);
      return { status: verdict.kind !== "correct" ? "pass" : "fail", detail: `engine verdict: ${JSON.stringify(verdict)}` };
    }
    case "rule_test_reject_examples_contain": {
      // T3b: every example meant to be rejected carries `pattern` (e.g. the
      // attribute whose values the Proposal restricts -- never relying on
      // its absence). ctx.ruleTest.examples are the FINAL examples, as the
      // panel shows them: after the correction round (a corrected example
      // replaces the first answer's), never the first answer.
      const r = ctx.ruleTest;
      if (!r || r.status !== "ready") return { status: "fail", detail: "no examples" };
      const re = new RegExp(check.pattern, flags);
      const rejects = r.examples.filter((ex) => ex.expected === "reject");
      // "target": "metadata" -- the identification and status section the
      // LLM wrote (rule test on DM metadata); "all" -- the section and the
      // content (a value that may be in the DM's own code or in a
      // reference); the content otherwise.
      const text = (ex) => (check.target === "metadata" ? ex.metadata || ""
        : check.target === "all" ? `${ex.metadata || ""}\n${ex.content || ""}` : ex.content);
      const bad = rejects.filter((ex) => !re.test(text(ex)));
      if (rejects.length === 0) return { status: "fail", detail: "no reject example" };
      return { status: bad.length ? "fail" : "pass", detail: bad.length ? `without /${check.pattern}/: ${bad.map((ex) => ex.label).join(", ")}` : `all ${rejects.length} reject example(s) match /${check.pattern}/` };
    }
    // T3b "Review with the assistant" (rule-review).
    case "review_json_valid": {
      const r = ctx.review;
      return { status: r?.ok ? "pass" : "fail", detail: r?.ok ? `cause "${r.cause}"` : `not usable: ${r?.error || "no answer"}` };
    }
    case "review_cause": {
      const r = ctx.review;
      if (!r?.ok) return { status: "fail", detail: `not usable: ${r?.error || "no answer"}` };
      return { status: r.cause === check.expect ? "pass" : "fail", detail: `cause "${r.cause}" (expected "${check.expect}")` };
    }
    case "rule_test_other_schema_accepted": {
      // A rule limited to one schema: an example of another schema, meant
      // to be accepted, and the engine says the rule does not apply there.
      const r = ctx.ruleTest;
      if (!r || r.status !== "ready") return { status: "fail", detail: "no examples" };
      const ruleSchemas = new Set(ctx.ruleSchemas || []);
      const other = r.examples
        .map((ex, i) => ({ ex, run: r.runs[i] }))
        .filter(({ ex }) => ex.schema && !ruleSchemas.has(ex.schema));
      const good = other.find(({ ex, run }) => ex.expected === "accept" && run.result?.status === "accepted" && run.result.outOfScopeSchemas.length > 0);
      return {
        status: good ? "pass" : "fail",
        detail: good ? `"${good.ex.label}" (${good.ex.schema}): accepted, the rule does not apply` : `other-schema examples: ${other.map(({ ex, run }) => `${ex.label} (${ex.schema}, expected ${ex.expected}, got ${run.result?.status || "not run"})`).join("; ") || "none"}`,
      };
    }
    case "uses_object_value": {
      const r = usesObjectValue(ctx.xml || "");
      return { status: r.ok ? "pass" : "fail", detail: r.detail };
    }
    case "no_parent_as_child": {
      // C2b: an answer that describes what goes INSIDE check.element must
      // not name the element's parents as its children. Children/parents
      // come from the standard's schema cards (any variant); see
      // parentsPresentedAsChildren in prompt-eval/checks.mjs for which
      // sentences count.
      const standard = check.standard || ctx.standard;
      const r = parentsPresentedAsChildren(answer, check.element, loadSchemaCards(standard), ctx.vocabulary || loadSchemaVocabulary(standard));
      if (!r.available) return { status: "fail", detail: `no schema card for <${check.element}> in ${standard}` };
      return {
        status: r.offenders.length ? "fail" : "pass",
        detail: r.offenders.length
          ? `presented as children of <${check.element}> but only its parents: ${r.offenders.map((n) => `<${n}>`).join(", ")}`
          : `${r.units.length} sentence(s) about what <${check.element}> contains, no parent presented as a child`,
      };
    }
    default:
      // C2b: ignorePlaceholders -- the text check looks at the answer with
      // every "[…]" placeholder emptied (UNFILLED_MARKER_RE), so a value
      // offered as an example inside a placeholder is allowed.
      return runTextCheck(check, check.ignorePlaceholders ? stripPlaceholders(target) : target, flags, ctx);
  }
}

function runTextCheck(check, answer, flags, ctx = {}) {
  switch (check.type) {
    case "contains": {
      const re = new RegExp(check.pattern, flags);
      return { status: re.test(answer) ? "pass" : "fail", detail: check.note || check.pattern };
    }
    case "not_contains": {
      const re = new RegExp(check.pattern, flags);
      return { status: re.test(answer) ? "fail" : "pass", detail: check.note || check.pattern };
    }
    case "contains_any": {
      const hit = check.patterns.some((p) => new RegExp(p, flags).test(answer));
      return { status: hit ? "pass" : "fail", detail: check.note || check.patterns.join(" | ") };
    }
    case "not_contains_any": {
      const hit = check.patterns.some((p) => new RegExp(p, flags).test(answer));
      return { status: hit ? "fail" : "pass", detail: check.note || check.patterns.join(" | ") };
    }
    case "not_ends_with_any": {
      const tail = answer.slice(-(check.tailChars || 300));
      const hit = check.patterns.some((p) => new RegExp(p, flags).test(tail));
      return { status: hit ? "fail" : "pass", detail: check.note || `tail(${check.tailChars || 300}): ` + check.patterns.join(" | ") };
    }
    case "max_paragraphs": {
      const n = countParagraphs(answer);
      return { status: n <= check.max ? "pass" : "fail", detail: `${n} paragraph(s), max ${check.max}` };
    }
    case "max_names": {
      // C2b: an answer must not dump long lists of schema names. Counts the
      // DISTINCT schema names the answer mentions in any form -- <x>, *x*,
      // **x**, `x`, @x, or a bare camelCase word -- when they are in the
      // standard's vocabulary (<x> always counts). The same name several
      // times counts once.
      const names = distinctSchemaNames(answer, ctx.vocabulary);
      const shown = names.slice(0, 20).join(", ") + (names.length > 20 ? ", …" : "");
      return { status: names.length <= check.max ? "pass" : "fail", detail: `${names.length} distinct schema name(s), max ${check.max}${names.length ? ": " + shown : ""}` };
    }
    case "language": {
      // "titles" / "definitions": each text the AI wrote, on its own (short
      // ones follow the short-text rule); a catalog or project text is
      // never judged -- it stays in its own language.
      if (check.target === "titles") return aiFieldLanguageCheck(ctx.textCandidates, "title", check.expect);
      if (check.target === "definitions") return aiFieldLanguageCheck(ctx.textCandidates, "definition", check.expect);
      return languageCheck(answer, check.expect);
    }
    case "no_markdown": {
      const hit = MARKDOWN_PATTERNS.some((re) => re.test(answer));
      return { status: hit ? "fail" : "pass", detail: check.note || "no markdown syntax (**, __, `, #, -, 1.)" };
    }
    case "manual":
      return { status: "manual", detail: check.note || "manual review required" };
    default:
      return { status: "manual", detail: `unknown check type "${check.type}" -- treated as manual review` };
  }
}

// ---- Backend HTTP client ------------------------------------------------

let accessToken = null;

async function apiFetch(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const res = await fetch(`${API}${path}`, { ...options, headers });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = body.detail || detail;
    } catch {
      // not JSON, keep statusText
    }
    throw new Error(`${options.method || "GET"} ${path} -> ${res.status}: ${JSON.stringify(detail)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function login() {
  if (!EMAIL || !PASSWORD) {
    throw new Error(
      "Missing PROMPT_EVAL_EMAIL / PROMPT_EVAL_PASSWORD environment variables. " +
        "This script never reads credentials from a file -- set both env vars " +
        "(an admin account, since it needs to create/delete projects) before running it."
    );
  }
  const data = await apiFetch("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  accessToken = data.access_token;
}

async function createProject(standard) {
  const project = await apiFetch("/api/projects", {
    method: "POST",
    body: JSON.stringify({
      name: `Prompt Eval — ${standard} — ${Date.now()}`,
      standard,
      project_config: {},
      seed_from_catalog: false,
    }),
  });
  return project;
}

async function deleteProject(projectId) {
  await apiFetch(`/api/projects/${projectId}?permanent=true`, { method: "DELETE" });
}

async function createBrdp(projectId, brdp) {
  return apiFetch(`/api/projects/${projectId}/brdps`, {
    method: "POST",
    body: JSON.stringify({
      identifier: brdp.identifier,
      title: brdp.title || "",
      definition: brdp.definition || "",
      proposal: brdp.proposal || "",
      validation: brdp.validation || "Pending",
      comments: brdp.comments || "",
    }),
  });
}

async function runEmbeddingJob(projectId) {
  const pending = await apiFetch(`/api/projects/${projectId}/embeddings/pending`);
  if (pending.project_pending === 0 && pending.catalog_pending === 0) return;
  const { job_id } = await apiFetch(`/api/projects/${projectId}/embeddings/compute`, { method: "POST" });
  const deadline = Date.now() + 5 * 60 * 1000; // 5 min ceiling -- real embedding calls, not the mock
  for (;;) {
    const status = await apiFetch(`/api/projects/${projectId}/embeddings/status/${job_id}`);
    if (status.status === "completed") return;
    if (status.status === "failed") throw new Error(`Embedding job failed: ${status.error}`);
    if (Date.now() > deadline) throw new Error("Embedding job did not complete within 5 minutes");
    await new Promise((r) => setTimeout(r, 1500));
  }
}

async function getAiProvider() {
  return apiFetch("/api/config/ai-provider");
}

// The payload is what the app sends (src/api/llmAPI.js): messages,
// temperature and max_tokens; the server sets the model and refuses any
// other parameter (AACF 1, Part 5).
async function sendToLlm(aiProvider, systemPrompt, userMessage, temperature) {
  const payload =
    aiProvider.provider === "Anthropic"
      ? { max_tokens: DEFAULT_MAX_TOKENS, temperature, system: systemPrompt, messages: [{ role: "user", content: userMessage }] }
      : {
          max_tokens: DEFAULT_MAX_TOKENS,
          temperature,
          messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }],
        };
  const res = await apiFetch("/api/llm-proxy", { method: "POST", body: JSON.stringify({ payload }) });
  if (isTruncatedAnswer(aiProvider.provider, res)) throw truncatedAnswerError();
  if (aiProvider.provider === "Anthropic") return res.content[0].text;
  return res.choices[0].message.content;
}

// ---- Vocabulary + schema facts (same real data the app uses) -----------

const _vocabCache = new Map();

function loadSchemaVocabulary(standard) {
  const file = STANDARD_TO_VOCABULARY_FILE[standard];
  if (!file) return null;
  if (_vocabCache.has(file)) return _vocabCache.get(file);
  const jsonPath = path.join(REPO_ROOT, "public", file);
  if (!fs.existsSync(jsonPath)) return null;
  const json = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  const parsed = { elements: new Set(json.elements || []), attributes: new Set(json.attributes || []) };
  _vocabCache.set(file, parsed);
  return parsed;
}

function computeVocabResult(brdp, standard) {
  const vocabulary = loadSchemaVocabulary(standard);
  const contextCandidates = extractContextCandidates(`${brdp.title}\n${brdp.definition}\n${brdp.proposal}`);
  const checked = checkAgainstVocabulary(contextCandidates, vocabulary);
  return { brdpId: brdp.id, available: checked.available, notFound: checked.notFound, wrongType: checked.wrongType };
}

async function fetchSchemaFacts(standard, names) {
  if (names.length === 0) return [];
  const res = await apiFetch(`/api/schema-cards?standard=${encodeURIComponent(standard)}&names=${encodeURIComponent(names.join(","))}`);
  if (!res.available) return [];
  return names.filter((n) => res.cards[n]).map((n) => ({ name: n, entry: res.cards[n] }));
}

// ---- Case runners --------------------------------------------------------

async function runAskCase(project, aiProvider, createdBrdp, testCase) {
  const vocabulary = loadSchemaVocabulary(testCase.standard);
  const vocabCheck = computeVocabResult(createdBrdp, testCase.standard);
  // C1, Part 2: the same step as the app -- a structural question (children,
  // parents, attributes, values of one schema name) is answered from the
  // full schema cards, with no LLM call.
  if (vocabulary) {
    const structural = await answerStructuralQuestion({
      question: testCase.question,
      standard: testCase.standard,
      vocabulary,
      fetchCards: (standard, names, { full = false } = {}) =>
        apiFetch(`/api/schema-cards?standard=${encodeURIComponent(standard)}&names=${encodeURIComponent(names.join(","))}${full ? "&full=true" : ""}`),
      fetchAttribute: (standard, name) =>
        apiFetch(`/api/schema-cards/attribute?standard=${encodeURIComponent(standard)}&name=${encodeURIComponent(name)}`),
      fetchRelation: (standard, parent, child) =>
        apiFetch(`/api/schema-cards/relation?standard=${encodeURIComponent(standard)}&parent=${encodeURIComponent(parent)}&child=${encodeURIComponent(child)}`),
    });
    if (structural) {
      return {
        systemPrompt: null,
        userMessage: testCase.question,
        answer: structural.text,
        checkContext: { vocabulary, vocabCheck, standard: testCase.standard, deterministic: true },
      };
    }
  }
  const names = selectSchemaFactNames(
    [testCase.question, createdBrdp.title, createdBrdp.definition, createdBrdp.proposal],
    vocabulary,
    6
  ).map((c) => c.name);
  const schemaFacts = await fetchSchemaFacts(testCase.standard, names);
  const systemPrompt = buildAskSystemPrompt(
    createdBrdp,
    null, // ruleApproval -- none of the initial cases need Draft/Verified Rule Status
    null, // compareBrdp -- none of the initial cases use "+ Compare"
    testCase.standard,
    vocabCheck,
    schemaFacts
  );
  const rawAnswer = await sendToLlm(aiProvider, systemPrompt, testCase.question, ASK_TEMPERATURE);
  // Barrido final 1/2: the checks see what the user sees -- the app cleans
  // the cards block's internal name ("SCHEMA FACTS") from the answer
  // (src/utils/answerCleanup.js); responses.json keeps the raw answer too.
  const answer = cleanInternalNames(rawAnswer, { userText: testCase.question });
  return {
    systemPrompt,
    userMessage: testCase.question,
    answer,
    ...(answer !== rawAnswer ? { rawAnswer } : {}),
    checkContext: { vocabulary, vocabCheck, standard: testCase.standard, deterministic: false },
  };
}

async function runSuggestDefinitionCase(project, aiProvider, createdBrdp, testCase) {
  const similar = await apiFetch(`/api/projects/${project.id}/brdps/${createdBrdp.id}/similar?kind=definition`);
  const vocabCheck = computeVocabResult(createdBrdp, testCase.standard);
  const systemPrompt = buildSuggestDefinitionPrompt(
    createdBrdp,
    testCase.standard,
    similar.candidates,
    similar.style_references || [],
    vocabCheck
  );
  const userMessage = "Write the Definition for this BRDP.";
  const answer = await sendToLlm(aiProvider, systemPrompt, userMessage, SUGGEST_TEMPERATURE);
  return { systemPrompt, userMessage, answer };
}

async function runSuggestProposalCase(project, aiProvider, createdBrdp, testCase) {
  const similar = await apiFetch(`/api/projects/${project.id}/brdps/${createdBrdp.id}/similar?kind=proposal`);
  const vocabCheck = computeVocabResult(createdBrdp, testCase.standard);
  const systemPrompt = buildSuggestProposalPrompt(
    createdBrdp,
    testCase.standard,
    similar.same_brdp || [],
    similar.candidates,
    similar.this_project || [],
    vocabCheck
  );
  const userMessage = "Write the Proposal for this BRDP.";
  const answer = await sendToLlm(aiProvider, systemPrompt, userMessage, SUGGEST_TEMPERATURE);
  return { systemPrompt, userMessage, answer };
}

// Suggest Rule (Part 6): same flow as the app -- /similar?kind=rule groups,
// schema facts for the names in the Proposal and Definition, the case's
// fixed schema context (`schemas`, empty = a general rule), the real prompt
// builder, the fixed user message. The final rule is wrapped exactly as the
// app would save it (in the case's optional `schemaLocation` URL form,
// "flat" by default), for checks with "target": "final".
async function runSuggestRuleCase(project, aiProvider, createdBrdp, testCase) {
  const similar = await apiFetch(`/api/projects/${project.id}/brdps/${createdBrdp.id}/similar?kind=rule`);
  const vocabulary = loadSchemaVocabulary(testCase.standard);
  const names = selectSchemaFactNames([createdBrdp.proposal, createdBrdp.definition], vocabulary, 6).map((c) => c.name);
  const schemaFacts = await fetchSchemaFacts(testCase.standard, names);
  const schemas = testCase.schemas || [];
  const systemPrompt = buildSuggestRulePrompt(
    createdBrdp,
    testCase.standard,
    similar.format,
    {
      sameBrdp: similar.same_brdp || [],
      similar: similar.candidates || [],
      formatExamples: [...(similar.standard_fallback || []), ...(similar.template_fallback || [])],
    },
    schemaFacts,
    { schemas }
  );
  const answer = await sendToLlm(aiProvider, systemPrompt, SUGGEST_RULE_USER_MESSAGE, SUGGEST_TEMPERATURE);
  const parsed = parseSuggestRuleResponse(answer);
  const xml = parsed.xml ?? "";
  // Optional "schemaLocation" on the case ("flat" | "master" | a custom
  // pattern with {schema}, default flat) -- the project's Schema location
  // setting, i.e. the context URL form.
  const location = caseSchemaLocation(testCase);
  // Mejoras A, Part 3: like the app (useSuggestions' finalRuleXml), a rule
  // with N objectPath and N objectUse is split first, then wrapped.
  const split = xml ? splitMultiPathRules(xml, similar.format) : { xml: "", total: 0 };
  const finalRule = xml ? wrapRuleInSchemaContexts(split.xml, similar.format, testCase.standard, schemas, location) : "";
  return {
    systemPrompt,
    userMessage: SUGGEST_RULE_USER_MESSAGE,
    answer,
    finalRule,
    checkContext: { xml, finalRule, vocabulary, standard: testCase.standard, format: similar.format, splitTotal: split.total },
  };
}

// Rule test (Test de reglas T3, Part 4): given a known correct rule (the
// case's `rule`, wrapped in its optional `schemas` context blocks exactly as
// Suggest Rule would save it), the same generation the Test rule panel runs
// -- src/utils/ruleTestRun.js, with the real schema cards/structure
// endpoints, the real LLM through /api/llm-proxy at RULE_TEST_TEMPERATURE,
// the one correction round, and the T1 engine. The checks look at whether
// the LLM's examples tell a correct rule apart: valid JSON, examples valid
// after the correction round, an accept and a reject, verdict "correct".
function xmldomParse(text) {
  const messages = [];
  const doc = new XmlDomParser({ errorHandler: (_level, msg) => messages.push(msg) }).parseFromString(text, "text/xml");
  if (messages.length) throw new Error(String(messages[0]).replace(/^\[xmldom \w+\]\s*/, "").split("\n")[0]);
  return doc;
}

// maxTokens: the same limit as the app's use (the rule test's examples:
// RULE_TEST_MAX_TOKENS); a cut answer throws the app's LLM_TRUNCATED error.
async function sendMessagesToLlm(aiProvider, systemPrompt, messages, temperature, maxTokens = DEFAULT_MAX_TOKENS) {
  const payload =
    aiProvider.provider === "Anthropic"
      ? { max_tokens: maxTokens, temperature, system: systemPrompt, messages }
      : { max_tokens: maxTokens, temperature, messages: [{ role: "system", content: systemPrompt }, ...messages] };
  const res = await apiFetch("/api/llm-proxy", { method: "POST", body: JSON.stringify({ payload }) });
  if (isTruncatedAnswer(aiProvider.provider, res)) throw truncatedAnswerError();
  if (aiProvider.provider === "Anthropic") return res.content[0].text;
  return res.choices[0].message.content;
}

async function runRuleTestCase(project, aiProvider, createdBrdp, testCase) {
  const format = STANDARD_TO_RULE_FORMAT[testCase.standard];
  const location = caseSchemaLocation(testCase);
  const schemas = testCase.schemas || [];
  const ruleXml = schemas.length ? wrapRuleInSchemaContexts(testCase.rule, format, testCase.standard, schemas, location) : testCase.rule;
  const vocabulary = loadSchemaVocabulary(testCase.standard);
  const analysis = analyzeRule(ruleXml, format, { parseXml: xmldomParse, standard: testCase.standard });
  const description = ruleDescriptionText(describeRule(ruleXml, format, { parseXml: xmldomParse }), i18n.getFixedT("en"));
  // Mejoras B, Part 2: the rule's threshold against the Proposal's numbers, as in the app.
  const threshold = thresholdMismatch(ruleXml, format, createdBrdp?.proposal ?? testCase.brdp?.proposal ?? "", { parseXml: xmldomParse });
  const result = await generateRuleTestExamples({
    ruleXml,
    format,
    standard: testCase.standard,
    schemaLocation: location,
    brdp: createdBrdp,
    vocabulary,
    ask: (messages, systemPrompt) => sendMessagesToLlm(aiProvider, systemPrompt, messages, RULE_TEST_TEMPERATURE, RULE_TEST_MAX_TOKENS),
    fetchSchemaCards: (standard, names) =>
      apiFetch(`/api/schema-cards?standard=${encodeURIComponent(standard)}&names=${encodeURIComponent(names.join(","))}`),
    fetchStructure: (standard, schema) =>
      apiFetch(`/api/schema-cards/structure?standard=${encodeURIComponent(standard)}&schema=${encodeURIComponent(schema)}`),
    fetchSchemaAttribute: (standard, name) =>
      apiFetch(`/api/schema-cards/attribute?standard=${encodeURIComponent(standard)}&name=${encodeURIComponent(name)}`),
    parseXml: xmldomParse,
    // Barrido final 1/2: the Proposal check, the same separate call as the
    // app (in parallel with the examples, RULE_PROPOSAL_CHECK_TEMPERATURE).
    ruleDescription: description,
    askProposalCheck: (messages, systemPrompt) => sendMessagesToLlm(aiProvider, systemPrompt, messages, RULE_PROPOSAL_CHECK_TEMPERATURE),
  });
  const verdict = result.status === "ready" ? ruleTestVerdict(result.examples, result.runs, analysis, result.proposalCheck, threshold) : null;
  return {
    systemPrompt: result.systemPrompt,
    userMessage: "Write the test examples for this rule.",
    answer: (result.responses || []).join("\n\n--- correction round ---\n\n"),
    finalRule: ruleXml,
    ruleTest: {
      status: result.status,
      error: result.error || null,
      description,
      proposalCheck: result.proposalCheck ? { status: result.proposalCheck.status, reason: result.proposalCheck.reason ?? null, missing: result.proposalCheck.missing ?? null, error: result.proposalCheck.error ?? null, answer: result.proposalCheck.answer ?? null } : null,
      correction: result.correction ?? null,
      verdict,
      examples: (result.examples || []).map((ex, i) => ({
        label: ex.label,
        expected: ex.expected,
        schema: ex.schema,
        content: ex.content,
        metadata: ex.metadata ?? null,
        xml: ex.xml,
        runnable: result.runs[i].validation.runnable,
        problems: result.runs[i].validation.runnable ? [] : exampleProblems(result.runs[i].validation, { standard: testCase.standard, schema: ex.schema }),
        result: result.runs[i].result?.status ?? null,
      })),
    },
    checkContext: { ruleTest: result, analysis, threshold, description, ruleSchemas: schemas, standard: testCase.standard, systemPrompt: result.systemPrompt },
  };
}

// T3b "Review with the assistant": the same prompt the panel builds -- the
// Proposal, the rule, its deterministic description (English) and the
// case's fixed mismatched examples -- at RULE_TEST_REVIEW_TEMPERATURE.
async function runRuleReviewCase(project, aiProvider, createdBrdp, testCase) {
  const format = STANDARD_TO_RULE_FORMAT[testCase.standard];
  const location = caseSchemaLocation(testCase);
  const schemas = testCase.schemas || [];
  const ruleXml = schemas.length ? wrapRuleInSchemaContexts(testCase.rule, format, testCase.standard, schemas, location) : testCase.rule;
  const description = ruleDescriptionText(describeRule(ruleXml, format, { parseXml: xmldomParse }), i18n.getFixedT("en"));
  const mismatches = testCase.mismatches.map((m) => ({ label: m.label, expected: m.expected, got: m.got, content: m.content || m.xml, xml: m.xml }));
  const systemPrompt = buildRuleTestReviewPrompt({ brdp: createdBrdp, standard: testCase.standard, format, ruleXml, ruleDescription: description, mismatches });
  const answer = await sendMessagesToLlm(aiProvider, systemPrompt, [{ role: "user", content: RULE_TEST_REVIEW_USER_MESSAGE }], RULE_TEST_REVIEW_TEMPERATURE);
  const review = parseRuleTestReviewResponse(answer);
  return {
    systemPrompt,
    userMessage: RULE_TEST_REVIEW_USER_MESSAGE,
    answer,
    finalRule: ruleXml,
    checkContext: { review, description, standard: testCase.standard },
  };
}

// AI Extract (1/2): the file goes through the real endpoint (parse +
// classification in the background job), then the same batch drafter as
// the page (src/utils/ruleExtractDraft.js) writes the texts of the case's
// candidate. The answer checked is its proposal; "title"/"definition"
// targets read the other two.
async function runExtractCase(project, aiProvider, _createdBrdp, testCase) {
  const data = fs.readFileSync(path.join(REPO_ROOT, testCase.file));
  const form = new FormData();
  form.append("file", new Blob([data], { type: "application/xml" }), path.basename(testCase.file));
  const res = await fetch(`${API}/api/projects/${project.id}/ai-extract/parse`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    body: form,
  });
  if (!res.ok) throw new Error(`parse -> ${res.status}: ${await res.text()}`);
  const { job_id: jobId } = await res.json();
  const deadline = Date.now() + 5 * 60 * 1000;
  for (;;) {
    const job = await apiFetch(`/api/projects/${project.id}/ai-extract/jobs/${jobId}`);
    if (job.status === "completed") break;
    if (job.status === "failed") throw new Error(`extraction failed: ${job.error}`);
    if (Date.now() > deadline) throw new Error("extraction did not finish within 5 minutes");
    await new Promise((r) => setTimeout(r, 500));
  }
  const { candidates } = await apiFetch(`/api/projects/${project.id}/ai-extract/jobs/${jobId}/candidates`);
  const candidate = candidates.find((c) => c.origin_identifier === testCase.origin);
  if (!candidate) throw new Error(`${testCase.origin} not among the candidates`);
  // The classification the case wants (an empty project with or without the
  // standard's catalog loaded classifies an S1 identifier differently). As a
  // catalog BRDP: Title/Definition from the case's catalog, the Proposal
  // from the file when the file has it (set_texts in the backend) -- then
  // nothing is left for the AI and no LLM call is made.
  let target = { ...candidate };
  if (testCase.classification === "catalog") {
    const literal = candidate.literal?.proposal;
    target = {
      ...target,
      classification: "catalog",
      ...(testCase.catalog || {}),
      proposal: literal || "",
      text_sources: { title: "catalog", definition: "catalog", proposal: literal ? "file" : null },
      ai_fields: literal ? [] : ["proposal"],
      draft_status: literal ? "not_needed" : "pending",
    };
  } else if (testCase.classification && testCase.classification !== candidate.classification) {
    throw new Error(`${testCase.origin} is ${candidate.classification}, the case expects ${testCase.classification}`);
  }
  let systemPrompt = "";
  let llmCalled = false;
  const toDraft = candidatesToDraft([target]);
  const [result] = toDraft.length
    ? await draftCandidates(toDraft, {
        standard: testCase.standard,
        ruleFormat: STANDARD_TO_RULE_FORMAT[testCase.standard],
        ask: async ({ system, user }) => {
          systemPrompt = system;
          llmCalled = true;
          return sendMessagesToLlm(aiProvider, system, [{ role: "user", content: user }], SUGGEST_TEMPERATURE, EXTRACT_MAX_TOKENS);
        },
      })
    : [{ key: target.key, draft_status: target.draft_status }];
  const extract = { title: target.title, definition: target.definition, proposal: target.proposal, ...result };
  return {
    systemPrompt,
    userMessage: llmCalled ? "Write the texts for these BRDPs." : "",
    answer: extract.proposal || "",
    checkContext: { standard: testCase.standard, systemPrompt, extract, llmCalled },
  };
}

// AI Extract (2/2): a free text through the same steps as the page -- the
// real /text endpoint (the word count), step 1 with the app's findDecisions
// (the halves when an answer is cut), the decisions posted for the server
// to check and classify, then the batch drafter for Definition / Proposal.
// The answer reported is the decisions JSON of step 1; the candidates (with
// their texts) are in the check context.
async function runExtractTextCase(project, aiProvider, _createdBrdp, testCase) {
  const text = testCase.textFile ? fs.readFileSync(path.join(REPO_ROOT, testCase.textFile), "utf8") : testCase.text;
  const filename = testCase.textFile ? path.basename(testCase.textFile) : "";
  const { job_id: jobId } = await apiFetch(`/api/projects/${project.id}/ai-extract/text`, { method: "POST", body: JSON.stringify({ text, filename }) });
  let systemPrompt = "";
  const decisions = await findDecisions({
    text,
    standard: testCase.standard,
    ask: async ({ system, user }) => {
      if (!systemPrompt) systemPrompt = system;
      return sendMessagesToLlm(aiProvider, system, [{ role: "user", content: user }], FIND_DECISIONS_TEMPERATURE, EXTRACT_MAX_TOKENS);
    },
  });
  await apiFetch(`/api/projects/${project.id}/ai-extract/jobs/${jobId}/decisions`, { method: "POST", body: JSON.stringify({ decisions }) });
  const deadline = Date.now() + 5 * 60 * 1000;
  for (;;) {
    const job = await apiFetch(`/api/projects/${project.id}/ai-extract/jobs/${jobId}`);
    if (job.status === "completed") break;
    if (job.status === "failed") throw new Error(`extraction failed: ${job.error}`);
    if (Date.now() > deadline) throw new Error("extraction did not finish within 5 minutes");
    await new Promise((r) => setTimeout(r, 500));
  }
  const { candidates } = await apiFetch(`/api/projects/${project.id}/ai-extract/jobs/${jobId}/candidates`);
  const written = await draftCandidates(candidatesToDraft(candidates), {
    standard: testCase.standard,
    ruleFormat: STANDARD_TO_RULE_FORMAT[testCase.standard],
    ask: async ({ system, user }) => sendMessagesToLlm(aiProvider, system, [{ role: "user", content: user }], SUGGEST_TEMPERATURE, EXTRACT_MAX_TOKENS),
  });
  const byKey = new Map(written.map((r) => [r.key, r]));
  // Like the server when the page saves a batch: every field the AI wrote is
  // marked "ai" in text_sources (the language checks judge only those).
  const textCandidates = candidates.map((c) => {
    const r = byKey.get(c.key) || {};
    const aiWritten = (c.ai_fields || []).filter((f) => (r[f] || "").trim()).map((f) => [f, "ai"]);
    return { ...c, ...r, text_sources: { ...(c.text_sources || {}), ...Object.fromEntries(aiWritten) } };
  });
  return {
    systemPrompt,
    userMessage: FIND_DECISIONS_USER_MESSAGE,
    answer: JSON.stringify({ decisions }),
    checkContext: { standard: testCase.standard, systemPrompt, textCandidates },
  };
}

async function runCaseOnce(project, aiProvider, createdBrdp, testCase) {
  if (testCase.type === "extract-from-text") return runExtractTextCase(project, aiProvider, createdBrdp, testCase);
  if (testCase.type === "extract-from-rules") return runExtractCase(project, aiProvider, createdBrdp, testCase);
  if (testCase.type === "rule-test") return runRuleTestCase(project, aiProvider, createdBrdp, testCase);
  if (testCase.type === "rule-review") return runRuleReviewCase(project, aiProvider, createdBrdp, testCase);
  if (testCase.type === "suggest-rule") return runSuggestRuleCase(project, aiProvider, createdBrdp, testCase);
  if (testCase.type === "ask") return runAskCase(project, aiProvider, createdBrdp, testCase);
  if (testCase.type === "suggest-definition") return runSuggestDefinitionCase(project, aiProvider, createdBrdp, testCase);
  if (testCase.type === "suggest-proposal") return runSuggestProposalCase(project, aiProvider, createdBrdp, testCase);
  throw new Error(`Unknown case type: ${testCase.type}`);
}

// ---- Main ----------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const casesFile = args.casesPath ? path.resolve(args.casesPath) : CASES_PATH;
  const { cases } = JSON.parse(fs.readFileSync(casesFile, "utf8"));
  // Templates round: a case can take its BRDP and rule from a row of a
  // curated template ("templateRow": {"file", "id"}), so the case always
  // tests the rule the template really ships, never a copy of it.
  for (const c of cases) {
    if (!c.templateRow) continue;
    const row = readPublicTemplate(c.templateRow.file).find((r) => r.ID === c.templateRow.id);
    if (!row) throw new Error(`${c.id}: ${c.templateRow.id} not found in ${c.templateRow.file}`);
    c.brdp = { identifier: row.ID, title: row.Title, definition: row.Definition, proposal: row.Proposal, validation: row["Proposal Status"] || "Validated" };
    c.rule = row.Rule;
  }
  // --only takes one case id, or several separated by commas.
  const selectedCases = args.only ? cases.filter((c) => args.only.split(",").includes(c.id)) : cases;
  if (selectedCases.length === 0) throw new Error(`No cases matched --only ${args.only}`);

  console.log(`Prompt eval: ${selectedCases.length} case(s), ${args.runs} run(s) each, against ${API}`);
  await login();
  const aiProvider = await getAiProvider();
  const gitInfo = getGitInfo();
  console.log(`Provider: ${aiProvider.provider} / ${aiProvider.model}`);
  console.log(`Commit: ${gitInfo.commit}${gitInfo.dirty ? " (+ uncommitted changes)" : ""}`);

  const standards = [...new Set(selectedCases.map((c) => c.standard))];
  const projectByStandard = new Map();
  const brdpByCase = new Map();

  const results = []; // { case, runs: [{status per check}], responses: [...] }

  try {
    // ---- Setup: one temp project per standard, all cases' BRDPs + seed
    // references created in it, then one real embedding job per project.
    for (const standard of standards) {
      const project = await createProject(standard);
      projectByStandard.set(standard, project);
      console.log(`Created temp project for ${standard}: ${project.id}`);
    }

    for (const testCase of selectedCases) {
      const project = projectByStandard.get(testCase.standard);
      for (const ref of testCase.seedReferences || []) {
        const createdRef = await createBrdp(project.id, ref);
        // Part 6: a seed reference can carry a rule (Verified by default)
        // so Suggest Rule has a real precedent to cite.
        if (ref.rule) {
          const format = STANDARD_TO_RULE_FORMAT[testCase.standard];
          if (!format) throw new Error(`seedReferences rule on ${testCase.id}: ${testCase.standard} has no rule format`);
          await apiFetch(`/api/projects/${project.id}/brdps/${createdRef.id}/approvals/${format}`, {
            method: "PUT",
            body: JSON.stringify({ rule_xml: ref.rule, source: "manual", status: ref.ruleStatus || "approved" }),
          });
        }
      }
      // An extract-from-rules / extract-from-text case has no BRDP of its
      // own: its candidates come from the file or the text.
      if (testCase.brdp) brdpByCase.set(testCase.id, await createBrdp(project.id, testCase.brdp));
    }

    for (const [standard, project] of projectByStandard) {
      console.log(`Computing embeddings for ${standard} project...`);
      await runEmbeddingJob(project.id);
    }

    // ---- Run each case N times ----
    for (const testCase of selectedCases) {
      const project = projectByStandard.get(testCase.standard);
      const createdBrdp = brdpByCase.get(testCase.id);
      const caseResult = { id: testCase.id, type: testCase.type, description: testCase.description, checks: testCase.checks, runs: [] };
      for (let run = 1; run <= args.runs; run++) {
        process.stdout.write(`  ${testCase.id} (run ${run}/${args.runs})... `);
        try {
          const { systemPrompt, userMessage, answer, rawAnswer, finalRule, ruleTest, checkContext } = await runCaseOnce(project, aiProvider, createdBrdp, testCase);
          const checkResults = [];
          for (const check of testCase.checks) checkResults.push({ check, result: await runCheck(check, answer, checkContext) });
          caseResult.runs.push({ run, systemPrompt, userMessage, answer, ...(rawAnswer !== undefined ? { rawAnswer } : {}), ...(finalRule !== undefined ? { finalRule } : {}), ...(ruleTest ? { ruleTest } : {}), checkResults });
          const failed = checkResults.filter((c) => c.result.status === "fail").length;
          console.log(failed === 0 ? "ok" : `${failed} check(s) failed`);
        } catch (err) {
          caseResult.runs.push({ run, error: err.message });
          console.log(`ERROR: ${err.message}`);
        }
      }
      results.push(caseResult);
    }
  } finally {
    // Always clean up, even on a failure mid-run.
    for (const [standard, project] of projectByStandard) {
      try {
        await deleteProject(project.id);
        console.log(`Cleaned up temp project for ${standard}`);
      } catch (err) {
        console.error(`WARNING: failed to delete temp project ${project.id} (${standard}): ${err.message}`);
      }
    }
  }

  const generatedAt = new Date().toISOString();
  // A run of only some cases (--only / --cases) is saved too, marked
  // partial, so it never becomes the reference of a later full pass.
  const partial = Boolean(args.only || args.casesPath);
  writeReport(results, args.runs, { aiProvider, gitInfo, generatedAt, partial });
  saveAndCompare({ gitInfo, generatedAt });
}

// C3, Part 2: every run is saved to scripts/prompt-eval/runs/<commit>-<time>/
// (gitignored), and compared right away with the previous run of another
// commit, if there is one (scripts/prompt-eval/runs.mjs picks it). The
// comparison is printed and added to report.md; the run's own exit code does
// not depend on it.
function saveAndCompare({ gitInfo, generatedAt }) {
  importBaselines();
  const saved = saveRun({ reportDir: REPORT_DIR, commit: gitInfo.commit, generatedAt });
  console.log(`Run saved to ${path.relative(REPO_ROOT, saved)}`);
  const runs = listRuns();
  const current = runs.find((r) => r.dir === saved);
  const previous = previousRunOfOtherCommit(runs, current);
  // Barrido final 2/2, Part 7: also a section of report.md (the working copy
  // and the saved one), not only the console.
  const section = appendComparison({
    reportFiles: [path.join(REPORT_DIR, "report.md"), path.join(saved, "report.md")],
    previous,
    compare: () => compareRunDirs(previous.dir, saved, { casesFile: CASES_PATH, beforeName: previous.name, afterName: current.name }).text,
  });
  console.log(section);
}

// Header shared by report.md and responses.json (Part 2 of this round):
// this eval's FIRST real run against Mistral becomes the baseline every
// later run is compared against, so both files must say exactly what
// produced them -- provider/model, the commit (+ dirty flag), the real
// temperature used per case type (imported from src/prompts/shared.js,
// never a copied number -- see Part 1), the run count, and when it ran.
function buildReportHeader(meta, runs) {
  return {
    provider: meta.aiProvider.provider,
    model: meta.aiProvider.model,
    commit: meta.gitInfo.commit,
    uncommittedChanges: meta.gitInfo.dirty,
    temperatures: { ask: ASK_TEMPERATURE, "suggest-definition": SUGGEST_TEMPERATURE, "suggest-proposal": SUGGEST_TEMPERATURE, "suggest-rule": SUGGEST_TEMPERATURE, "rule-test": RULE_TEST_TEMPERATURE, "rule-review": RULE_TEST_REVIEW_TEMPERATURE, "rule-proposal-check": RULE_PROPOSAL_CHECK_TEMPERATURE, "extract-from-rules": SUGGEST_TEMPERATURE, "extract-from-text": FIND_DECISIONS_TEMPERATURE },
    runs,
    generatedAt: meta.generatedAt,
    // C3: only some cases were run (--only / --cases).
    partial: Boolean(meta.partial),
  };
}

function writeReport(results, runs, meta) {
  fs.mkdirSync(REPORT_DIR, { recursive: true });

  const header = buildReportHeader(meta, runs);

  const lines = [];
  lines.push(`# Prompt eval report`);
  lines.push("");
  lines.push(`- Provider: ${header.provider} / ${header.model}`);
  lines.push(`- Commit: ${header.commit}${header.uncommittedChanges ? " (+ uncommitted changes)" : ""}`);
  lines.push(
    `- Temperatures: ask=${header.temperatures.ask}, suggest-definition=${header.temperatures["suggest-definition"]}, suggest-proposal=${header.temperatures["suggest-proposal"]}, suggest-rule=${header.temperatures["suggest-rule"]}, rule-test=${header.temperatures["rule-test"]}, rule-review=${header.temperatures["rule-review"]}, rule-proposal-check=${header.temperatures["rule-proposal-check"]}, extract-from-rules=${header.temperatures["extract-from-rules"]}, extract-from-text=${header.temperatures["extract-from-text"]} (texts ${SUGGEST_TEMPERATURE})`
  );
  lines.push(`- Runs per case: ${header.runs}`);
  lines.push(`- Generated: ${header.generatedAt}`);
  lines.push("");
  lines.push("| Case | Check | Result | Detail |");
  lines.push("|---|---|---|---|");

  let anyUnstable = false;

  for (const caseResult of results) {
    const numChecks = caseResult.checks.length;
    for (let i = 0; i < numChecks; i++) {
      const check = caseResult.checks[i];
      const outcomes = caseResult.runs.map((r) => (r.error ? "error" : r.checkResults[i].result.status));
      const detail = caseResult.runs.find((r) => !r.error)?.checkResults[i].result.detail || check.note || "";
      // Branch on the check's own type, not on the outcomes -- a manual
      // check must always render as MANUAL REVIEW even if some runs
      // errored before ever reaching it (a run-level error is reported
      // separately, in errorCount below, never folded into a pass/fail
      // verdict for a check that was never meant to have one).
      if (check.type === "manual") {
        const errorNote = outcomes.some((o) => o === "error") ? ` (${outcomes.filter((o) => o === "error").length} run(s) errored, see responses.json)` : "";
        lines.push(`| ${caseResult.id} | ${check.type} | MANUAL REVIEW${errorNote} | ${detail} |`);
        continue;
      }
      const passCount = outcomes.filter((o) => o === "pass").length;
      const errorCount = outcomes.filter((o) => o === "error").length;
      const label = errorCount > 0 ? `${passCount}/${runs} (${errorCount} error)` : `${passCount}/${runs}`;
      if (passCount > 0 && passCount < runs) anyUnstable = true;
      const verdict = passCount === runs ? "PASS" : passCount === 0 ? "FAIL" : "UNSTABLE";
      lines.push(`| ${caseResult.id} | ${check.type} | ${verdict} ${label} | ${detail} |`);
    }
  }

  lines.push("");
  lines.push(anyUnstable ? "**Some checks are unstable across runs -- see UNSTABLE rows above.**" : "No unstable checks across these runs.");
  lines.push("");
  lines.push("Full raw responses: `scripts/prompt-eval/report/responses.json`");

  const reportPath = path.join(REPORT_DIR, "report.md");
  fs.writeFileSync(reportPath, lines.join("\n") + "\n");

  const responsesPath = path.join(REPORT_DIR, "responses.json");
  fs.writeFileSync(
    responsesPath,
    JSON.stringify(
      {
        header,
        cases: results.map((c) => ({
          id: c.id,
          // C2b: the case type (ask, suggest-proposal, ...) -- lets
          // scripts/compare-prompt-eval.mjs group prompt sizes by module.
          type: c.type,
          description: c.description,
          runs: c.runs.map((r) =>
            r.error
              ? { run: r.run, error: r.error }
              : {
                  run: r.run,
                  systemPrompt: r.systemPrompt,
                  userMessage: r.userMessage,
                  answer: r.answer,
                  ...(r.rawAnswer !== undefined ? { rawAnswer: r.rawAnswer } : {}),
                  // Suggest Rule only: the rule as the app would save it
                  // (wrapped in the case's schema context blocks).
                  ...(r.finalRule !== undefined ? { finalRule: r.finalRule } : {}),
                  // Test rule: the examples (with the exact reason of each
                  // invalid one) and the Proposal check (Barrido final 1/2).
                  ...(r.ruleTest ? { ruleTest: r.ruleTest } : {}),
                  checks: r.checkResults.map((cr) => ({ type: cr.check.type, ...cr.result })),
                }
          ),
        })),
      },
      null,
      2
    )
  );

  console.log("");
  console.log(lines.join("\n"));
  console.log("");
  console.log(`Report written to ${reportPath}`);
  console.log(`Full responses written to ${responsesPath}`);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
