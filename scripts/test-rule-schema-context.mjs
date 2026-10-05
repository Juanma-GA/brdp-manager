// Suggest Rule part 2 (schema context) -- plain Node test, no runner (same
// convention as test-rule-name-check.mjs). Imports the REAL modules:
// src/utils/ruleSchemaContext.js and src/prompts/suggestRulePrompt.js, and
// reads the REAL schema cards (backend/schema_cards/*.json).
//
//   node scripts/test-rule-schema-context.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_SCHEMA_LOCATION,
  SCHEMA_CONTEXT_ISSUE,
  checkRuleSchemaCoverage,
  contextSchemasOfRule,
  coverageOf,
  decideRuleSchemaContext,
  detectSchemaMentions,
  hasSchemaContextBlock,
  schemaContextUrl,
  schemaLocationOf,
  schemaNameFromContext,
  supportsSchemaContext,
  wrapRuleInSchemaContexts,
} from '../src/utils/ruleSchemaContext.js';
import { buildSuggestRulePrompt } from '../src/prompts/suggestRulePrompt.js';
import { pendingApprovalComment } from '../src/api/generateBREX.js';
import { readPublicTemplate } from './lib/readXlsx.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
let passes = 0;
function check(name, cond, detail = '') {
  if (cond) passes += 1;
  else {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Same rule as backend/app/services/schema_cards.py _NON_DOCUMENT_SCHEMAS.
const HELPERS = new Set(['dc', 'rdf', 'xlink', 'xcf']);
function loadCards(file) {
  const data = JSON.parse(fs.readFileSync(path.join(root, 'backend/schema_cards', file), 'utf8'));
  const docs = [...new Set(Object.values(data.cards).flatMap((v) => v.flatMap((x) => x.schemas)))]
    .filter((s) => !HELPERS.has(s))
    .sort();
  const cardsFor = (...names) => Object.fromEntries(names.map((n) => [n, { variants: data.cards[n] }]));
  return { docs, cardsFor };
}
const s42 = loadCards('schema-cards-4-2.json');
const s41 = loadCards('schema-cards-4-1.json');
const s301 = loadCards('schema-cards-3-0-1.json');

// --- URL table ---------------------------------------------------------------
check('url table covers exactly the three S1000D rule formats', eq(Object.keys(SCHEMA_CONTEXT_ISSUE).sort(), ['S1000D 3.0.1', 'S1000D 4.1', 'S1000D 4.2']));
check('DITA never supports schema context', !supportsSchemaContext('DITA 1.3 Xpath2.0') && !supportsSchemaContext('DITA 1.3 Xpath3.0'));
check('S1000D 5.0 has no schema context', !supportsSchemaContext('S1000D 5.0'));
// The 4.2 / 4.1 bases are the real rulesContext values of the curated templates.
for (const [std, file] of [['S1000D 4.2', 'brdp-template-4-2.xlsx'], ['S1000D 4.1', 'brdp-template-4-1.xlsx']]) {
  const rules = readPublicTemplate(file).map((r) => r.Rule || '');
  const urls = rules.flatMap((r) => [...r.matchAll(/rulesContext="([^"]+)"/g)].map((m) => m[1]));
  check(`${std}: template has real rulesContext values`, urls.length > 0);
  check(`${std}: every template rulesContext is the flat URL the app writes`, urls.every((u) => u === schemaContextUrl(std, schemaNameFromContext(u), 'flat')), urls.join(' '));
}
// Every document schema of each standard has a mention entry or at least its
// file name (always matched as "<name>.xsd").
check('schemaNameFromContext', schemaNameFromContext('http://www.s1000d.org/S1000D_4-2/xml_schema_flat/fault.xsd') === 'fault');

// --- schema location (flat / master) ---------------------------------------------
check('default location is flat', DEFAULT_SCHEMA_LOCATION === 'flat');
check('schemaLocationOf: absent / unknown -> flat', schemaLocationOf(undefined) === 'flat' && schemaLocationOf({}) === 'flat' && schemaLocationOf({ schemaLocation: 'weird' }) === 'flat');
check('schemaLocationOf: master kept', schemaLocationOf({ schemaLocation: 'master' }) === 'master');
{
  const expected = {
    'S1000D 4.2': ['4-2', s42.docs],
    'S1000D 4.1': ['4-1', s41.docs],
    'S1000D 3.0.1': ['3-0-1', s301.docs],
  };
  for (const [std, [issue, docs]] of Object.entries(expected)) {
    check(`${std} flat descript`, schemaContextUrl(std, 'descript', 'flat') === `http://www.s1000d.org/S1000D_${issue}/xml_schema_flat/descript.xsd`);
    check(`${std} master descript`, schemaContextUrl(std, 'descript', 'master') === `http://www.s1000d.org/S1000D_${issue}/xml_schema_master/dm/descriptSchema.xsd`);
    check(`${std} default = flat`, schemaContextUrl(std, 'proced') === schemaContextUrl(std, 'proced', 'flat'));
    // Every document schema of the issue round-trips through both forms.
    for (const loc of ['flat', 'master']) {
      const bad = docs.filter((d) => schemaNameFromContext(schemaContextUrl(std, d, loc)) !== d);
      check(`${std} ${loc}: every document schema round-trips (${docs.length})`, bad.length === 0, bad.join(','));
    }
  }
  // The four non-DM schemas have their own master folder.
  for (const [schema, folder] of [['comment', 'comment'], ['ddn', 'ddn'], ['dml', 'dml'], ['pm', 'pm']]) {
    check(`master ${schema} under ${folder}/`, schemaContextUrl('S1000D 3.0.1', schema, 'master') === `http://www.s1000d.org/S1000D_3-0-1/xml_schema_master/${folder}/${schema}Schema.xsd`);
  }
  // Real 3.0.1 master list (BRDP-A1-00100, a real project's approved
  // locations): every xml_schema_master URL there is exactly what the app writes.
  const masterUrls = JSON.parse(fs.readFileSync(path.join(root, 'scripts/rule-test-fixtures/master-schema-urls-3-0-1.json'), 'utf8')).urls;
  check('real 3.0.1 master list present', masterUrls.length >= 15, String(masterUrls.length));
  const mismatch = masterUrls.filter((u) => u !== schemaContextUrl('S1000D 3.0.1', schemaNameFromContext(u), 'master'));
  check('every real 3.0.1 master URL matches the app', mismatch.length === 0, mismatch.join(' '));
}
check('schemaNameFromContext master', schemaNameFromContext('http://www.s1000d.org/S1000D_3-0-1/xml_schema_master/dm/descriptSchema.xsd') === 'descript');
check('schemaNameFromContext master non-DM', schemaNameFromContext('http://www.s1000d.org/S1000D_4-2/xml_schema_master/comment/commentSchema.xsd') === 'comment');
{
  const r301 = '<objrule id="BRDP-Y">\n  <objpath objappl="0">//emphasis</objpath>\n  <objuse>u</objuse>\n</objrule>';
  const w = wrapRuleInSchemaContexts(r301, 'BREX-3.0.1', 'S1000D 3.0.1', ['descript'], 'master');
  check('3.0.1 master, limited to descript -> context="…xml_schema_master/dm/descriptSchema.xsd"', w.startsWith('<contextrules context="http://www.s1000d.org/S1000D_3-0-1/xml_schema_master/dm/descriptSchema.xsd">'), w.split('\n')[0]);
  check('precedent in master form -> schema recognized', eq(contextSchemasOfRule(w), { schemas: ['descript'], general: false }));
  const w42m = wrapRuleInSchemaContexts('<structureObjectRule id="Z"/>', 'BREX-4.2', 'S1000D 4.2', ['proced'], 'master');
  check('4.2 master', w42m.startsWith('<contextRules rulesContext="http://www.s1000d.org/S1000D_4-2/xml_schema_master/dm/procedSchema.xsd">'));
  const w42f = wrapRuleInSchemaContexts('<structureObjectRule id="Z"/>', 'BREX-4.2', 'S1000D 4.2', ['proced']);
  check('4.2 flat unchanged from before', w42f.startsWith('<contextRules rulesContext="http://www.s1000d.org/S1000D_4-2/xml_schema_flat/proced.xsd">'));
  check('4.1 master', wrapRuleInSchemaContexts('<structureObjectRule id="Z"/>', 'BREX-4.1', 'S1000D 4.1', ['fault'], 'master').includes('S1000D_4-1/xml_schema_master/dm/faultSchema.xsd'));
}

// --- word -> schema map ----------------------------------------------------------
const mention = (text, docs = s42.docs) => detectSchemaMentions(text, docs);
check('EN procedural', eq(mention('In procedural data modules, <emphasis> shall not be used.'), ['proced']));
check('ES procedimentales', eq(mention('En los módulos de datos procedimentales no se usará <emphasis>.'), ['proced']));
check('ES procedimiento as a weak word needs a doc noun', eq(mention('Seguir el procedimiento indicado.'), []));
check('ES "módulos de datos de procedimiento"', eq(mention('En los módulos de datos de procedimiento'), ['proced']));
check('EN descriptive/procedural/IPD list', eq(mention('Descriptive, Procedural and IPD schemas shall be used'), ['descript', 'ipd', 'proced']));
check('lower-case "ipd" in prose is not an acronym', eq(mention('the ipd team'), []));
check('"the process" alone is not the process schema', eq(mention('The process shall be followed.'), []));
check('"process data modules" is', eq(mention('Process data modules shall ...'), ['process']));
check('"the BREX" alone is not the brex schema', eq(mention('The BREX shall list every rule.'), []));
check('fault: weak + strong', eq(mention('Fault isolation procedures'), ['fault']) && eq(mention('esquema de fallos'), ['fault']));
check('file name with .xsd', eq(mention('Use fault.xsd here'), ['fault']));
check('master file name <name>Schema.xsd', eq(mention('Use descriptSchema.xsd here'), ['descript']));
check('CIR acronym', eq(mention('In the CIR'), ['comrep']));
check('crew / tripulación', eq(mention('crew data'), ['crew']) && eq(mention('información de tripulación'), ['crew']));
check('checklist', eq(mention('In checklists, ...'), ['checklist']));
check('wiring data vs wiring data description', eq(mention('wiring data description DMs'), ['wrngflds']) && eq(mention('wiring data'), ['wrngdata']));
check('SCORM content package vs SCO content', eq(mention('SCORM content package'), ['scormcontentpackage']) && eq(mention('SCORM content'), ['scocontent']));
check('checklist does not exist in 3.0.1', eq(mention('In checklists, ...', s301.docs), []));
check('techrep only in 3.0.1', eq(mention('technical repository', s301.docs), ['techrep']) && eq(mention('technical repository'), []));
check('no mention in a plain sentence', eq(mention('<emphasis> shall not be used.'), []));

// --- when to offer the selector ---------------------------------------------
const decide = (cards, text, s = s42, standard = 'S1000D 4.2') =>
  decideRuleSchemaContext({ standard, documentSchemas: s.docs, cards, text });
{
  const d = decide(s42.cardsFor('emphasis'), '<emphasis> shall not be used.');
  check('4.2 <emphasis>, no mention -> general rule, no selector', d.supported && !d.showSelector && !d.partial);
}
{
  const d = decide(s42.cardsFor('emphasis'), 'In procedural data modules, <emphasis> shall not be used.');
  check('4.2 proced mention -> selector with proced pre-checked', d.showSelector && eq(d.variants.filter((v) => v.preChecked).map((v) => v.schema), ['proced']));
}
{
  const d = decide(s42.cardsFor('partSegment'), '<partSegment> is mandatory');
  const enabled = d.variants.filter((v) => !v.disabled).map((v) => v.schema);
  check('4.2 element only in some schemas, no mention -> general rule, no selector', !d.showSelector && d.partial);
  check('... only the schemas that have it are enabled', eq(enabled, ['ipd']), enabled.join(','));
  const fault = d.variants.find((v) => v.schema === 'fault');
  check('... disabled ones say which element is missing', fault.disabled && eq(fault.missing, ['partSegment']));
}
{
  const d = decide(s42.cardsFor('table'), 'The <table> element shall not be used.');
  check('4.2 <table> (13 of 28 schemas), no mention -> no selector', !d.showSelector && d.partial);
  const d301 = decide(s301.cardsFor('emphasis', 'para'), '<emphasis> shall not be used in a <para>.', s301, 'S1000D 3.0.1');
  check('3.0.1 <emphasis>/<para> (missing in comment/ddn/dml/pm), no mention -> no selector', !d301.showSelector && d301.partial);
  check(
    '... but the selector opened by hand still disables those schemas',
    ['comment', 'ddn', 'dml', 'pm'].every((sc) => d301.variants.find((v) => v.schema === sc).disabled)
  );
}
{
  const d = decide(s42.cardsFor('table'), 'In procedural data modules, <table> shall not be used.');
  check('4.2 proced mention + <table> -> selector', d.showSelector && eq(d.variants.filter((v) => v.preChecked).map((v) => v.schema), ['proced']));
  check('... schemas without <table> disabled', d.variants.find((v) => v.schema === 'ipd').disabled && d.variants.find((v) => v.schema === 'ipd').missing.includes('table'));
  const proced = d.variants.find((v) => v.schema === 'proced');
  check('mentioned + present -> pre-checked', proced.preChecked && !proced.disabled);
  const ipdMention = decide(s42.cardsFor('table'), 'In IPD data modules, <table> ...');
  const ipd = ipdMention.variants.find((v) => v.schema === 'ipd');
  check('mentioned but element absent -> disabled, never pre-checked', ipd.disabled && !ipd.preChecked);
}
{
  const d = decideRuleSchemaContext({ standard: 'DITA 1.3 Xpath2.0', documentSchemas: ['DITA 1.3'], cards: {}, text: 'procedural' });
  check('DITA never shows the selector', !d.supported && !d.showSelector);
}
{
  const d = decide(s41.cardsFor('proceduralStep'), '<proceduralStep>', s41, 'S1000D 4.1');
  check('4.1 <proceduralStep>, no mention -> no selector; proced enabled if opened', !d.showSelector && !d.variants.find((v) => v.schema === 'proced').disabled);
}

// --- wrapper -------------------------------------------------------------------------
const rule42 = `<structureObjectRule id="BRDP-X" brSeverityLevel="brsl01">
  <brDecisionRef brDecisionIdentNumber="BRDP-X"/>
  <objectPath allowedObjectFlag="0">//emphasis</objectPath>
  <objectUse>No &lt;emphasis&gt;.</objectUse>
</structureObjectRule>`;
check('no schemas -> the rule unchanged', wrapRuleInSchemaContexts(rule42, 'BREX-4.2', 'S1000D 4.2', []) === rule42);
{
  const one = wrapRuleInSchemaContexts(rule42, 'BREX-4.2', 'S1000D 4.2', ['proced']);
  check('one schema -> one contextRules with the proced URL', one.startsWith('<contextRules rulesContext="http://www.s1000d.org/S1000D_4-2/xml_schema_flat/proced.xsd">') && (one.match(/<contextRules/g) || []).length === 1);
  check('... structureObjectRuleGroup around the rule', /<structureObjectRuleGroup>\s*<structureObjectRule id="BRDP-X"/.test(one) && one.includes('</structureObjectRuleGroup>\n</contextRules>'));
}
{
  const two = wrapRuleInSchemaContexts(rule42, 'BREX-4.2', 'S1000D 4.2', ['proced', 'descript']);
  check('two schemas -> two blocks', (two.match(/<contextRules /g) || []).length === 2);
  check('... each with the same inner rule, own xs:ID', two.includes('id="BRDP-X-proced"') && two.includes('id="BRDP-X-descript"') && (two.match(/\/\/emphasis/g) || []).length === 2);
  check('... brDecisionRef keeps the BRDP id', (two.match(/brDecisionIdentNumber="BRDP-X"/g) || []).length === 2);
  check('... schemas in the chosen order', two.indexOf('proced.xsd') < two.indexOf('descript.xsd'));
}
{
  const r301 = '<objrule id="BRDP-Y">\n  <objpath objappl="0">//emphasis</objpath>\n  <objuse>u</objuse>\n</objrule>';
  const w = wrapRuleInSchemaContexts(r301, 'BREX-3.0.1', 'S1000D 3.0.1', ['proced']);
  check('3.0.1 -> contextrules context="…3-0-1…proced.xsd" + structrules', w.startsWith('<contextrules context="http://www.s1000d.org/S1000D_3-0-1/xml_schema_flat/proced.xsd">\n  <structrules>') && w.endsWith('</structrules>\n</contextrules>'));
  check('4.1 URL', wrapRuleInSchemaContexts('<structureObjectRule id="Z"/>', 'BREX-4.1', 'S1000D 4.1', ['fault']).includes('S1000D_4-1/xml_schema_flat/fault.xsd'));
}
check('hasSchemaContextBlock', hasSchemaContextBlock(wrapRuleInSchemaContexts(rule42, 'BREX-4.2', 'S1000D 4.2', ['fault'])) && !hasSchemaContextBlock(rule42) && !hasSchemaContextBlock('<contextRules rulesContext="">x</contextRules>'));

// --- precedent labels --------------------------------------------------------------
check('plain rule -> general, no schemas', eq(contextSchemasOfRule(rule42), { schemas: [], general: true }));
{
  const mixed = `${rule42}\n${wrapRuleInSchemaContexts(rule42, 'BREX-4.2', 'S1000D 4.2', ['fault', 'condcrossreftable'])}`;
  check('mixed -> schemas + general', eq(contextSchemasOfRule(mixed), { schemas: ['fault', 'condcrossreftable'], general: true }));
  const only = wrapRuleInSchemaContexts(rule42, 'BREX-4.2', 'S1000D 4.2', ['fault']);
  check('only context -> not general', eq(contextSchemasOfRule(only), { schemas: ['fault'], general: false }));
  check('comment-only mention ignored', eq(contextSchemasOfRule(`<!-- ${only} -->${rule42}`), { schemas: [], general: true }));
}

// --- per-schema validation -----------------------------------------------------------
{
  const cov = { partSegment: coverageOf({ variants: s42.cardsFor('partSegment').partSegment.variants }), emphasis: coverageOf({ variants: s42.cardsFor('emphasis').emphasis.variants }) };
  const problems = checkRuleSchemaCoverage(['partSegment', 'emphasis', 'unknownThing'], ['ipd', 'proced'], cov);
  check('element missing in a chosen schema -> warning for that schema only', eq(problems, [{ schema: 'proced', missing: ['partSegment'] }]), JSON.stringify(problems));
  check('no schemas -> no warnings', checkRuleSchemaCoverage(['partSegment'], [], cov).length === 0);
}

// --- prompt: precedents with context + chosen schemas ------------------------------
{
  const brdp = { identifier: 'BRDP-P', title: 'T', definition: 'D', proposal: 'In procedural data modules, <emphasis> shall not be used.' };
  const ctxPrecedent = {
    identifier: 'BRDP-S1-00006',
    source_type: 'template',
    proposal: 'Descriptive, Procedural and IPD schemas shall be used',
    text: `${rule42}\n${['condcrossreftable', 'fault', 'prdcrossreftable'].map((s) => wrapRuleInSchemaContexts(rule42, 'BREX-4.2', 'S1000D 4.2', [s])).join('\n')}`,
  };
  const general = buildSuggestRulePrompt(brdp, 'S1000D 4.2', 'BREX-4.2', { formatExamples: [ctxPrecedent] }, []);
  check('precedent with context says which schemas it applies to', general.includes('Applies to: every schema for the rule outside the context blocks; only the condcrossreftable, fault, prdcrossreftable schemas for the rules inside them'));
  check('CONTEXT BLOCKS note present', general.includes('CONTEXT BLOCKS:') && general.includes('limits them to the schema named in its URL'));
  // C2b Entrega 2 (fusion): "never a context block" is said once, in format rule 1.
  check('"never a context block" said once (format rule 1)', general.split('never a context block').length === 2 && general.includes('1. Output exactly one <structureObjectRule') && !general.includes('Never output a context block yourself.'));
  check('general rule wording kept', general.includes('The rule applies to every schema (it is a general rule,'));
  const scoped = buildSuggestRulePrompt(brdp, 'S1000D 4.2', 'BREX-4.2', { formatExamples: [] }, [], { schemas: ['proced'] });
  check('chosen schema reaches the prompt', scoped.includes('The rule applies ONLY to documents written against the\nschema proced.'));
  check('... still only the inner rule', scoped.includes('one context block per\nschema itself (see format rule 1).') && scoped.includes('never a context block (<contextRules>: when the rule is limited to some schemas, the application adds it)') && scoped.split('never a context block').length === 2);
  check('... no CONTEXT BLOCKS note without context precedents', !scoped.includes('CONTEXT BLOCKS:'));
  const two = buildSuggestRulePrompt(brdp, 'S1000D 4.2', 'BREX-4.2', { formatExamples: [] }, [], { schemas: ['proced', 'descript'] });
  check('two schemas listed', two.includes('schemas proced, descript.'));
}

// --- Generate: comment for a BRDP without a Verified rule (all BREX issues + DITA) ---
{
  const uuid = '3b32ddb1-0c8e-4a55-9a1f-0d5c7d9e2f11';
  const c = pendingApprovalComment({ id: uuid, identifier: 'BRDP-EXT-00031' });
  check('pending comment: identifier, English', c === '<!-- BRDP-EXT-00031: rule pending approval, not included in this document -->', c);
  check('pending comment: never the UUID', !c.includes(uuid));
  const odd = pendingApprovalComment({ id: uuid, identifier: 'BRDP--X-' });
  check('pending comment: "--" / trailing "-" neutralized (XML-legal)', !/--(?!>)/.test(odd.slice(4, -3)) && !odd.includes('X-:'), odd);
}

console.log(`${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
