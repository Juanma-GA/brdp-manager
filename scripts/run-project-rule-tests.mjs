#!/usr/bin/env node
// Tests every saved rule of a project with "Test rule", exactly as the panel
// does, and records each result in the app as if it had been tested by hand.
//
//   PROMPT_EVAL_EMAIL=... PROMPT_EVAL_PASSWORD=... \
//     node scripts/run-project-rule-tests.mjs --project "Official Default CMP ATA - 1000BR 4.2"
//
// Options:
//   --project "<exact name>"  required; with no exact match, the similar names
//                             are listed and nothing is tested (exit 2)
//   --all                     test every rule, also the ones whose last test
//                             passed on the same saved rule (skipped by default)
//   --only EXT-00041,EXT-00107  only these identifiers (BRDP- prefix optional)
//   --limit N                 stop after testing N rules (skipped ones do not count)
//   --parallel 2              two rules at a time (1 by default, 2 at most)
//   --lang en                 the report and the reasons in English (Spanish by default)
//   --no-retry                one attempt per rule: a Verified rule that does not
//                             pass goes to Draft without being tested again
//   PROMPT_EVAL_API_URL       the backend (http://localhost:8000 by default)
//
// It reimplements nothing: the same code and the same endpoints as the
// panel (useRuleTest.js), against the running backend --
//   analyzeRule / describeRule / thresholdMismatch (what is known without an
//   example), generateRuleTestExamples (impossible path, dossier, examples,
//   checks, correction round, Proposal check, engine), generationOutcome (the
//   record), POST .../approvals/{format}/test with ruleTestRequestBody (as the
//   panel after a new test: never "keep the previous one") and, when a
//   Verified rule fails, POST .../approvals/{format}/revoke (the stepper's
//   Verified → Draft: rule_xml kept, History "verified → draft"). Nothing is
//   written to the database directly; History shows the logged-in user.
//
// Never: promote a rule to Verified, touch a rule, a Proposal or its
// validation. A Verified rule stays Verified only when it passes ("passes"
// or "already covered by the schema"). One that does not is tested once
// more, with new examples (the AI's examples change from one generation to
// the next), and only that second attempt is recorded: if it passes the
// rule stays Verified; with any other result -- fails, review,
// inconclusive, not executable, error -- it goes to Draft. Not repeated:
// a result known without the AI (not executable), an error of the backend,
// a Draft or To Do rule, --no-retry. An error
// of the AI part (timeout, an answer that cannot be used, the Proposal check
// that could not be made) records no test but still moves it to Draft; an
// error that is not the rule's (the backend, the rule edited meanwhile)
// changes nothing; a lost session or the AI's per-day limit stops the pass
// cleanly, blaming no rule. The per-minute limit is waited out. A Draft or
// To Do rule keeps its status whatever the result.
//
// A cut connection to the backend (fetch failed, "other side closed",
// ECONNRESET, UND_ERR_SOCKET), on any request including the AI's through
// llm-proxy, is retried once (scripts/prompt-eval/session.mjs); a second
// one is an error of the backend: the rule is not touched.
//
// Report: scripts/rule-test-runs/<project>-<date>/informe.md and
// resultados.json (every example and reason, both attempts of a repeated
// rule), written after each tested rule; after skipped ones only every 25
// and never more than once a second (Windows locked the file when it was
// rewritten several times a second), and always at the end, on Ctrl+C and
// when the pass stops. The
// same project on the same day goes on in the same folder. A file that
// cannot be saved (on Windows, open in another program) is retried a few
// seconds, then written directly; if even that fails the pass goes on, says
// so in one line and tries again after the next rule.
//
// Exit codes: 0 done, 2 cannot start (credentials, backend down, project,
// role), 3 stopped before the end (AI daily limit, session lost, an
// unexpected error) or the last save of the report failed, 130 Ctrl+C.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DOMParser as XmlDomParser } from '@xmldom/xmldom';

