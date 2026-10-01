// AI Extract (1/2): the prompt that writes the missing texts and the batch
// drafter, with real candidates read from the two BREX fixtures
// (scripts/rule-test-fixtures/extract-candidates.json, written by
// backend/scripts/dump_rule_extract_fixture.py). No backend, no LLM: `ask`
// is a fake.
//
//     node scripts/test-rule-extract.mjs
import { readFileSync } from 'node:fs';
import { buildExtractFromRulesPrompt, EXTRACT_USER_MESSAGE, parseExtractFromRulesResponse } from '../src/prompts/extractFromRulesPrompt.js';
import { candidatesToDraft, draftCandidates } from '../src/utils/ruleExtractDraft.js';
import { LLM_TRUNCATED } from '../src/api/llmTruncation.js';

const fixture = JSON.parse(readFileSync(new URL('./rule-test-fixtures/extract-candidates.json', import.meta.url), 'utf-8'));
let failures = 0;
let checks = 0;
function check(name, ok, detail = '') {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.error(`FAIL ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}

const catalog = (id, extra = {}) => ({ ...fixture[id], classification: 'catalog', title: `T ${id}`, definition: `D ${id}`, draft_status: 'pending', ...extra });
const fresh = (id, extra = {}) => ({ ...fixture[id], classification: 'new_ext', title: '', definition: '', draft_status: 'pending', ...extra });

// ── Prompt ────────────────────────────────────────────────────────────────
{
  // The fixture's candidates carry the backend's set_texts: S1-00117 (new
  // EXT with a nonContextRule) asks only the Title; S1-00052 (catalog, only
  // executable rules) only the Proposal; BREX-S1-00242 (default BREX rule) all.
  const prompt = buildExtractFromRulesPrompt({
    standard: 'S1000D 4.2',
    ruleFormat: 'BREX-4.2',
    candidates: [fixture['BRDP-S1-00117'], fixture['BRDP-S1-00052'], fixture['BREX-S1-00242']],
  });
  check('prompt names the standard', prompt.includes('uses S1000D 4.2.'));
  check('no placeholders asked', prompt.includes('No placeholders, no brackets to fill in'));
  check('literal texts given, not rewritten', prompt.includes('Proposal (from the file, do not rewrite): Captions shall not be used.')
    && prompt.includes('Definition (from the file, do not rewrite): Decide whether inline captions affect'));
  check('literal texts: only the title', /BRDP-S1-00117[\s\S]*?Write: title\n/.test(prompt));
  check('catalog texts given, not rewritten', prompt.includes('Title (official, do not rewrite): Information codes'));
  check('catalog: only the proposal', /BRDP-S1-00052[\s\S]*?Write: proposal\n/.test(prompt));
  check('default BREX rule: title, definition and proposal', /BREX-S1-00242[\s\S]*?Write: title, definition, proposal/.test(prompt));
  check('default BREX rule named as such', prompt.includes('This is a rule of the S1000D default BREX, not a project decision'));
  check('decision text shown, not as the Proposal source when given', prompt.includes('Decision text in the file (nonContextRule):\n'));
  check('rule summary instead of XML', prompt.includes('- //caption — prohibited') && !prompt.includes('<structureObjectRule'));
  check('values of an objectValue rule listed', /\/\/@updateReasonType — allowed[^\n]*values: urt01, urt02/.test(prompt));
}
{
  // S1-00007: 4,500 rules → the compact summary, never 4,500 lines.
  const prompt = buildExtractFromRulesPrompt({ standard: 'S1000D 4.2', ruleFormat: 'BREX-4.2', candidates: [catalog('BRDP-S1-00007')] });
  check('big candidate: count and flags', prompt.includes('4500 rule(s): 4500 prohibited'));
  check('big candidate: first 10 paths', (prompt.match(/\n {2}- \/dmodule/g) || []).length === 10);
  check('big candidate: most repeated objectUse', prompt.includes('Most repeated objectUse (4500 rules)'));
  check('big candidate: prompt stays small', prompt.length < 8000, String(prompt.length));
}
{
  // S1-00052: two 10,000-character paths that list information codes as
  // predicates. The path is cut with an explicit marker; the codes it
  // compares are listed in full.
  const prompt = buildExtractFromRulesPrompt({ standard: 'S1000D 4.2', ruleFormat: 'BREX-4.2', candidates: [catalog('BRDP-S1-00052')] });
  check('long path cut with a marker, never silently', /… \[\d+ more characters\]/.test(prompt));
  const allowed = prompt.split('\n').find((l) => l.includes('the path compares @infoCode') && l.includes('930'));
  check('allowed codes listed in full, 055 and 930 included', !!allowed && allowed.includes('055'), allowed);
  check('prohibited codes listed too', prompt.split('\n').filter((l) => l.includes('the path compares @infoCode')).length === 2);
}
{
  const other = buildExtractFromRulesPrompt({ standard: 'S1000D 4.2', ruleFormat: 'BREX-4.2', candidates: [fresh('BRDP-S2-00002', { classification: 'other_spec', specification: 'S2000M' })] });
  check('other specification named', other.includes('This is a decision point of S2000M'));
  check('other specification writes title and definition', other.includes('Write: title, definition, proposal'));
}
{
  const dita = buildExtractFromRulesPrompt({
    standard: 'DITA 1.3 Xpath2.0',
    ruleFormat: 'SCH-DITA',
    candidates: [{ key: 'c1', origin_identifier: 'BRDP-EXT-00007', classification: 'new_ext', decision_texts: [], object_uses: ['Note needs a type.'], summary: { count: 1, asserts: 1, rules: [{ context: 'note', kind: 'assert', test: '@type', role: '', message: 'Note needs a type.' }], rules_more: 0 } }],
  });
  check('Schematron summary', dita.includes('for "note", assert test "@type": "Note needs a type."'));
}

// ── Parsing the answer ─────────────────────────────────────────────────────
{
  const ok = parseExtractFromRulesResponse('```json\n{"items":[{"key":"a","title":"","definition":"","proposal":"P."},{"key":"zzz","proposal":"x"}]}\n```', ['a', 'b']);
  check('fenced JSON parsed', ok.items.get('a')?.proposal === 'P.');
  check('unknown keys ignored', !ok.items.has('zzz'));
  check('missing key absent', !ok.items.has('b'));
  for (const [name, text, fields] of [
    ['not JSON', 'Sorry, I cannot.'],
    ['invalid JSON', '{"items": [}'],
    ['no items', '{"foo": 1}'],
    ['no proposal', '{"items":[{"key":"a","proposal":""}]}'],
    ['a field asked left empty', '{"items":[{"key":"a","title":"","proposal":"P"}]}', new Map([['a', ['title', 'proposal']]])],
  ]) {
    let threw = false;
    try {
      parseExtractFromRulesResponse(text, ['a'], fields);
    } catch {
      threw = true;
    }
    check(`rejects ${name}`, threw);
  }
  // Only the title asked: an empty proposal is fine.
  const titleOnly = parseExtractFromRulesResponse('{"items":[{"key":"a","title":"T","definition":"","proposal":""}]}', ['a'], new Map([['a', ['title']]]));
  check('title-only item accepted', titleOnly.items.get('a')?.title === 'T');
}

// ── Drafting in batches ────────────────────────────────────────────────────
function keysOf(system) {
  return [...system.matchAll(/^BRDP key=(\S+)/gm)].map((m) => m[1]);
}
const many = Array.from({ length: 23 }, (_, i) => ({ ...fresh('BREX-S1-00242'), key: `k${i}` }));
{
  const calls = [];
  const saved = [];
  const results = await draftCandidates(many, {
    standard: 'S1000D 4.2',
    ruleFormat: 'BREX-4.2',
    ask: async ({ system, user }) => {
      calls.push({ system, user });
      return JSON.stringify({ items: keysOf(system).map((key) => ({ key, title: `T${key}`, definition: `D${key}`, proposal: `P${key}` })) });
    },
    onBatch: async (r) => saved.push(r.length),
  });
  check('3 batches of at most 10', calls.length === 3 && saved.sort().join(',') === '10,10,3', saved.join(','));
  check('fixed user message', calls.every((c) => c.user === EXTRACT_USER_MESSAGE));
  check('every candidate drafted', results.length === 23 && results.every((r) => r.draft_status === 'drafted' && r.proposal === `P${r.key}`));
  check('no rule XML sent', calls.every((c) => !c.system.includes('<structureObjectRule')));
}
{
  // Invalid JSON once → retried once and written.
  let n = 0;
  const results = await draftCandidates(many.slice(0, 2), {
    standard: 'S1000D 4.2',
    ruleFormat: 'BREX-4.2',
    ask: async ({ system }) => {
      n += 1;
      if (n === 1) return '{"items": [';
      return JSON.stringify({ items: keysOf(system).map((key) => ({ key, title: 't', definition: 'd', proposal: 'p' })) });
    },
  });
  check('invalid JSON retried once', n === 2 && results.every((r) => r.draft_status === 'drafted'));
}
{
  // Truncated twice → not written, left to the user (HR7).
  let n = 0;
  const results = await draftCandidates(many.slice(0, 3), {
    standard: 'S1000D 4.2',
    ruleFormat: 'BREX-4.2',
    ask: async () => {
      n += 1;
      const err = new Error('cut');
      err.code = LLM_TRUNCATED;
      throw err;
    },
  });
  check('truncated twice → failed, two calls', n === 2 && results.every((r) => r.draft_status === 'failed' && r.error === LLM_TRUNCATED));
  check('failed candidates keep no invented text', results.every((r) => !('proposal' in r)));
}
{
  // An answer that leaves one candidate out: only that one fails.
  const results = await draftCandidates(many.slice(0, 2), {
    standard: 'S1000D 4.2',
    ruleFormat: 'BREX-4.2',
    ask: async ({ system }) => JSON.stringify({ items: [{ key: keysOf(system)[0], title: 't', definition: 'd', proposal: 'p' }] }),
  });
  check('missing item → only it fails', results[0].draft_status === 'drafted' && results[1].draft_status === 'failed');
}
{
  // A catalog candidate never gets a title/definition from the AI.
  const [r] = await draftCandidates([{ ...fixture['BRDP-S1-00052'], key: 'cat' }], {
    standard: 'S1000D 4.2',
    ruleFormat: 'BREX-4.2',
    ask: async () => JSON.stringify({ items: [{ key: 'cat', title: 'WRONG', definition: 'WRONG', proposal: 'Information codes shall be…' }] }),
  });
  check('catalog keeps its own title/definition', !('title' in r) && !('definition' in r) && r.proposal === 'Information codes shall be…');
}
{
  // Literal Definition and Proposal: the AI's answer only gives the Title,
  // and nothing else it writes is taken.
  const [r] = await draftCandidates([{ ...fixture['BRDP-S1-00117'], key: 'lit' }], {
    standard: 'S1000D 4.2',
    ruleFormat: 'BREX-4.2',
    ask: async () => JSON.stringify({ items: [{ key: 'lit', title: 'Inline captions', definition: 'WRONG', proposal: 'WRONG' }] }),
  });
  check('literal texts: only the title taken', r.title === 'Inline captions' && !('definition' in r) && !('proposal' in r) && r.draft_status === 'drafted');
}
{
  // Real Lufthansa candidates with literal texts in a catalog project: nothing
  // left for the AI, never sent.
  const literal = { ...fixture['BRDP-S1-00037'], classification: 'catalog', ai_fields: [], draft_status: 'not_needed' };
  check('nothing to write → not sent', candidatesToDraft([literal]).length === 0);
}
{
  const list = [
    { key: 'a', classification: 'new_ext', draft_status: 'pending' },
    { key: 'b', classification: 'catalog', draft_status: 'drafted' },
    { key: 'c', classification: 'changed', draft_status: 'not_needed' },
    { key: 'd', classification: 'other_spec', draft_status: 'pending' },
    { key: 'e', classification: 'empty', draft_status: 'pending' },
    { key: 'f', classification: 'catalog', draft_status: 'manual' },
    { key: 'g', classification: 'default_rule', draft_status: 'pending', selected: false },
    { key: 'h', classification: 'default_rule', draft_status: 'pending', selected: true },
    { key: 'i', classification: 'new_ext', draft_status: 'pending', ai_fields: [] },
  ];
  check('only pending candidates of the written classes', candidatesToDraft(list).map((c) => c.key).join(',') === 'a,d,h');
}

console.log(`${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
