// Test de reglas: el esquema de la prueba tiene el atributo de la regla
// (Part 4), y las SCHEMA FACTS dan los padres por esquema (Part 5). Real
// case (S1000D 3.0.1, general rule //response/@rsptype, values rt01–rt04):
// <response> is in comment (with @rsptype, required, in the status section
// <cstatus>) and in crew (in the content, <challrsp>, without @rsptype).
// The application chose crew and Mistral put @rsptype on <para>: no example
// could run. And the card said "allowed inside: challrsp, cstatus (this is
// the same for every schema …)", which is false. On the REAL cards
// (backend/schema_cards/schema-cards-3-0-1.json, as GET /api/schema-cards
// gives them) and the REAL structures of the fixture.
//   node scripts/test-attribute-schema.mjs
import fs from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import i18n from '../src/i18n/index.js';
import { buildRuleTestExamplesPrompt } from '../src/prompts/ruleTestExamplesPrompt.js';
import { buildSchemaFactsBlock } from '../src/prompts/shared.js';
import { materializeExample, runExample, ruleTestVerdict } from '../src/utils/ruleTest.js';
import { analyzeRule } from '../src/utils/ruleTestEngine.js';
import { formatRuleTestReason } from '../src/utils/ruleTestReasons.js';
import { prepareRuleTestSetup } from '../src/utils/ruleTestRun.js';
import { chooseTestSchemas, metadataXml, ruleTargets } from '../src/utils/ruleTestSkeleton.js';

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) passed += 1;
  else {
    failed += 1;
    console.log(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
  }
}
function parseXml(text) {
  const messages = [];
  const doc = new DOMParser({ errorHandler: (_l, msg) => messages.push(msg) }).parseFromString(text, 'text/xml');
  if (messages.length) throw new Error(messages[0].replace(/^\[xmldom \w+\]\s*/, '').split('\n')[0]);
  return doc;
}
const en = i18n.getFixedT('en');
const es = i18n.getFixedT('es');
const S301 = 'S1000D 3.0.1';
const STRUCTURES = JSON.parse(fs.readFileSync(new URL('./rule-test-fixtures/structures.json', import.meta.url)));
const RAW = JSON.parse(fs.readFileSync(new URL('../backend/schema_cards/schema-cards-3-0-1.json', import.meta.url)));
const vocabulary301 = (() => {
  const json = JSON.parse(fs.readFileSync(new URL('../public/schema-vocabulary-3-0-1.json', import.meta.url)));
  return { elements: new Set(json.elements), attributes: new Set(json.attributes) };
})();
const documentSchemas = [...new Set(Object.values(RAW.cards).flatMap((variants) => variants.flatMap((v) => v.schemas)))].sort();
// A card as GET /api/schema-cards gives it (attributes, children and the
// parents per schema), from the real generated file.
const cardOf = (name) => {
  const variants = RAW.cards[name];
  if (!variants) return null;
  const parents = RAW.parents[name] || [];
  const schemas = [...new Set(variants.flatMap((v) => v.schemas))];
  const groups = [];
  for (const schema of schemas) {
    const own = parents.filter((p) => (RAW.cards[p] || []).some((pv) => pv.schemas.includes(schema) && pv.children.includes(name)));
    const same = groups.find((g) => JSON.stringify(g.parents) === JSON.stringify(own));
    if (same) same.schemas.push(schema);
    else groups.push({ schemas: [schema], parents: own, parents_truncated: false, parents_omitted: 0 });
  }
  return {
    variants: variants.map((v) => ({ ...v, attributes_truncated: false, attributes_omitted: 0, children_truncated: false, children_omitted: 0 })),
    parents,
    parents_truncated: false,
    parents_omitted: 0,
    parents_by_schema: groups,
  };
};
const fetchSchemaCards = async (_std, names) => ({
  cards: Object.fromEntries(names.map((n) => [n, cardOf(n)]).filter(([, c]) => c)),
  document_schemas: documentSchemas,
});
const fetchStructure = async (_std, schema) => {
  const st = STRUCTURES[`${S301}|${schema}`];
  return st ? { available: true, ...st } : { available: false };
};
const RSP = '<objrule id="R"><objpath objappl="1">//response/@rsptype</objpath><objuse>Response types rt01 to rt04 only.</objuse><objval val1="rt01" val2="rt04" valtype="range"/></objrule>';
const brdp = { identifier: 'BRDP-EXT-09002', title: 'Response types', definition: 'Decide which response types are used.', proposal: 'Only the response types rt01 to rt04 are used.' };