import i18n from '../src/i18n/index.js';
import { STANDARD_TO_RULE_FORMAT } from '../src/constants/ruleFormats.js';
import { STANDARD_TO_VOCABULARY_FILE } from '../src/validation/schemaValidation.js';
import { schemaLocationOf } from '../src/utils/ruleSchemaContext.js';
import { analyzeRule, describeRule } from '../src/utils/ruleTestEngine.js';
import { thresholdMismatch } from '../src/utils/ruleThreshold.js';
import { generateRuleTestExamples } from '../src/utils/ruleTestRun.js';
import { generationOutcome, notExecutableRecord } from '../src/utils/ruleTestOutcome.js';
import { formatRuleTestReason, ruleDescriptionText } from '../src/utils/ruleTestReasons.js';
import { exampleProblems } from '../src/utils/ruleTest.js';
import { ruleXmlHash } from '../src/utils/ruleHash.js';
import { ruleTestRequestBody } from '../src/api/ruleTestRequest.js';
import { answerContent, buildRequestBody } from '../src/api/llmRequest.js';
import { isTruncatedAnswer, truncatedAnswerError } from '../src/api/llmTruncation.js';
import { RULE_PROPOSAL_CHECK_TEMPERATURE, RULE_TEST_MAX_TOKENS, RULE_TEST_TEMPERATURE } from '../src/prompts/shared.js';
import { createEvalClient, exitCleanly, LlmLimitError, LoginError, SessionLostError } from './prompt-eval/session.mjs';
import { lintRule } from './lib/ruleLint.mjs';
import {
  buildReport,
  createSaveSchedule,
  errorGoesToDraft,
  errorKind,
  findProject,
  loadResults,
  parseArgs,
  planRules,
  progressLine,
  removeLeftoverTmp,
  runDir,
  savedDirectLine,
  saveFailedLine,
  shouldRepeat,
  shouldRevoke,
  skipReason,
  writeFileAtomic,
} from './lib/projectRuleTests.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const RUNS_DIR = path.join(__dirname, 'rule-test-runs');
const API = process.env.PROMPT_EVAL_API_URL || 'http://localhost:8000';
const REVOKE_RETRY_MS = 3000;

// Remates (Windows): no exit point calls process.exit() while a request or
// a connection is open -- on Windows that aborts with "Assertion failed:
// !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c" after the
// message. Before the loop, fail() stops the script by throwing StopRun
// (the handler below sets the exit code and closes the HTTP client, and
// the process ends by itself); in and after the loop, finish() and Ctrl+C
// do the same through exitCleanly (prompt-eval/session.mjs).
class StopRun extends Error {
  constructor(code) {
    super('stop');
    this.code = code;
  }
}

function fail(message, code = 2) {
  console.error(`ERROR: ${message}`);
  throw new StopRun(code);
}

// Anything unexpected: one line, never a trace. Before the loop nothing is
// tested (exit 2); during it, what is done is saved and the pass stops
// (exit 3) -- see onUnexpected below.
let onUnexpected = (err) => {
  console.error(`ERROR: ${err?.message || String(err)}`);
  exitCleanly(2);
};
const onUncaught = (err) => (err instanceof StopRun ? exitCleanly(err.code) : onUnexpected(err));
process.on('uncaughtException', onUncaught);
process.on('unhandledRejection', onUncaught);

const opts = parseArgs(process.argv.slice(2));
if (opts.error) fail(`${opts.error}\nUsage: node scripts/run-project-rule-tests.mjs --project "<exact name>" [--all] [--only ID,ID] [--limit N] [--parallel 2] [--lang en] [--no-retry]`);
const t = i18n.getFixedT(opts.lang);
const tEn = i18n.getFixedT('en');

function xmldomParse(text) {
  const messages = [];
  const doc = new XmlDomParser({ errorHandler: (_level, msg) => messages.push(msg) }).parseFromString(text, 'text/xml');
  if (messages.length) throw new Error(String(messages[0]).replace(/^\[xmldom \w+\]\s*/, '').split('\n')[0]);
  return doc;
}

