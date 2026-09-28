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
import { ASK_TEMPERATURE, RULE_TEST_TEMPERATURE, SUGGEST_TEMPERATURE } from "../src/prompts/shared.js";
import { DOMParser as XmlDomParser } from "@xmldom/xmldom";
import { analyzeRule } from "../src/utils/ruleTestEngine.js";
import { ruleTestVerdict } from "../src/utils/ruleTest.js";
import { generateRuleTestExamples } from "../src/utils/ruleTestRun.js";
import { STANDARD_TO_RULE_FORMAT } from "../src/constants/ruleFormats.js";
import { wrapRuleXmlFragment } from "../src/api/generateBREX.js";
import { checkRuleNames, extractRuleXPaths } from "../src/utils/ruleNameCheck.js";
import { invalidRuleXPaths } from "../src/utils/ruleXPathSyntax.js";
import { checkAnswerNames } from "../src/utils/answerNameCheck.js";
import { schemaLocationOf, wrapRuleInSchemaContexts } from "../src/utils/ruleSchemaContext.js";
import { validateXML } from "xmllint-wasm";
import {
  STANDARD_TO_VOCABULARY_FILE,
  checkAgainstVocabulary,
  extractContextCandidates,
  selectSchemaFactNames,
} from "../src/utils/vocabularyCheck.js";

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

const ES_WORDS = new Set([
  "el", "la", "los", "las", "de", "del", "que", "para", "con", "una", "uno",
  "por", "este", "esta", "estos", "estas", "es", "son", "debe", "deben",
  "se", "como", "sus", "más", "pero", "porque", "cuando", "sin", "entre",
  "sobre", "así", "the", "un", "también", "ya", "muy", "puede", "pueden",
]);
const EN_WORDS = new Set([
  "the", "is", "and", "of", "to", "for", "with", "this", "that", "are",
  "shall", "must", "be", "as", "it", "on", "in", "not", "if", "when",
  "without", "between", "about", "so", "a", "an", "its", "can", "should",
]);

function detectLanguage(text) {
  const words = (text.toLowerCase().match(/[a-zà-ÿñ]+/gi) || []);
  let es = 0;
  let en = 0;
  for (const w of words) {
    if (ES_WORDS.has(w)) es++;
    if (EN_WORDS.has(w)) en++;
  }
  if (es === 0 && en === 0) return "unknown";
  return es > en ? "es" : "en";
}

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
  const target =
    check.target === "explanation"
      ? ctx.ruleTest?.explanation ?? ""
      : check.target === "final"
      ? ctx.finalRule ?? ""
      : check.target === "xml"
        ? ctx.xml ?? ""
        : check.target === "xpath"
          ? extractRuleXPaths(ctx.xml || "").join("\n")
          : answer;
  switch (check.type) {
    case "xml_well_formed": {
      const r = await xmlWellFormed(ctx.xml);
      return { status: r.ok ? "pass" : "fail", detail: r.ok ? "well-formed" : r.error };
    }
    case "xpath_valid": {
      // Same parser and rule as the app's Accept gate (ruleXPathSyntax.js):
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
      // (utils/answerNameCheck.js); the names the BRDP's own notice already
      // reports are left out, as in the app.
      const names = checkAnswerNames(answer, ctx.vocabulary, ctx.vocabCheck);
      if (!names.available) return { status: "manual", detail: `no schema vocabulary for ${ctx.standard}` };
      const bad = [...names.notFound, ...names.wrongType.map((w) => `${w.usedAs === "element" ? "<" + w.name + ">" : "@" + w.name} (wrong kind)`)];
      return { status: bad.length ? "fail" : "pass", detail: bad.length ? `mentioned but not in the schema: ${bad.join(", ")}` : "no nonexistent name mentioned" };
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
      return { status: ok ? "pass" : "fail", detail: ok ? "valid JSON with examples" : `not usable: ${r?.error || "no answer"}` };
    }
    case "rule_test_examples_valid": {
      const r = ctx.ruleTest;
      if (!r || r.status !== "ready") return { status: "fail", detail: "no examples" };
      const bad = r.runs.map((run, i) => (run.validation.runnable ? null : r.examples[i].label)).filter(Boolean);
      const corrected = r.correction ? ` (correction round: ${r.correction.fixed}/${r.correction.attempted} fixed)` : "";
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
      const verdict = ruleTestVerdict(r.examples, r.runs, ctx.analysis);
      return { status: verdict.kind === "correct" ? "pass" : "fail", detail: `engine verdict: ${JSON.stringify(verdict)}` };
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
    default:
      return runTextCheck(check, target, flags);
  }
}