// ─── Part 4: a schema whose <response> has @rsptype ───────────────────────
{
  const cards = { response: cardOf('response') };
  check('cards: <response> in comment (with @rsptype) and crew (without)',
    cards.response.variants.some((v) => v.schemas.includes('comment') && v.attributes.some((a) => a.name === 'rsptype'))
    && cards.response.variants.some((v) => v.schemas.includes('crew') && !v.attributes.some((a) => a.name === 'rsptype')));
  const chosen = chooseTestSchemas({ documentSchemas, cards, targets: ruleTargets(RSP) });
  check('//response/@rsptype: tested on comment, never crew', chosen.testSchema === 'comment' && !(chosen.candidates || []).includes('crew'), JSON.stringify([chosen.testSchema, chosen.candidates]));
  // An element step only (no attribute): unchanged -- crew first by preference.
  const plain = chooseTestSchemas({ documentSchemas, cards, targets: ruleTargets('<objrule><objpath objappl="0">//response</objpath><objuse>x</objuse></objrule>') });
  check('//response (no attribute): unchanged, crew by preference', plain.testSchema === 'crew', plain.testSchema);
  // A card without attribute lists says nothing: not narrowed.
  const bare = { response: { variants: cards.response.variants.map(({ attributes: _a, ...v }) => v) } };
  check('card without attribute lists: not narrowed', chooseTestSchemas({ documentSchemas, cards: bare, targets: ruleTargets(RSP) }).testSchema === 'crew');
  // A rule with a schema context keeps its schema.
  const ctx = chooseTestSchemas({ contextSchemas: ['crew'], documentSchemas, cards, targets: ruleTargets(RSP) });
  check('context rule: its schema', ctx.testSchema === 'crew', ctx.testSchema);

  // The whole preparation: comment, <response> only in <cstatus> -- the
  // application's mechanism for rules on the section: the LLM writes the
  // whole <cstatus>.
  // (crew is not in the fixture: with the old choice this throws)
  const prep = await prepareRuleTestSetup({ ruleXml: RSP, standard: S301, schemaLocation: 'flat', format: 'BREX-3.0.1', fetchSchemaCards, fetchStructure }).catch((err) => ({ error: err.message, promptPlacements: [], setup: { placements: {} } }));
  check('prepare: no error', !prep.error, prep.error);
  const pl = prep.promptPlacements;
  check('prepare: comment, the section written by the LLM', pl.length === 1 && pl[0].schema === 'comment' && pl[0].metadata?.insertion === true && pl[0].metadata.element === 'cstatus', JSON.stringify(pl.map((p) => [p.schema, p.metadata?.element, p.metadata?.insertion])));
  const prompt = buildRuleTestExamplesPrompt({ brdp, standard: S301, format: 'BREX-3.0.1', ruleXml: RSP, contextSchemas: prep.contextSchemas, placements: pl, schemaFacts: prep.schemaFacts });
  check('prompt: every example uses comment and writes the whole <cstatus>', prompt.includes('every example uses the "comment" schema') && prompt.includes('your "metadata" is the WHOLE <cstatus>') && !prompt.includes('"crew"'), prompt.split('\n').filter((l) => /schema|cstatus/.test(l)).join('\n'));
  // The section the LLM writes, as Mistral would: rt02 accepted, rt07 rejected.
  const minimal = metadataXml(STRUCTURES[`${S301}|comment`].skeleton.metadata.tree, 0).xml;
  const cstatus = (value) => minimal.replace('<crefs>', `<response rsptype="${value}"/><crefs>`);
  const examples = [
    { label: 'rt02', expected: 'accept', schema: 'comment', metadata: cstatus('rt02'), content: '' },
    { label: 'rt07', expected: 'reject', schema: 'comment', metadata: cstatus('rt07'), content: '' },
  ];
  const materialized = examples.map((e) => materializeExample(e, prep.setup, parseXml));
  const runs = materialized.map((e) => runExample(RSP, 'BREX-3.0.1', e, { vocabulary: vocabulary301, parseXml }));
  check('examples in <cstatus>: both run', runs.every((r) => r.result), JSON.stringify(runs.map((r) => [r.validation.runnable, r.validation.structure])));
  check('examples in <cstatus>: accepted / rejected, verdict correct',
    runs.map((r) => r.result?.status).join() === 'accepted,rejected' && ruleTestVerdict(materialized, runs, analyzeRule(RSP, 'BREX-3.0.1', { parseXml })).kind === 'correct',
    JSON.stringify(runs.map((r) => r.result?.status)));

  // No schema has the element with that attribute: not executable, with the reason.
  const NONE = '<objrule id="R"><objpath objappl="1">//response/@caveat</objpath><objuse>x</objuse></objrule>';
  const none = chooseTestSchemas({ documentSchemas, cards, targets: ruleTargets(NONE) });
  check('no schema whose <response> has @caveat: said', JSON.stringify(none.noAttributeSchema) === '{"element":"response","attribute":"caveat"}' && none.testSchema === null, JSON.stringify(none));
  // Another part of the rule can be tested: not "not executable", the
  // impossible part narrows nothing (DMC-…022AD S1-00092: table/tgroup/@changeMark
  // | table/title/@changeMark).
  const mixed = chooseTestSchemas({ documentSchemas, cards, targets: ruleTargets('<objrule><objpath objappl="1">//response/@caveat | //response/@rsptype</objpath><objuse>x</objuse></objrule>') });
  check('one part impossible, another possible: tested on comment, not "not executable"', !mixed.noAttributeSchema && mixed.testSchema === 'comment', JSON.stringify(mixed));
  const pNone = await prepareRuleTestSetup({ ruleXml: NONE, standard: S301, schemaLocation: 'flat', format: 'BREX-3.0.1', fetchSchemaCards, fetchStructure });
  check('prepare: not executable (attribute_no_schema)', pNone.unreachable?.code === 'attribute_no_schema', JSON.stringify(pNone.unreachable));
  check('reason EN', formatRuleTestReason(pNone.unreachable, en) === 'no S1000D 3.0.1 schema has <response> with @caveat: no example can contain it.', formatRuleTestReason(pNone.unreachable, en));
  check('reason ES', formatRuleTestReason(pNone.unreachable, es) === 'ningún esquema de S1000D 3.0.1 tiene <response> con @caveat: ningún ejemplo puede contenerlo.', formatRuleTestReason(pNone.unreachable, es));
}