// The vocabulary the panel loads (useVocabularyCheck → public/schema-vocabulary-*.json).
function loadVocabulary(standard) {
  const file = STANDARD_TO_VOCABULARY_FILE[standard];
  if (!file) return null;
  const json = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'public', file), 'utf8'));
  return { elements: new Set(json.elements || []), attributes: new Set(json.attributes || []) };
}

// ── Start: login, project, role, rules ──────────────────────────────────
const client = createEvalClient({
  api: API,
  email: process.env.PROMPT_EVAL_EMAIL,
  password: process.env.PROMPT_EVAL_PASSWORD,
  log: (line) => console.log(line),
});
const get = (p) => client.apiFetch(p);
const enc = encodeURIComponent;

try {
  await client.login();
} catch (err) {
  if (err instanceof LoginError) fail(err.message.replace(/an admin account/, 'an account with the editor role on the project'));
  throw err;
}
const me = await get('/api/auth/me');
const projects = await get('/api/projects');
const found = findProject(projects, opts.project);
if (!found.project) {
  const list = found.similar.length ? `Similar projects:\n${found.similar.map((n) => `  - ${n}`).join('\n')}` : 'No project has a similar name.';
  fail(`No project is named exactly "${opts.project}". Nothing was tested.\n${list}`);
}
const project = found.project;
if (project.effective_role !== 'editor') {
  fail(`${me.email} has the ${project.effective_role} role on "${project.name}": recording a test and moving a rule to Draft need the editor role. Nothing was tested.`);
}
const format = STANDARD_TO_RULE_FORMAT[project.standard];
if (!format) fail(`"${project.name}" is ${project.standard}, which has no rule format: there are no rules to test.`);
const aiProvider = await get('/api/config/ai-provider');
const schemaLocation = schemaLocationOf(project.project_config, project.standard);
const vocabulary = loadVocabulary(project.standard);
const brdps = await get(`/api/projects/${project.id}/brdps`);
const approvals = await get(`/api/projects/${project.id}/approvals/${enc(format)}/export`);
const graph = await get(`/api/schema-cards/graph?standard=${enc(project.standard)}`);
const { queue, withoutRule, unmatchedOnly } = planRules(brdps, approvals, { only: opts.only });
if (unmatchedOnly.length) console.log(`WARNING: --only ${unmatchedOnly.join(',')}: no BRDP with a saved rule has that identifier.`);

// ── The run folder (the same project on the same day goes on in it) ─────
const dir = runDir(RUNS_DIR, project.name);
fs.mkdirSync(dir, { recursive: true });
const leftover = removeLeftoverTmp(dir);
if (leftover.length) console.log(`Removed ${leftover.join(', ')} left by an earlier pass.`);
let previous = null;
try {
  previous = loadResults(dir);
} catch (err) {
  // A half-written resultados.json (a direct write cut off): kept aside, a
  // new one is started. informe.md is rebuilt from it.
  const aside = path.join(dir, `resultados.unreadable-${Date.now()}.json`);
  fs.renameSync(path.join(dir, 'resultados.json'), aside);
  console.log(`WARNING: resultados.json could not be read (${err.message}); kept as ${path.basename(aside)} and a new one is started.`);
}
const results = previous || { project: { id: project.id, name: project.name, standard: project.standard, format }, runs: [], entries: [] };
results.without_rule = withoutRule;
const run = {
  started_at: new Date().toISOString(),
  finished_at: null,
  user: me.email,
  provider: `${aiProvider.provider} / ${aiProvider.model}`,
  options: { all: opts.all, only: opts.only, limit: opts.limit, parallel: opts.parallel, no_retry: opts.noRetry },
  stopped: null,
};
results.runs.push(run);
const reportFile = path.join(dir, 'informe.md');
const jsonFile = path.join(dir, 'resultados.json');
// → true when both files are saved. A failure is said in one line and the
// next save (after the next rule) writes them again.
let lastSaveFailed = null; // the files of the last save that failed
const saveSchedule = createSaveSchedule();
function save() {
  saveSchedule.saved();
  const failed = [];
  for (const [file, text] of [
    [jsonFile, () => `${JSON.stringify(results, null, 2)}\n`],
    [reportFile, () => `${buildReport(results, { lang: opts.lang })}\n`],
  ]) {
    const res = writeFileAtomic(file, text());
    if (!res.ok) {
      failed.push(path.basename(file));
      console.log(saveFailedLine(file, res.code || res.error, opts.lang));
    } else if (res.direct) console.log(savedDirectLine(file, res.renameError, opts.lang));
  }
  lastSaveFailed = failed.length ? failed : null;
  return !lastSaveFailed;
}

