// Generate: which rules enter the document (src/utils/generatePlan.js) and
// the generators with Draft rules; the DITA Schematron generated from rules
// imported from the two real Schematron files (AI Extract) -- each function
// declared once, sch:ns once, every variable declared, valid XPath.
//
//   node scripts/test-generate-plan.mjs
//
// Fixture: scripts/rule-test-fixtures/schematron-extract-rules.json, written
// by backend/scripts/dump_schematron_extract_rules.py from
// backend/tests/fixtures/schematron/ with the same code as the import.
import fs from 'node:fs';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { planGeneration, omittedByReason, ruleEnters } from '../src/utils/generatePlan.js';
import { isXPathSyntaxValid } from '../src/validation/schemaValidation.js';

class NodeDOMParser {
  parseFromString(text) {
    const messages = [];
    const doc = new DOMParser({ errorHandler: (level, msg) => level !== 'warning' && messages.push(msg) }).parseFromString(text, 'text/xml');
    doc.querySelector = (selector) => (selector === 'parsererror' && messages.length ? { textContent: messages[0] } : null);
    return doc;
  }
}
globalThis.DOMParser = NodeDOMParser;
globalThis.XMLSerializer = XMLSerializer;
const { generateBREX41 } = await import('../src/api/generateBREX41.js');
const { generateBREX301 } = await import('../src/api/generateBREX301.js');
const { generateBREXSch } = await import('../src/api/generateBREXSch.js');
const { generateSchematronDITA, checkWellFormedSchematron } = await import('../src/api/generateSchematronDITA.js');

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) passed += 1;
  else {
    failed += 1;
    console.log(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
  }
}
const summary = (f) => JSON.parse(fs.readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8'));
function wellFormed(text) {
  const messages = [];
  new DOMParser({ errorHandler: (level, msg) => level !== 'warning' && messages.push(msg) }).parseFromString(text, 'text/xml');
  return messages;
}

// ── planGeneration ──────────────────────────────────────────────────────
{
  const brdps = [
    { id: 'v', identifier: 'B-V', validation: 'Validated' },
    { id: 'd', identifier: 'B-D', validation: 'Validated' },
    { id: 't', identifier: 'B-T', validation: 'Validated' },
    { id: 'p', identifier: 'B-P', validation: 'Pending' },
    { id: 'pd', identifier: 'B-PD', validation: 'Pending' },
    { id: 'e', identifier: 'B-E', validation: 'Validated' },
  ];
  const approvals = new Map([
    ['v', { status: 'approved', rule_xml: '<r/>' }],
    ['d', { status: 'pending_review', rule_xml: '<r/>' }],
    ['p', { status: 'approved', rule_xml: '<r/>' }],
    ['pd', { status: 'pending_review', rule_xml: '<r/>' }],
    ['e', { status: 'pending_review', rule_xml: '  ' }],
  ]);
  const ids = (list) => list.map((b) => b.identifier).join(',');
  let plan = planGeneration(brdps, approvals, { onlyValidated: true, includeDrafts: false });
  check('both boxes checked: only the Verified rule of a Validated BRDP', ids(plan.included) === 'B-V', ids(plan.included));
  let by = omittedByReason(plan);
  check('omitted reasons', ids(by.draft) === 'B-D' && ids(by.not_validated) === 'B-P,B-PD' && ids(by.no_rule) === 'B-T,B-E', JSON.stringify({ d: ids(by.draft), n: ids(by.not_validated), r: ids(by.no_rule) }));
  plan = planGeneration(brdps, approvals, { onlyValidated: true, includeDrafts: true });
  check('drafts included', ids(plan.included) === 'B-V,B-D' && ids(plan.drafts) === 'B-D');
  check('an empty Draft rule never enters', !ruleEnters(approvals.get('e'), true));
  plan = planGeneration(brdps, approvals, { onlyValidated: false, includeDrafts: true });
  check('both boxes unchecked', ids(plan.included) === 'B-V,B-D,B-P,B-PD' && ids(plan.drafts) === 'B-D,B-PD');
  plan = planGeneration(brdps, approvals, { onlyValidated: false, includeDrafts: false });
  check('only validated unchecked', ids(plan.included) === 'B-V,B-P' && ids(omittedByReason(plan).draft) === 'B-D,B-PD');
  plan = planGeneration(brdps.slice(3, 5), approvals, { onlyValidated: true, includeDrafts: false });
  check('nothing included', plan.included.length === 0 && omittedByReason(plan).not_validated.length === 2);
}

// ── BREX generators: Draft rules in only when asked; ruleCount = plan ───
const rule41 = (id, path) =>
  `<structureObjectRule id="${id}"><objectPath allowedObjectFlag="0">${path}</objectPath><objectUse>${id}.</objectUse></structureObjectRule>`;
const rule301 = (id, path) => `<objrule id="${id}"><objpath objappl="0">${path}</objpath><objuse>${id}.</objuse></objrule>`;
{
  const brdps = [
    { id: 'a', identifier: 'BRDP-EXT-00001', validation: 'Validated' },
    { id: 'b', identifier: 'BRDP-EXT-00002', validation: 'Pending' },
  ];
  for (const [label, run, rule, file, extra] of [
    ['4.1', generateBREX41, rule41, 'brex-schema-summary-4-1.json', {}],
    ['3.0.1', generateBREX301, rule301, 'brex-schema-summary-3-0-1.json', {}],
    ['Schematron (3.0.1)', generateBREXSch, rule301, 'brex-schema-summary-3-0-1.json', { baseGenerator: generateBREX301 }],
  ]) {
    const approvals = new Map([
      ['a', { brdp_id: 'a', status: 'approved', rule_xml: rule('BRDP-EXT-00001', '//footnote') }],
      ['b', { brdp_id: 'b', status: 'pending_review', rule_xml: rule('BRDP-EXT-00002', '//caption') }],
    ]);
    const opts = { approvals, schemaSummary: summary(file), ...extra };
    const off = await run(brdps, { modelIdentCode: 'ABC' }, { ...opts, onlyValidated: false });
    check(`${label}: Draft rule left out by default`, off.ruleCount === 1 && off.xml.includes('footnote') && !off.xml.includes('//caption') && off.xml.includes('BRDP-EXT-00002: rule pending approval'), off.xml.slice(-400));
    const on = await run(brdps, { modelIdentCode: 'ABC' }, { ...opts, onlyValidated: false, includeDrafts: true });
    check(`${label}: Draft rule included with includeDrafts`, on.ruleCount === 2 && on.xml.includes('caption') && !on.xml.includes('rule pending approval') && on.valid, on.error);
    const plan = planGeneration(brdps, approvals, { onlyValidated: false, includeDrafts: true });
    check(`${label}: ruleCount = the page's counter`, on.ruleCount === plan.included.length);
  }
}

// ── DITA Schematron from the rules imported from the real files ─────────
const fixture = JSON.parse(fs.readFileSync(new URL('./rule-test-fixtures/schematron-extract-rules.json', import.meta.url), 'utf8'));
const ditaSummary = summary('schematron-dita-schema-summary.json');
const FUNCTIONS = ['colDe', 'colContiene', 'colPart', 'valor', 'docFicha', 'nodoConref', 'textoNota', 'esAdvertencia', 'conrefRoto'];

function unescape(v) {
  return v.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
function expressions(xml) {
  const out = [];
  const noComments = xml.replace(/<!--[\s\S]*?-->/g, '');
  for (const tag of noComments.matchAll(/<(?:sch:)?(let|rule|assert|report|value-of)\b([^<>]*)>/g)) {
    for (const a of tag[2].matchAll(/\s(value|context|test|select)\s*=\s*"([^"]*)"/g)) out.push({ element: tag[1], attr: a[1], expr: unescape(a[2]) });
  }
  return out;
}

async function generateDita(flavor, standard, status = 'approved') {
  const rules = fixture[flavor];
  const brdps = rules.map((r, i) => ({ id: `id${i}`, identifier: r.identifier, validation: 'Validated' }));
  const approvals = new Map(rules.map((r, i) => [`id${i}`, { brdp_id: `id${i}`, status, rule_xml: r.rule_xml }]));
  return generateSchematronDITA(brdps, { projectName: 'Navantia' }, { approvals, schemaSummary: ditaSummary, standard, includeDrafts: status !== 'approved' });
}

for (const [flavor, standard, binding] of [
  ['xpath3', 'DITA 1.3 Xpath3.0', 'xslt3'],
  ['xpath2', 'DITA 1.3 Xpath2.0', 'xslt2'],
]) {
  const out = await generateDita(flavor, standard);
  const xml = out.xml;
  check(`${flavor}: every rule in`, out.ruleCount === fixture[flavor].length, `${out.ruleCount}`);
  check(`${flavor}: well-formed XML`, wellFormed(xml).length === 0, wellFormed(xml)[0]);
  check(`${flavor}: Schematron check valid`, out.valid, (out.errors || []).join('; '));
  check(`${flavor}: queryBinding`, xml.includes(`queryBinding="${binding}"`));
  // Every variable used is declared (a let anywhere, or bound in the expression).
  const exprs = expressions(xml);
  const declared = new Set(exprs.filter((e) => e.element === 'let').map(() => null));
  for (const m of xml.matchAll(/<(?:sch:)?let\s+name="([^"]+)"/g)) declared.add(m[1]);
  const missing = new Set();
  for (const { expr } of exprs) {
    const bound = new Set([...expr.matchAll(/\$([A-Za-z_][\w.-]*)\s*(?::=|\b(?:in|as)\b)/g)].map((m) => m[1]));
    for (const m of expr.matchAll(/\$([A-Za-z_][\w.-]*)/g)) if (!declared.has(m[1]) && !bound.has(m[1])) missing.add(m[1]);
  }
  check(`${flavor}: every $variable used is declared`, missing.size === 0, [...missing].join(', '));
  const invalid = exprs.filter((e) => !isXPathSyntaxValid(e.expr));
  check(`${flavor}: every XPath parses`, invalid.length === 0, invalid.map((e) => `${e.element}/@${e.attr}: ${e.expr.slice(0, 80)}`).join(' | '));
  check(`${flavor}: placeholder kept literal`, flavor !== 'xpath2' || xml.split("'@@URI-CARPETA-DOSIER@@'").length - 1 === 3);
  if (flavor === 'xpath3') {
    for (const name of FUNCTIONS) {
      const count = xml.split(`<sch:let name="${name}"`).length - 1;
      check(`xpath3: ${name} declared once`, count === 1, `${count}`);
    }
    // All of them at schema level (before the first pattern), as in the file.
    const head = xml.slice(0, xml.indexOf('<sch:pattern'));
    for (const name of FUNCTIONS) check(`xpath3: ${name} at schema level`, head.includes(`<sch:let name="${name}"`));
    // Each after the ones it uses.
    check('xpath3: nodoConref before the functions that call it', head.indexOf('name="nodoConref"') < head.indexOf('name="textoNota"') && head.indexOf('name="nodoConref"') < head.indexOf('name="conrefRoto"'));
    check('xpath3: sch:ns xs once, before the lets', (xml.match(/<sch:ns prefix="xs" uri="http:\/\/www.w3.org\/2001\/XMLSchema"\/>/g) || []).length === 1 && head.indexOf('<sch:ns') < head.indexOf('<sch:let'));
    // A rule-level let that reads the context node stays in its rule.
    check('xpath3: cab never moved', !head.includes('name="cab"') && (xml.match(/name="cab"/g) || []).length === 5);
    check('xpath3: no warnings about shared names', !(out.vocabularyWarnings || []).some((w) => w.startsWith('Shared sch:let')), (out.vocabularyWarnings || []).join(' | '));
  } else {
    check('xpath2: nothing moved (no pattern-level or function lets)', !xml.slice(0, xml.indexOf('<pattern')).includes('let name='));
    check('xpath2: 00007 written as its three patterns', ['p-BRDP-EXT-00007a', 'p-BRDP-EXT-00007"', 'p-BRDP-EXT-00007b'].every((s) => xml.includes(s)));
  }
}

// Draft rules: left out unless asked for.
{
  const off = await generateSchematronDITA(
    [{ id: 'x', identifier: 'BRDP-EXT-00001', validation: 'Validated' }],
    { projectName: 'N' },
    { approvals: new Map([['x', { brdp_id: 'x', status: 'pending_review', rule_xml: fixture.xpath3[0].rule_xml }]]), schemaSummary: ditaSummary, standard: 'DITA 1.3 Xpath3.0' }
  );
  check('DITA: Draft rule left out by default', off.ruleCount === 0 && off.xml.includes('BRDP-EXT-00001: rule pending approval'));
  const on = await generateDita('xpath3', 'DITA 1.3 Xpath3.0', 'pending_review');
  check('DITA: Draft rules included with includeDrafts', on.ruleCount === 7 && on.valid);
}

// checkWellFormedSchematron accepts the sch:ns line.
{
  const out = await generateDita('xpath3', 'DITA 1.3 Xpath3.0');
  const again = checkWellFormedSchematron(out.xml, ditaSummary, 'xslt3');
  check('re-check of the generated document', again.valid, again.errors.join('; '));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