// ─── Part 5: the parents per schema in the SCHEMA FACTS ───────────────────
{
  const entry = cardOf('response');
  const block = buildSchemaFactsBlock(S301, [{ name: 'response', entry }]);
  check('facts: never "the same for every schema" when they differ', !block.includes('the same for every schema') && !block.includes('never differ by schema'), block);
  check('facts: the parents of each schema', block.includes('allowed inside, by schema:') && block.includes('[comment]: cstatus') && block.includes('[crew]: challrsp'), block);
  // Without parents_by_schema (an older answer): the list joins every schema.
  const { parents_by_schema: _g, ...old } = entry;
  const oldBlock = buildSchemaFactsBlock(S301, [{ name: 'response', entry: old }]);
  check('facts without parents_by_schema: says the list joins every schema', oldBlock.includes('allowed inside (the parents of every schema listed above together — they may differ by schema): challrsp, cstatus') && !oldBlock.includes('never differ'), oldBlock);
  // One group: really the same for all.
  const one = { ...entry, parents: ['x'], parents_by_schema: [{ schemas: ['comment', 'crew'], parents: ['x'], parents_truncated: false, parents_omitted: 0 }] };
  check('facts, one group: the same for every schema', buildSchemaFactsBlock(S301, [{ name: 'response', entry: one }]).includes('allowed inside: x (this is the same for every schema listed above)'));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
