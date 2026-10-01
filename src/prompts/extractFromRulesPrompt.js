// AI Extract (1/2): the prompt that writes, for BRDPs read from an existing
// BREX or Schematron, only what the file and the catalog cannot give -- the
// candidate's ai_fields (backend/app/services/rule_extract_jobs.py's
// set_texts):
//   - the Proposal, when the file has no decision text (a nonContextRule's
//     paragraphs are taken literally, never rewritten) -- the normative
//     sentence of the decision, WITHOUT placeholders (the decision is
//     already taken: it is in the file);
//   - Title, and Definition when the file has none, for "Nueva EXT", "Otra
//     especificación" and "Regla por defecto" (a catalog BRDP takes both
//     from the catalog).
// A candidate with nothing left to write is never sent.
// Pure (Node and browser), like every module in src/prompts/: the page and
// scripts/run-prompt-eval.mjs call it with the candidates as the backend
// returns them. The rules' XML is never sent -- each candidate carries a
// summary built by code (backend/app/services/rule_extract.py's _summary):
// rule count, flags, path kinds, the first paths, the most repeated
// objectUse and, for candidates up to 200 rules, the first rules one by one.

export const EXTRACT_USER_MESSAGE = 'Write the texts for these BRDPs.';

const TEXT_FIELDS = ['title', 'definition', 'proposal'];
const WRITES_TITLE = new Set(['new_ext', 'other_spec', 'default_rule']);

// The fields the AI writes for a candidate. ai_fields comes from the
// backend; an extraction saved before it existed falls back to the
// classification (Title and Definition for a new BRDP, the Proposal always).
export function aiFieldsOf(c) {
  if (Array.isArray(c.ai_fields)) return c.ai_fields;
  return WRITES_TITLE.has(c.classification) ? TEXT_FIELDS : ['proposal'];
}

const GIVEN_LABEL = {
  catalog: 'official, do not rewrite',
  file: 'from the file, do not rewrite',
  project: 'from the project, do not rewrite',
  manual: 'written by the user, do not rewrite',
  ai: 'already written, do not rewrite',
};

const FLAG_MEANING = {
  0: 'prohibited (the path must not match anything)',
  1: 'required (the path must match)',
  2: 'allowed (only the listed values, when values are given)',
};

function flagText(flag, ruleFormat) {
  if (ruleFormat === 'BREX-3.0.1') {
    if (flag === '0') return 'prohibited';
    if (flag === '1') return 'required';
    return 'values only';
  }
  return FLAG_MEANING[flag ?? '2'] || `flag ${flag}`;
}

function ruleLines(summary, ruleFormat) {
  if (!summary) return ['  (no executable rule in the file)'];
  const lines = [];
  if (ruleFormat === 'SCH-DITA') {
    lines.push(`  ${summary.count} Schematron pattern(s), ${summary.asserts} assert/report(s):`);
    for (const r of summary.rules || []) {
      lines.push(`  - for "${r.context}", ${r.kind} test "${r.test}"${r.role ? ` (role ${r.role})` : ''}: "${r.message}"`);
    }
    if (summary.rules_more) lines.push(`  - … ${summary.rules_more} more`);
    return lines;
  }
  const flags = Object.entries(summary.flags || {})
    .map(([flag, n]) => `${n} ${flagText(flag, ruleFormat)}`)
    .join(', ');
  lines.push(`  ${summary.count} rule(s): ${flags}.`);
  if (summary.schemas?.length) lines.push(`  Some rules apply only to the schemas: ${summary.schemas.join(', ')}.`);
  if (summary.rules) {
    for (const r of summary.rules) {
      const values = r.values?.length
        ? `; values: ${r.values.join(', ')}${r.values_more ? `, … ${r.values_more} more` : ''}`
        : '';
      const schema = r.schema ? ` [${r.schema} schema only]` : '';
      lines.push(`  - ${r.path} — ${flagText(r.flag, ruleFormat)}${values}${schema}`);
      for (const c of r.compared || []) {
        const more = c.more ? `, … ${c.more} more` : '';
        lines.push(`    the path compares ${c.name} (${c.op}) with ${c.values.length + (c.more || 0)} values: ${c.values.join(', ')}${more}`);
      }
    }
    if (summary.rules_more) lines.push(`  - … ${summary.rules_more} more rules`);
  } else {
    const kinds = Object.entries(summary.path_kinds || {})
      .map(([k, n]) => `${n} ${k}`)
      .join(', ');
    lines.push(`  Path kinds: ${kinds}. First paths:`);
    for (const p of summary.first_paths || []) lines.push(`  - ${p}`);
    if (summary.most_repeated_use) {
      lines.push(`  Most repeated objectUse (${summary.most_repeated_use.count} rules): "${summary.most_repeated_use.text}"`);
    }
  }
  return lines;
}