console.log(`Project: ${project.name} (${project.standard}, ${format}) -- user ${me.email}, AI ${run.provider}`);
console.log(`${queue.length} rule(s) to go through${opts.all ? '' : ' (the ones whose last test passed on the same rule are skipped)'}; ${withoutRule} BRDP(s) without a saved rule.`);
console.log(`Report: ${reportFile}`);
save();

// ── One rule, as the panel ───────────────────────────────────────────────
const LLM = (temperature, maxTokens) => async (messages, systemPrompt) => {
  const res = await client.llmProxy(buildRequestBody(aiProvider.provider, messages, systemPrompt, temperature, maxTokens));
  if (isTruncatedAnswer(aiProvider.provider, res)) throw truncatedAnswerError();
  return answerContent(aiProvider.provider, res);
};

function examplesOf(result) {
  if (!result?.examples) return [];
  return result.examples.map((ex, i) => {
    const run = result.runs?.[i];
    return {
      label: ex.label,
      expected: ex.expected,
      schema: ex.schema ?? null,
      xml: ex.xml ?? null,
      ...(Array.isArray(ex.files) ? { files: ex.files.map((f) => ({ path: f.path, xml: f.xml ?? f.content })) } : {}),
      runnable: Boolean(run?.validation?.runnable),
      problems: run?.validation && !run.validation.runnable ? exampleProblems(run.validation, { standard: project.standard, schema: ex.schema }) : [],
      result: run?.result?.status ?? null,
      matches: run?.matches ?? null,
    };
  });
}

async function postRevoke(brdpId) {
  const res = await client.rawFetch(`/api/projects/${project.id}/brdps/${brdpId}/approvals/${enc(format)}/revoke`, { method: 'POST' });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
}

// Verified → Draft (the stepper's Revoke). A network failure: once more,
// then the report says it is to be done by hand. With no test recorded (an
// error), the saved rule is read again first: one edited during the test is
// not this rule any more, and is left alone.
async function toDraft(brdpId, fields, { noTestRecorded = false, ruleHash = null } = {}) {
  if (noTestRecorded) {
    const now = await get(`/api/projects/${project.id}/brdps/${brdpId}/approvals/${enc(format)}`);
    if (!now?.rule_xml || ruleXmlHash(now.rule_xml) !== ruleHash) return { ...fields, draft_skipped: 'rule_changed' };
    if (now.status !== 'approved') return fields;
  }
  const moved = { ...fields, moved_to_draft: true, status_after: 'pending_review', ...(noTestRecorded ? { no_test_recorded: true } : {}) };
  try {
    await postRevoke(brdpId);
    return moved;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, REVOKE_RETRY_MS));
    try {
      await postRevoke(brdpId);
      return moved;
    } catch (err) {
      // A revoke done but whose answer was lost (a cut connection retried):
      // the rule is Draft already.
      if (await isDraftNow(brdpId)) return moved;
      return { ...fields, moved_to_draft: false, revoke_failed: err.message };
    }
  }
}

async function isDraftNow(brdpId) {
  try {
    const now = await get(`/api/projects/${project.id}/brdps/${brdpId}/approvals/${enc(format)}`);
    return now?.status === 'pending_review';
  } catch {
    return false;
  }
}

// An error of this rule's test: a Verified rule goes to Draft with no test
// recorded when the error is the AI's; one of the backend changes nothing.
async function errorEntry(brdpId, approval, ruleHash, fields) {
  if (!shouldRevoke('error', approval?.status)) return fields;
  if (!errorGoesToDraft(fields.error)) return { ...fields, draft_skipped: 'backend_error' };
  return toDraft(brdpId, fields, { noTestRecorded: true, ruleHash });
}

