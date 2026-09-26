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

import { buildAskSystemPrompt } from "../src/prompts/askPrompt.js";
import { buildSuggestDefinitionPrompt } from "../src/prompts/suggestDefinitionPrompt.js";
import { buildSuggestProposalPrompt } from "../src/prompts/suggestProposalPrompt.js";
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

function runCheck(check, answer) {
  const flags = check.flags || "";
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

async function sendToLlm(aiProvider, systemPrompt, userMessage) {
  const payload =
    aiProvider.provider === "Anthropic"
      ? { model: aiProvider.model, max_tokens: 4000, temperature: 1, system: systemPrompt, messages: [{ role: "user", content: userMessage }] }
      : {
          model: aiProvider.model,
          max_tokens: 4000,
          temperature: 1,
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
  const answer = await sendToLlm(aiProvider, systemPrompt, testCase.question);
  return { systemPrompt, userMessage: testCase.question, answer };
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
  const answer = await sendToLlm(aiProvider, systemPrompt, userMessage);
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
  const answer = await sendToLlm(aiProvider, systemPrompt, userMessage);
  return { systemPrompt, userMessage, answer };
}

async function runCaseOnce(project, aiProvider, createdBrdp, testCase) {
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
  console.log(`Provider: ${aiProvider.provider} / ${aiProvider.model}`);

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
        await createBrdp(project.id, ref);
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
          const { systemPrompt, userMessage, answer } = await runCaseOnce(project, aiProvider, createdBrdp, testCase);
          const checkResults = testCase.checks.map((check) => ({ check, result: runCheck(check, answer) }));
          caseResult.runs.push({ run, systemPrompt, userMessage, answer, checkResults });
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

  writeReport(results, args.runs);
}

function writeReport(results, runs) {
  fs.mkdirSync(REPORT_DIR, { recursive: true });

  const lines = [];
  lines.push(`# Prompt eval report`);
  lines.push("");
  lines.push(`Generated ${new Date().toISOString()}, ${runs} run(s) per case.`);
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
      results.map((c) => ({
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
                checks: r.checkResults.map((cr) => ({ type: cr.check.type, ...cr.result })),
              }
        ),
      })),
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
