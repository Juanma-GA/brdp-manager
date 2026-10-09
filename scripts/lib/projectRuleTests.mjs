// The network-free part of scripts/run-project-rule-tests.mjs (every rule of
// a project through "Test rule"): the options, which project and which
// rules, which rules are skipped, which go to Draft, the run folder and the
// report. Pure, so scripts/test-project-rule-tests.mjs checks it without a
// backend.
import fs from 'node:fs';
import path from 'node:path';

export const MAX_PARALLEL = 2;

// ── Options ──────────────────────────────────────────────────────────────
// → { project, all, only, limit, parallel, lang } or { error }
export function parseArgs(argv) {
  const opts = { project: null, all: false, only: [], limit: null, parallel: 1, lang: 'es' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${arg} needs a value`);
      i += 1;
      return v;
    };
    try {
      if (arg === '--project') opts.project = value();
      else if (arg === '--all') opts.all = true;
      else if (arg === '--only')
        opts.only = value()
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
      else if (arg === '--limit') {
        const n = Number(value());
        if (!Number.isInteger(n) || n < 1) return { error: '--limit must be a whole number of 1 or more' };
        opts.limit = n;
      } else if (arg === '--parallel') {
        const n = Number(value());
        if (!Number.isInteger(n) || n < 1 || n > MAX_PARALLEL) return { error: `--parallel must be 1 or ${MAX_PARALLEL}` };
        opts.parallel = n;
      } else if (arg === '--lang') {
        const l = value();
        if (l !== 'es' && l !== 'en') return { error: '--lang must be es or en' };
        opts.lang = l;
      } else return { error: `unknown option ${arg}` };
    } catch (err) {
      return { error: err.message };
    }
  }
  if (!opts.project) return { error: '--project "<exact project name>" is required' };
  return opts;
}

// ── The project ──────────────────────────────────────────────────────────
const norm = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();

// Exact name only (never a guess: the script writes in that project). With
// no exact match, the projects whose name looks like it (contains it, is
// contained in it, or shares a word of 3+ characters with a letter in it --
// a version such as "4.2" alone is not a likeness).
//   → { project } | { similar: [names] }
export function findProject(projects, name) {
  const project = projects.find((p) => p.name === name);
  if (project) return { project };
  const wanted = norm(name).trim();
  const words = new Set(wanted.split(/[^\p{L}\p{N}.]+/u).filter((w) => w.length >= 3 && /\p{L}/u.test(w)));
  const similar = projects
    .filter((p) => {
      const n = norm(p.name);
      if (!wanted) return false;
      if (n.includes(wanted) || wanted.includes(n)) return true;
      return n.split(/[^\p{L}\p{N}.]+/u).some((w) => words.has(w));
    })
    .map((p) => p.name)
    .sort((a, b) => a.localeCompare(b));
  return { similar };
}

// ── The rules ────────────────────────────────────────────────────────────
export const compareIdentifiers = (a, b) => String(a).localeCompare(String(b), 'en', { numeric: true, sensitivity: 'base' });

// --only EXT-00041 matches BRDP-EXT-00041 (and the full identifier itself).
export function matchesOnly(identifier, tokens) {
  if (!tokens || tokens.length === 0) return true;
  const id = String(identifier).toUpperCase();
  return tokens.some((t) => {
    const tok = String(t).toUpperCase();
    return id === tok || id.endsWith(`-${tok}`);
  });
}

// The project's BRDPs (GET .../brdps, active only) and its rules (GET
// .../approvals/{format}/export) → the rules to go through, ordered by ID,
// and how many BRDPs have no saved rule. A rule of a BRDP that is not in
// the list (in the Trash) is never tested.
//   → { queue: [{ brdp, status }], withoutRule, unmatchedOnly: [tokens] }
export function planRules(brdps, approvals, { only = [] } = {}) {
  const byId = new Map((approvals || []).map((a) => [a.brdp_id, a]));
  const queue = [];
  let withoutRule = 0;
  for (const brdp of brdps || []) {
    const a = byId.get(brdp.id);
    if (!a || !String(a.rule_xml || '').trim()) {
      withoutRule += 1;
      continue;
    }
    if (!matchesOnly(brdp.identifier, only)) continue;
    queue.push({ brdp, status: a.status });
  }
  queue.sort((x, y) => compareIdentifiers(x.brdp.identifier, y.brdp.identifier));
  const unmatchedOnly = (only || []).filter((t) => !queue.some((q) => matchesOnly(q.brdp.identifier, [t])));
  return { queue, withoutRule, unmatchedOnly };
}

// Skipped by default: the last recorded test passed, on the SAME saved rule
// (last_test_up_to_date: the backend compares the tested rule's hash with
// the saved rule_xml). A rule edited after it passed is tested again.
export function skipReason(approval, { all = false } = {}) {
  if (all || !approval) return null;
  return approval.last_test_result === 'passed' && approval.last_test_up_to_date === true ? 'passed' : null;
}

// Only a failed test moves a rule, and only a Verified one, to Draft.
// "Not executable", "review", "inconclusive", "error" and a pass never
// change the Rule Status (a Draft that passes stays Draft: nothing is ever
// promoted to Verified).
export function shouldRevoke(record, ruleStatus) {
  return Boolean(record && record.result === 'failed' && ruleStatus === 'approved');
}

// What to report for a run that recorded nothing: why it failed, short.
export function errorKind(message) {
  const m = String(message || '');
  if (/llm_timeout|-> 504\b/.test(m)) return 'timeout';
  return m;
}

// ── The run folder ───────────────────────────────────────────────────────
// A name that is valid on Windows too (no <>:"/\|?* nor control
// characters, no trailing dot or space).
export function folderSlug(projectName) {
  return (
    String(projectName)
      // eslint-disable-next-line no-control-regex
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-.]+|[-. ]+$/g, '') || 'project'
  );
}

export function localDate(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

// The same project on the same day goes on in the same folder; another day,
// a new one.
export function runDir(baseDir, projectName, date = new Date()) {
  return path.join(baseDir, `${folderSlug(projectName)}-${localDate(date)}`);
}

export function loadResults(dir) {
  const file = path.join(dir, 'resultados.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Written to a temporary file first and then renamed: a Ctrl+C or a crash
// never leaves half a file.
export function writeFileAtomic(file, text) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

// ── The report ───────────────────────────────────────────────────────────
// The latest result of each rule in the folder. A "skipped" entry (its last
// test passed) never hides a real result of an earlier pass in the same
// folder; only its Rule Status, read later, is kept. A rule a pass of the
// folder moved to Draft stays "moved to Draft" (a later pass finds it Draft
// already), and a revoke that failed and was done by a later pass is no
// longer to be done by hand.
export function latestEntries(entries) {
  const map = new Map();
  for (const e of entries || []) {
    const prev = map.get(e.identifier);
    let next = e.result === 'skipped' && prev && prev.result !== 'skipped' ? { ...prev, status_after: e.status_after } : e;
    if (prev?.moved_to_draft && !next.moved_to_draft) next = { ...next, moved_to_draft: true };
    if (next.moved_to_draft && next.revoke_failed) next = { ...next, revoke_failed: null };
    map.set(e.identifier, next);
  }
  return [...map.values()].sort((a, b) => compareIdentifiers(a.identifier, b.identifier));
}

export const RESULT_LABELS = {
  es: {
    passed: 'pasa',
    schema_covered: 'pasa (el esquema ya lo incluye)',
    failed: 'falla',
    review: 'revisar',
    inconclusive: 'no concluyente',
    not_executable: 'no ejecutable',
    error: 'error',
    skipped: 'saltada',
  },
  en: {
    passed: 'passes',
    schema_covered: 'passes (already covered by the schema)',
    failed: 'fails',
    review: 'review',
    inconclusive: 'inconclusive',
    not_executable: 'not executable',
    error: 'error',
    skipped: 'skipped',
  },
};

const PASSING = new Set(['passed', 'schema_covered']);
export const isPassing = (result) => PASSING.has(result);

// The progress line: «[37/461] BRDP-EXT-00041 FALLA → Draft (1 min 12 s)».
export function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function progressLine(index, total, entry, lang = 'es') {
  const labels = RESULT_LABELS[lang];
  let label = labels[entry.result] || entry.result;
  if (entry.result === 'error') label = `${label}: ${entry.error_kind || entry.error || ''}`.trim();
  let line = `[${index}/${total}] ${entry.identifier} ${label.toUpperCase()}`;
  if (entry.moved_to_draft) line += ' → Draft';
  if (entry.revoke_failed) line += lang === 'es' ? ' (NO se pudo pasar a Draft: hazlo a mano)' : ' (could NOT be moved to Draft: do it by hand)';
  if (entry.result !== 'skipped') line += ` (${formatDuration(entry.duration_ms || 0)})`;
  return line;
}

const cell = (s) =>
  String(s ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\s+/g, ' ')
    .trim();

const statusLabel = (status) => (status === 'approved' ? 'Verified' : status === 'pending_review' ? 'Draft' : status || '—');

// The findings of scripts/lib/ruleLint.mjs (the same lint as
// backend/scripts/lint_stored_rules.py); the known and accepted ones
// (doc(), @@...@@, nonContextRule, informative flag 2) marked as such.
function lintCell(lint, es) {
  const items = (lint || []).map((f) => `${f.known ? (es ? '(conocido) ' : '(known) ') : ''}${f.kind}: ${f.detail}`);
  return items.length ? items.join('; ') : '—';
}

// results: the resultados.json object ({ project, runs, entries }).
// → the informe.md text. Everything a person needs to act on comes first:
// the totals, then the rules that do NOT pass with their reason (and what
// the stored-rules lint already said), then the ones that pass but are
// still Draft, then the rest.
export function buildReport(results, { lang = 'es' } = {}) {
  const es = lang === 'es';
  const L = RESULT_LABELS[lang];
  const latest = latestEntries(results.entries);
  const count = (r) => latest.filter((e) => e.result === r).length;
  const movedToDraft = latest.filter((e) => e.moved_to_draft).length;
  const out = [];
  const p = results.project;
  out.push(es ? `# Prueba de todas las reglas — ${p.name}` : `# Every rule tested — ${p.name}`);
  out.push('');
  out.push(`- ${es ? 'Proyecto' : 'Project'}: ${p.name} (${p.standard}, ${p.format})`);
  for (const run of results.runs || []) {
    const opts = [run.options?.all ? '--all' : null, run.options?.only?.length ? `--only ${run.options.only.join(',')}` : null, run.options?.limit ? `--limit ${run.options.limit}` : null, run.options?.parallel > 1 ? `--parallel ${run.options.parallel}` : null]
      .filter(Boolean)
      .join(' ');
    const end = run.finished_at ? run.finished_at : es ? 'sin terminar' : 'not finished';
    const stop = run.stopped ? ` — ${es ? 'parada' : 'stopped'}: ${run.stopped}` : '';
    out.push(`- ${es ? 'Pasada' : 'Pass'}: ${run.started_at} → ${end}, ${es ? 'usuario' : 'user'} ${run.user}${opts ? `, ${opts}` : ''}${stop}`);
  }
  if (results.without_rule != null) out.push(`- ${es ? 'BRDP sin regla guardada (no se prueban)' : 'BRDPs without a saved rule (not tested)'}: ${results.without_rule}`);
  out.push('');
  out.push(es ? '## Totales' : '## Totals');
  out.push('');
  out.push(es ? '| Resultado | Reglas |' : '| Result | Rules |');
  out.push('|---|---|');
  for (const r of ['passed', 'schema_covered', 'failed', 'review', 'inconclusive', 'not_executable', 'error', 'skipped']) {
    out.push(`| ${L[r]} | ${count(r)} |`);
  }
  out.push(`| ${es ? 'pasadas a Draft' : 'moved to Draft'} | ${movedToDraft} |`);
  out.push('');

  const notPassing = latest.filter((e) => !isPassing(e.result) && e.result !== 'skipped');
  out.push(es ? `## Reglas que no pasan (${notPassing.length})` : `## Rules that do not pass (${notPassing.length})`);
  out.push('');
  if (notPassing.length === 0) out.push(es ? 'Ninguna.' : 'None.');
  else {
    out.push(es ? '| BRDP | Resultado | A Draft | Motivo | Lint de reglas guardadas |' : '| BRDP | Result | To Draft | Reason | Stored-rules lint |');
    out.push('|---|---|---|---|---|');
    for (const e of notPassing) {
      const draft = e.moved_to_draft ? (es ? 'sí' : 'yes') : e.revoke_failed ? (es ? `NO: ${e.revoke_failed} (hazlo a mano)` : `NO: ${e.revoke_failed} (do it by hand)`) : '—';
      const reason = e.result === 'error' ? e.error : e.reason_text;
      out.push(`| ${cell(e.identifier)} | ${cell(L[e.result] || e.result)} | ${cell(draft)} | ${cell(reason || '—')} | ${cell(lintCell(e.lint, es))} |`);
    }
  }
  out.push('');

  // A skipped rule passed before (its last test passed on the same rule).
  const draftPassing = latest.filter((e) => (isPassing(e.result) || e.result === 'skipped') && e.status_after === 'pending_review');
  out.push(es ? `## Pasan pero siguen en Draft (${draftPassing.length})` : `## Pass but still Draft (${draftPassing.length})`);
  out.push('');
  if (draftPassing.length === 0) out.push(es ? 'Ninguna.' : 'None.');
  else for (const e of draftPassing) out.push(`- ${e.identifier}${e.result === 'schema_covered' ? ` (${L.schema_covered})` : e.result === 'skipped' ? ` (${es ? 'saltada: ya había pasado' : 'skipped: it had passed already'})` : ''}`);
  out.push('');

  const passing = latest.filter((e) => isPassing(e.result));
  out.push(es ? `## Pasan (${passing.length})` : `## Pass (${passing.length})`);
  out.push('');
  if (passing.length === 0) out.push(es ? 'Ninguna.' : 'None.');
  else for (const e of passing) out.push(`- ${e.identifier} — ${statusLabel(e.status_after)}${e.result === 'schema_covered' ? ` (${L.schema_covered})` : ''}`);
  out.push('');

  const skipped = latest.filter((e) => e.result === 'skipped');
  if (skipped.length) {
    out.push(es ? `## Saltadas (${skipped.length}): su última prueba pasó con la misma regla` : `## Skipped (${skipped.length}): their last test passed on the same rule`);
    out.push('');
    out.push(skipped.map((e) => e.identifier).join(', '));
    out.push('');
  }
  const pending = results.pending || [];
  if (pending.length) {
    out.push(es ? `## Sin probar en la última pasada (${pending.length})` : `## Not tested in the last pass (${pending.length})`);
    out.push('');
    out.push(pending.join(', '));
    out.push('');
  }
  return out.join('\n');
}