// One generation of examples and its outcome, not recorded yet.
//   → { kind: 'record', record, details, deterministic }
//   | { kind: 'error', fields }
// deterministic: the result is known without the AI (not executable, an
// impossible path) -- the same again if repeated.
async function attemptTest(ruleXml, brdp, analysis, description, threshold) {
  const known = notExecutableRecord(analysis);
  if (known) return { kind: 'record', record: known, details: { examples: [], proposal_check: null, correction: null }, deterministic: true };
  const result = await generateRuleTestExamples({
    ruleXml,
    format,
    standard: project.standard,
    schemaLocation,
    brdp,
    vocabulary,
    ask: LLM(RULE_TEST_TEMPERATURE, RULE_TEST_MAX_TOKENS),
    fetchSchemaCards: (standard, names) => get(`/api/schema-cards?standard=${enc(standard)}&names=${enc(names.join(','))}`),
    fetchStructure: (standard, schema) => get(`/api/schema-cards/structure?standard=${enc(standard)}&schema=${enc(schema)}`),
    fetchSchemaAttribute: (standard, name) => get(`/api/schema-cards/attribute?standard=${enc(standard)}&name=${enc(name)}`),
    fetchSchemaGraph: async () => graph,
    parseXml: xmldomParse,
    ruleDescription: ruleDescriptionText(description, tEn),
    askProposalCheck: LLM(RULE_PROPOSAL_CHECK_TEMPERATURE, undefined),
  });
  // The AI's daily limit or a lost session: nothing of this rule is
  // recorded, the pass stops.
  if (client.lost) throw client.lost;
  const record = generationOutcome(result, { analysis, threshold, proposal: brdp.proposal }).record;
  const details = {
    examples: examplesOf(result),
    proposal_check: result?.proposalCheck ? { status: result.proposalCheck.status, reason: result.proposalCheck.reason ?? null, error: result.proposalCheck.error ?? null } : null,
    correction: result?.correction ?? null,
  };
  if (!record) {
    const message = result?.truncated ? 'the AI answer was cut by its length limit' : result?.error || 'no result';
    return { kind: 'error', fields: { result: 'error', error: message, error_kind: errorKind(message), ...details } };
  }
  // The Proposal check could not be made (timeout, an unreadable answer):
  // the panel shows "Review: the Proposal could not be checked"; unattended,
  // that is an error of the run -- no test recorded, but a Verified rule
  // still goes to Draft.
  if (record.reason?.code === 'test_proposal_unchecked') {
    const message = `the Proposal check could not be made: ${record.reason.params?.error || ''}`.trim();
    return { kind: 'error', fields: { result: 'error', error: message, error_kind: errorKind(message), ...details } };
  }
  const deterministic = result?.status === 'not_executable' || result?.status === 'path_review';
  return { kind: 'record', record, details, deterministic };
}

// What an attempt is, for the entry and for shouldRepeat.
function attemptSummary(a) {
  if (a.kind === 'error') return { ...a.fields };
  const { record } = a;
  return { result: record.result, reason: record.reason, reason_text: record.reason ? formatRuleTestReason(record.reason, t) : '', ...a.details, ...(a.deterministic ? { deterministic: true } : {}) };
}