function runTextCheck(check, answer, flags) {
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
    case "language": {
      const detected = detectLanguage(answer);
      return { status: detected === check.expect ? "pass" : "fail", detail: `expected ${check.expect}, detected ${detected} (heuristic, word-list based)` };
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
  await apiFetch(`/api/projects/${projectId}`, { method: "DELETE" });
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

async function sendToLlm(aiProvider, systemPrompt, userMessage, temperature) {
  const payload =
    aiProvider.provider === "Anthropic"
      ? { model: aiProvider.model, max_tokens: 4000, temperature, system: systemPrompt, messages: [{ role: "user", content: userMessage }] }
      : {
          model: aiProvider.model,
          max_tokens: 4000,
          temperature,
          messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }],
        };
  const res = await apiFetch("/api/llm-proxy", { method: "POST", body: JSON.stringify({ payload }) });
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
  const answer = await sendToLlm(aiProvider, systemPrompt, testCase.question, ASK_TEMPERATURE);
  return {
    systemPrompt,
    userMessage: testCase.question,
    answer,
    checkContext: { vocabulary, vocabCheck, standard: testCase.standard },
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
  // Optional "schemaLocation" on the case ("flat" | "master", default flat) --
  // the project's Schema location setting, i.e. the context URL form.
  const location = schemaLocationOf({ schemaLocation: testCase.schemaLocation });
  const finalRule = xml ? wrapRuleInSchemaContexts(xml, similar.format, testCase.standard, schemas, location) : "";
  return {
    systemPrompt,
    userMessage: SUGGEST_RULE_USER_MESSAGE,
    answer,
    finalRule,
    checkContext: { xml, finalRule, vocabulary, standard: testCase.standard },
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

async function sendMessagesToLlm(aiProvider, systemPrompt, messages, temperature) {
  const payload =
    aiProvider.provider === "Anthropic"
      ? { model: aiProvider.model, max_tokens: 4000, temperature, system: systemPrompt, messages }
      : { model: aiProvider.model, max_tokens: 4000, temperature, messages: [{ role: "system", content: systemPrompt }, ...messages] };
  const res = await apiFetch("/api/llm-proxy", { method: "POST", body: JSON.stringify({ payload }) });
  if (aiProvider.provider === "Anthropic") return res.content[0].text;
  return res.choices[0].message.content;
}

async function runRuleTestCase(project, aiProvider, createdBrdp, testCase) {
  const format = STANDARD_TO_RULE_FORMAT[testCase.standard];
  const location = schemaLocationOf({ schemaLocation: testCase.schemaLocation });
  const schemas = testCase.schemas || [];
  const ruleXml = schemas.length ? wrapRuleInSchemaContexts(testCase.rule, format, testCase.standard, schemas, location) : testCase.rule;
  const vocabulary = loadSchemaVocabulary(testCase.standard);
  const analysis = analyzeRule(ruleXml, format, { parseXml: xmldomParse });
  const result = await generateRuleTestExamples({
    ruleXml,
    format,
    standard: testCase.standard,
    schemaLocation: location,
    brdp: createdBrdp,
    vocabulary,
    ask: (messages, systemPrompt) => sendMessagesToLlm(aiProvider, systemPrompt, messages, RULE_TEST_TEMPERATURE),
    fetchSchemaCards: (standard, names) =>
      apiFetch(`/api/schema-cards?standard=${encodeURIComponent(standard)}&names=${encodeURIComponent(names.join(","))}`),
    fetchStructure: (standard, schema) =>
      apiFetch(`/api/schema-cards/structure?standard=${encodeURIComponent(standard)}&schema=${encodeURIComponent(schema)}`),
    parseXml: xmldomParse,
  });
  const verdict = result.status === "ready" ? ruleTestVerdict(result.examples, result.runs, analysis) : null;
  return {
    systemPrompt: result.systemPrompt,
    userMessage: "Write the test examples for this rule.",
    answer: (result.responses || []).join("\n\n--- correction round ---\n\n"),
    finalRule: ruleXml,
    ruleTest: {
      status: result.status,
      error: result.error || null,
      explanation: result.explanation ?? null,
      correction: result.correction ?? null,
      verdict,
      examples: (result.examples || []).map((ex, i) => ({
        label: ex.label,
        expected: ex.expected,
        schema: ex.schema,
        xml: ex.xml,
        runnable: result.runs[i].validation.runnable,
        result: result.runs[i].result?.status ?? null,
      })),
    },
    checkContext: { ruleTest: result, analysis, ruleSchemas: schemas, standard: testCase.standard },
  };
}

async function runCaseOnce(project, aiProvider, createdBrdp, testCase) {
  if (testCase.type === "rule-test") return runRuleTestCase(project, aiProvider, createdBrdp, testCase);
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
  const selectedCases = args.only ? cases.filter((c) => c.id === args.only) : cases;
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
      const created = await createBrdp(project.id, testCase.brdp);
      brdpByCase.set(testCase.id, created);
    }

    for (const [standard, project] of projectByStandard) {
      console.log(`Computing embeddings for ${standard} project...`);
      await runEmbeddingJob(project.id);
    }

    // ---- Run each case N times ----
    for (const testCase of selectedCases) {
      const project = projectByStandard.get(testCase.standard);
      const createdBrdp = brdpByCase.get(testCase.id);
      const caseResult = { id: testCase.id, description: testCase.description, checks: testCase.checks, runs: [] };
      for (let run = 1; run <= args.runs; run++) {
        process.stdout.write(`  ${testCase.id} (run ${run}/${args.runs})... `);
        try {
          const { systemPrompt, userMessage, answer, finalRule, ruleTest, checkContext } = await runCaseOnce(project, aiProvider, createdBrdp, testCase);
          const checkResults = [];
          for (const check of testCase.checks) checkResults.push({ check, result: await runCheck(check, answer, checkContext) });
          caseResult.runs.push({ run, systemPrompt, userMessage, answer, ...(finalRule !== undefined ? { finalRule } : {}), ...(ruleTest ? { ruleTest } : {}), checkResults });
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

  writeReport(results, args.runs, { aiProvider, gitInfo, generatedAt: new Date().toISOString() });
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
    temperatures: { ask: ASK_TEMPERATURE, "suggest-definition": SUGGEST_TEMPERATURE, "suggest-proposal": SUGGEST_TEMPERATURE, "suggest-rule": SUGGEST_TEMPERATURE, "rule-test": RULE_TEST_TEMPERATURE },
    runs,
    generatedAt: meta.generatedAt,
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
    `- Temperatures: ask=${header.temperatures.ask}, suggest-definition=${header.temperatures["suggest-definition"]}, suggest-proposal=${header.temperatures["suggest-proposal"]}, suggest-rule=${header.temperatures["suggest-rule"]}, rule-test=${header.temperatures["rule-test"]}`
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
          description: c.description,
          runs: c.runs.map((r) =>
            r.error
              ? { run: r.run, error: r.error }
              : {
                  run: r.run,
                  systemPrompt: r.systemPrompt,
                  userMessage: r.userMessage,
                  answer: r.answer,
                  // Suggest Rule only: the rule as the app would save it
                  // (wrapped in the case's schema context blocks).
                  ...(r.finalRule !== undefined ? { finalRule: r.finalRule } : {}),
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