function candidateBlock(c, ruleFormat) {
  const fields = aiFieldsOf(c);
  const lines = [`BRDP key=${c.key}`];
  if (c.origin_identifier) lines.push(`  Identifier in the source file: ${c.origin_identifier}`);
  if (c.classification === 'other_spec' && c.specification) {
    lines.push(`  This is a decision point of ${c.specification}, not of the project's standard.`);
  }
  if (c.classification === 'default_rule' && c.specification) {
    lines.push(`  This is a rule of the ${c.specification} default BREX, not a project decision: name and state that rule.`);
  }
  for (const field of TEXT_FIELDS) {
    if (fields.includes(field) || !c[field]) continue;
    const label = GIVEN_LABEL[c.text_sources?.[field]] || (field === 'proposal' ? 'from the file, do not rewrite' : 'official, do not rewrite');
    lines.push(`  ${field[0].toUpperCase()}${field.slice(1)} (${label}): ${c[field]}`);
  }
  lines.push(`  Write: ${fields.join(', ')}`);
  if (c.decision_texts?.length) {
    lines.push(
      fields.includes('proposal')
        ? '  Decision text in the file (nonContextRule) -- the main source for the Proposal:'
        : '  Decision text in the file (nonContextRule):'
    );
    for (const t of c.decision_texts) lines.push(`  > ${t}`);
  }
  if (c.object_uses?.length) {
    lines.push('  Rule explanations in the file (objectUse / messages):');
    for (const t of c.object_uses.slice(0, 8)) lines.push(`  > ${t}`);
  }
  lines.push('  What the rules check (summary made by the application):');
  lines.push(...ruleLines(c.summary, ruleFormat));
  return lines.join('\n');
}

export function buildExtractFromRulesPrompt({ standard, ruleFormat, candidates }) {
  return [
    `You document the business rules of a technical publications project that uses ${standard}.`,
    'The decisions below were read from the project\'s existing BREX / Schematron file. The decision is already taken: it is in the file. You only write the texts the file does not contain.',
    '',
    'For each BRDP, write what its "Write:" line asks:',
    '- proposal (only when asked): the normative sentence of the decision this project took, as it is enforced by its rules and stated in its decision text. One to three sentences, "shall" / "must" style. Use the concrete values, element and attribute names that are in the file (write elements as <name> and attributes as @name). No placeholders, no brackets to fill in, no options to choose from: the decision is known.',
    '- title (only when asked): a short noun phrase naming the decision point, at most 12 words, no final period.',
    '- definition (only when asked): one or two sentences saying what has to be decided, phrased as a decision point ("Decide whether …", "Decide which …"), never the answer itself.',
    'When the decision text and the rules disagree, follow the decision text and do not invent anything the file does not say. If the file says nothing useful about the decision, write a proposal that only states what the rules enforce.',
    'Never mention the rule syntax (XPath, objectPath, allowedObjectFlag, Schematron), the file, or this application.',
    'Never state or suggest specification chapter or paragraph numbers that are not in the texts below.',
    'LANGUAGE: write each BRDP\'s texts in the language of its decision text; if it has none, in the language of its rule explanations; if those are in English or absent, in English.',
    '',
    'Answer with JSON only, exactly this shape, one item per BRDP below, same keys:',
    '{"items": [{"key": "c00001", "title": "…", "definition": "…", "proposal": "…"}]}',
    'Leave a field as "" when it is not asked.',
    '',
    'BRDPs:',
    '',
    candidates.map((c) => candidateBlock(c, ruleFormat)).join('\n\n'),
  ].join('\n');
}

// → { items: Map<key, {title, definition, proposal}> }. Throws an Error
// with a reason for anything that is not the expected JSON: not JSON, no
// items, a key not asked for, a field asked for left empty (fieldsByKey:
// key → the fields asked; the Proposal when not given). A ```json fence
// and text around the object are tolerated.
export function parseExtractFromRulesResponse(text, expectedKeys, fieldsByKey = new Map()) {
  const raw = String(text ?? '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('the answer is not JSON');
  let data;
  try {
    data = JSON.parse(raw.slice(start, end + 1));
  } catch (err) {
    throw new Error(`the answer is not valid JSON: ${err.message}`);
  }
  if (!data || !Array.isArray(data.items)) throw new Error('the answer has no "items" list');
  const expected = new Set(expectedKeys);
  const items = new Map();
  for (const item of data.items) {
    if (!item || typeof item.key !== 'string' || !expected.has(item.key)) continue;
    const text = (v) => (typeof v === 'string' ? v.trim() : '');
    const asked = fieldsByKey.get(item.key) || ['proposal'];
    if (asked.some((f) => !text(item[f]))) continue;
    items.set(item.key, { title: text(item.title), definition: text(item.definition), proposal: text(item.proposal) });
  }
  if (items.size === 0) throw new Error('the answer has no usable item');
  return { items };
}