async function testRule(item) {
  const { brdp } = item;
  const startedAt = Date.now();
  const entry = { identifier: brdp.identifier, brdp_id: brdp.id, title: brdp.title, run: run.started_at, at: new Date().toISOString() };
  const done = (fields) => ({ ...entry, ...fields, duration_ms: Date.now() - startedAt });
  // The saved rule as it is now (another person may have changed it).
  const approval = await get(`/api/projects/${project.id}/brdps/${brdp.id}/approvals/${enc(format)}`);
  const ruleXml = approval?.rule_xml || '';
  if (!ruleXml.trim()) return done({ result: 'error', error: 'the rule was removed meanwhile', status_before: null, status_after: null });
  entry.status_before = approval.status;
  entry.status_after = approval.status;
  entry.rule_hash = ruleXmlHash(ruleXml);
  entry.lint = lintRule(ruleXml, format, { graph: graph?.available ? graph : false }).map(({ kind, detail, known }) => ({ kind, detail, known: Boolean(known) }));
  if (skipReason(approval, { all: opts.all })) return done({ result: 'skipped', duration_ms: 0 });

  const analysis = analyzeRule(ruleXml, format, { parseXml: xmldomParse, standard: project.standard });
  const description = describeRule(ruleXml, format, { parseXml: xmldomParse, schemaLocation });
  const threshold = thresholdMismatch(ruleXml, format, brdp.proposal, { parseXml: xmldomParse });
  // A Verified rule that does not pass is tested once more before it goes
  // to Draft; only the last attempt is recorded (shouldRepeat).
  const attempts = [await attemptTest(ruleXml, brdp, analysis, description, threshold)];
  if (shouldRepeat(attemptSummary(attempts[0]), approval.status, { noRetry: opts.noRetry })) {
    attempts.push(await attemptTest(ruleXml, brdp, analysis, description, threshold));
  }
  const final = attempts[attempts.length - 1];
  // Both attempts in resultados.json; the top-level fields are the last one's.
  const withAttempts = (fields, recorded) =>
    attempts.length > 1 ? { ...fields, attempts: attempts.map((a, i) => ({ ...attemptSummary(a), recorded: i === attempts.length - 1 && recorded })) } : fields;

  if (final.kind === 'error') return done(await errorEntry(brdp.id, approval, entry.rule_hash, withAttempts(final.fields, false)));
  const { record, details } = final;
  const res = await client.rawFetch(`/api/projects/${project.id}/brdps/${brdp.id}/approvals/${enc(format)}/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ruleTestRequestBody(ruleXml, record)),
  });
  if (!res.ok) {
    const body = await res.text();
    const changed = res.status === 409;
    const why = changed ? 'the rule changed during the test; nothing recorded' : `recording the test failed (HTTP ${res.status}: ${body})`;
    const fields = withAttempts({ result: 'error', error: why, error_kind: why, ...details }, false);
    // Neither is the rule's fault: its status is left as it is.
    if (shouldRevoke('error', approval.status)) fields.draft_skipped = changed ? 'rule_changed' : 'backend_error';
    return done(fields);
  }
  const fields = withAttempts({ result: record.result, reason: record.reason, reason_text: record.reason ? formatRuleTestReason(record.reason, t) : '', ...details }, true);
  if (shouldRevoke(record.result, approval.status)) return done(await toDraft(brdp.id, fields));
  return done(fields);
}

// ── The loop ─────────────────────────────────────────────────────────────
// closed: the pass has ended (finish() ran, or Ctrl+C twice) -- a rule
// still in flight is not added to the report and nothing more is saved.
let closed = false;
let next = 0;
let tested = 0;
let finished = 0;
let stopping = null; // why no new rule is taken
const processed = new Set();

process.on('SIGINT', () => {
  if (stopping === 'Ctrl+C') {
    if (closed) return;
    closed = true;
    run.stopped = 'Ctrl+C';
    results.pending = queue.filter((q) => !processed.has(q.brdp.identifier)).map((q) => q.brdp.identifier);
    const saved = save();
    console.log(`\nStopped now. What is done stays in the app${saved ? ' and the report' : ` (the report could not be saved: ${lastSaveFailed.join(', ')})`}.`);
    // The requests in flight are stopped (abort), never left closing.
    exitCleanly(130, { abort: true });
    return;
  }
  stopping = 'Ctrl+C';
  console.log('\nStopping after the rule(s) in progress... (Ctrl+C again to stop now)');
});

// An unexpected error in the loop itself: one line with the rule it was
// on, what is done is saved, and the pass stops (exit 3).
let unexpected = null;
function stopUnexpected(err, identifier) {
  if (unexpected) return;
  unexpected = `${identifier ? `${identifier}: ` : ''}${err?.message || String(err)}`;
  if (!stopping) stopping = `unexpected error (${unexpected})`;
}

async function worker() {
  while (!stopping) {
    if (opts.limit && tested >= opts.limit) return;
    if (next >= queue.length) return;
    const index = next + 1;
    const item = queue[next];
    next += 1;
    try {
      let entry;
      try {
        entry = await testRule(item);
      } catch (err) {
        if (err instanceof LlmLimitError || err instanceof SessionLostError) {
          if (!stopping) stopping = err.message;
          return;
        }
        // The backend (fetching the rule, recording): not the rule's fault,
        // nothing changes.
        entry = { identifier: item.brdp.identifier, brdp_id: item.brdp.id, run: run.started_at, at: new Date().toISOString(), result: 'error', error: err.message, error_kind: errorKind(err.message) };
      }
      if (closed) return;
      if (entry.result !== 'skipped') tested += 1;
      finished += 1;
      processed.add(item.brdp.identifier);
      results.entries.push(entry);
      // Every tested rule; skipped ones only now and then (createSaveSchedule).
      if (saveSchedule.after(entry, { isLast: next >= queue.length })) save();
      console.log(progressLine(index, queue.length, entry, opts.lang));
    } catch (err) {
      stopUnexpected(err, item.brdp.identifier);
      return;
    }
  }
}

const startedAt = Date.now();
onUnexpected = (err) => {
  stopUnexpected(err, null);
  finish();
};
await Promise.all(Array.from({ length: Math.min(opts.parallel, Math.max(queue.length, 1)) }, worker));

finish();

function finish() {
  if (closed) return;
  closed = true;
  const remaining = queue.filter((q) => !processed.has(q.brdp.identifier)).map((q) => q.brdp.identifier);
  run.finished_at = new Date().toISOString();
  if (stopping) run.stopped = stopping;
  else if (opts.limit && remaining.length) run.stopped = `--limit ${opts.limit}`;
  results.pending = remaining;
  const saved = save();

  const latestRun = results.entries.filter((e) => e.run === run.started_at);
  const by = (r) => latestRun.filter((e) => e.result === r).length;
  console.log('');
  console.log(
    `Done in ${Math.round((Date.now() - startedAt) / 1000)} s: ${finished} rule(s) -- passed ${by('passed') + by('schema_covered')}, failed ${by('failed')}, review ${by('review')}, inconclusive ${by('inconclusive')}, not executable ${by('not_executable')}, error ${by('error')}, skipped ${by('skipped')}; moved to Draft ${latestRun.filter((e) => e.moved_to_draft).length}.`
  );
  const manual = latestRun.filter((e) => e.revoke_failed);
  if (manual.length) console.log(`To move to Draft by hand (the request failed twice): ${manual.map((e) => e.identifier).join(', ')}`);
  console.log(`Report: ${reportFile}`);
  if (unexpected) {
    console.log(
      `\nSTOPPED by an unexpected error at ${unexpected}\n${remaining.length} rule(s) not tested. What is done is recorded in the app${saved ? ' and in the report' : ''}. ` +
        'To go on, run the same command again: the rules whose last test passed are skipped.'
    );
  } else if (stopping && stopping !== 'Ctrl+C') {
    console.log(
      `\nSTOPPED: ${stopping}\n${remaining.length} rule(s) not tested. What is done is recorded in the app and in the report. ` +
        'To go on, run the same command again when the limit allows it: the rules whose last test passed are skipped.'
    );
  }
  if (!saved) {
    console.log(
      `\nTHE REPORT IS NOT UP TO DATE: the last save of ${lastSaveFailed.join(' and ')} failed (see above). What was tested is recorded in the app; close the file and run the same command again to rebuild the report.`
    );
    exitCleanly(3);
    return;
  }
  if (unexpected || (stopping && stopping !== 'Ctrl+C')) exitCleanly(3);
  else if (stopping === 'Ctrl+C') exitCleanly(130);
  else exitCleanly(0);
}
