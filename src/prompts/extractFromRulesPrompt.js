// AI Extract (1/2): the prompt that writes, for BRDPs read from an existing
// BREX or Schematron, only what the file and the catalog cannot give:
//   - the Proposal (every candidate sent: "Nueva EXT", "De catálogo", "Otra
//     especificación") -- the normative sentence of the decision, in the
//     language of the source texts, WITHOUT placeholders (the decision is
//     already taken: it is in the file);
//   - Title and Definition, only for "Nueva EXT" and "Otra especificación"
//     (a catalog BRDP takes both from the catalog).
// Pure (Node and browser), like every module in src/prompts/: the page and
// scripts/run-prompt-eval.mjs call it with the candidates as the backend
// returns them. The rules' XML is never sent -- each candidate carries a
// summary built by code (backend/app/services/rule_extract.py's _summary):
// rule count, flags, path kinds, the first paths, the most repeated
// objectUse and, for candidates up to 200 rules, the first rules one by one.

export const EXTRACT_USER_MESSAGE = 'Write the texts for these BRDPs.';

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
  const writeAll = c.classification === 'new_ext' || c.classification === 'other_spec';
  const lines = [`BRDP key=${c.key}`];
  if (c.origin_identifier) lines.push(`  Identifier in the source file: ${c.origin_identifier}`);
  if (c.classification === 'other_spec' && c.specification) {
    lines.push(`  This is a decision point of ${c.specification}, not of the project's standard.`);
  }
  if (!writeAll) {
    lines.push(`  Title (official, do not rewrite): ${c.title}`);
    lines.push(`  Definition (official, do not rewrite): ${c.definition}`);
  }
  lines.push(`  Write: ${writeAll ? 'title, definition, proposal' : 'proposal'}`);
  if (c.decision_texts?.length) {
    lines.push('  Decision text in the file (nonContextRule) -- the main source for the Proposal:');
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
    '- proposal: the normative sentence of the decision this project took, as it is enforced by its rules and stated in its decision text. One to three sentences, "shall" / "must" style. Use the concrete values, element and attribute names that are in the file (write elements as <name> and attributes as @name). No placeholders, no brackets to fill in, no options to choose from: the decision is known.',
    '- title (only when asked): a short noun phrase naming the decision point, at most 12 words, no final period.',
    '- definition (only when asked): one or two sentences saying what has to be decided, phrased as a decision point ("Decide whether …", "Decide which …"), never the answer itself.',
    'When the decision text and the rules disagree, follow the decision text and do not invent anything the file does not say. If the file says nothing useful about the decision, write a proposal that only states what the rules enforce.',
    'Never mention the rule syntax (XPath, objectPath, allowedObjectFlag, Schematron), the file, or this application.',
    'Never state or suggest specification chapter or paragraph numbers that are not in the texts below.',
    'LANGUAGE: write each BRDP\'s texts in the language of its decision text; if it has none, in the language of its rule explanations; if those are in English or absent, in English.',
    '',
    'Answer with JSON only, exactly this shape, one item per BRDP below, same keys:',
    '{"items": [{"key": "c00001", "title": "…", "definition": "…", "proposal": "…"}]}',
    'Leave "title" and "definition" as "" when they are not asked.',
    '',
    'BRDPs:',
    '',
    candidates.map((c) => candidateBlock(c, ruleFormat)).join('\n\n'),
  ].join('\n');
}

// → { items: Map<key, {title, definition, proposal}> }. Throws an Error
// with a reason for anything that is not the expected JSON: not JSON, no
// items, a key not asked for, a missing proposal. A ```json fence and text
// around the object are tolerated.
export function parseExtractFromRulesResponse(text, expectedKeys) {
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
    if (!text(item.proposal)) continue;
    items.set(item.key, { title: text(item.title), definition: text(item.definition), proposal: text(item.proposal) });
  }
  if (items.size === 0) throw new Error('the answer has no usable item');
  return { items };
}
