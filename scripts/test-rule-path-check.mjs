// Mejoras C, Part 1: rule paths that cannot exist in the standard
// (src/validation/rulePathCheck.js), on the REAL element graphs
// (scripts/lib/schemaGraph.mjs → GET /api/schema-cards/graph's data).
//   node scripts/test-rule-path-check.mjs
import { DOMParser } from '@xmldom/xmldom';
import i18n from '../src/i18n/index.js';
import { applyRulePathFix, checkRulePaths, formatPathFix, formatPathProblem, graphIndex, parentsOf, pathAlternatives } from '../src/validation/rulePathCheck.js';
import { formatRuleTestReason, verdictToTestRecord } from '../src/utils/ruleTestReasons.js';
import { generateRuleTestExamples } from '../src/utils/ruleTestRun.js';
import { lintRule } from './lib/ruleLint.mjs';
import { schemaGraph } from './lib/schemaGraph.mjs';

let failures = 0;
let passes = 0;
function check(name, ok, detail = '') {
  if (ok) passes += 1;
  else {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}
const parseXml = (x) => new DOMParser({ errorHandler: () => {} }).parseFromString(x, 'text/xml');
const en = i18n.getFixedT('en');
const es = i18n.getFixedT('es');
const g301 = schemaGraph('S1000D 3.0.1');
const g42 = schemaGraph('S1000D 4.2');
const gDita = schemaGraph('DITA 1.3 Xpath2.0');
const objrule = (path, flag = '0', extra = '') => `<objrule id="R"><objpath objappl="${flag}">${path}</objpath><objuse>x</objuse>${extra}</objrule>`;
const sor = (path, flag = '0') => `<structureObjectRule id="R"><objectPath allowedObjectFlag="${flag}">${path}</objectPath><objectUse>x</objectUse></structureObjectRule>`;
const run301 = (path, flag = '0') => checkRulePaths(objrule(path, flag), 'BREX-3.0.1', g301, { parseXml });
const run42 = (rule) => checkRulePaths(rule, 'BREX-4.2', g42, { parseXml });

// ─── Case a: BRDP-EXT-00013 (3.0.1) ─────────────────────────────────────────
const PATH_A = '(/dmodule/content/schedule/deftask | /dmodule/content/proced)/prelreqs/reqpers/perscat/trade';
const RULE_A = objrule(PATH_A, '0', '<objval valtype="single" val1="Mechanic"/>');
const a = checkRulePaths(RULE_A, 'BREX-3.0.1', g301, { parseXml });
check('a: available', a.available);
check('a: one problem (both alternatives share it)', a.problems.length === 1, JSON.stringify(a.problems));
const pa = a.problems[0];
check('a: kind child trade in perscat', pa?.kind === 'child' && pa.element === 'trade' && pa.parent === 'perscat');
check('a: only parent reqpers', JSON.stringify(pa?.parents) === '["reqpers"]');
check('a: every alternative impossible', a.allImpossible === true);
check('a: EN text', formatPathProblem(pa, en, { format: 'BREX-3.0.1' }) === 'The path cannot exist: <trade> does not go inside <perscat>; it goes inside <reqpers>.', formatPathProblem(pa, en));
check('a: ES text', formatPathProblem(pa, es, { format: 'BREX-3.0.1' }) === 'La ruta no puede existir: <trade> no va dentro de <perscat>; va dentro de <reqpers>.', formatPathProblem(pa, es));
check('a: fix removes perscat', pa?.fix?.kind === 'remove_steps' && pa.fix.from === 'reqpers/perscat/trade' && pa.fix.to === 'reqpers/trade');
check('a: fix button EN', formatPathFix(pa.fix, en) === 'Remove <perscat> from the path');
check('a: fix button ES', formatPathFix(pa.fix, es) === 'Quitar <perscat> de la ruta');
const fixedA = applyRulePathFix(RULE_A, pa.fix);
check('a: fix applied', fixedA.changed && fixedA.xml.includes('(/dmodule/content/schedule/deftask | /dmodule/content/proced)/prelreqs/reqpers/trade</objpath>'), fixedA.xml);
check('a: corrected rule has no problem', checkRulePaths(fixedA.xml, 'BREX-3.0.1', g301, { parseXml }).problems.length === 0);
check('a: union expanded', pathAlternatives(PATH_A).length === 2);
// flag 1: the same warning, and it says what the rule would reject.
const a1 = run301('//reqpers/perscat/trade', '1');
check('a flag 1: suffix', formatPathProblem(a1.problems[0], en, { format: 'BREX-3.0.1' }).endsWith('With objappl="1" the rule would reject every document that has <perscat>.'), formatPathProblem(a1.problems[0], en, { format: 'BREX-3.0.1' }));
check('a flag 1 ES', formatPathProblem(a1.problems[0], es, { format: 'BREX-3.0.1' }).endsWith('Con objappl="1" la regla rechazaría todo documento que tenga <perscat>.'));
check('a flag 1 BREX-4.2 attr name', formatPathProblem({ ...a1.problems[0] }, en, { format: 'BREX-4.2' }).includes('allowedObjectFlag="1"'));
// the fix never touches the objuse text
const withUse = objrule('//reqpers/perscat/trade').replace('<objuse>x</objuse>', '<objuse>Never reqpers/perscat/trade here</objuse>');
const fixedUse = applyRulePathFix(withUse, pa.fix);
check('fix only inside the path', fixedUse.xml.includes('<objuse>Never reqpers/perscat/trade here</objuse>') && fixedUse.xml.includes('//reqpers/trade</objpath>'), fixedUse.xml);

// ─── Case b: BRDP-EXT-00087 (3.0.1) ─────────────────────────────────────────
const RULE_B = objrule('/techstd[not(authex) or not(notes)]');
const b = checkRulePaths(RULE_B, 'BREX-3.0.1', g301, { parseXml });
check('b: one root problem', b.problems.length === 1 && b.problems[0].kind === 'root' && b.problems[0].element === 'techstd', JSON.stringify(b.problems));
check('b: way', JSON.stringify(b.problems[0]?.ways) === '["dmodule/idstatus/status"]');
check('b: EN text', formatPathProblem(b.problems[0], en, { format: 'BREX-3.0.1' }) === '<techstd> is never the root of a document; it goes in dmodule/idstatus/status.');
check('b: ES text', formatPathProblem(b.problems[0], es, { format: 'BREX-3.0.1' }) === '<techstd> nunca es la raíz de un documento; va en dmodule/idstatus/status.');
check('b: all impossible', b.allImpossible);
check('b: fix //techstd', b.problems[0].fix?.kind === 'descendant_root' && formatPathFix(b.problems[0].fix, en) === 'Change /techstd to //techstd');
check('b: fix ES', formatPathFix(b.problems[0].fix, es) === 'Cambiar /techstd por //techstd');
const fixedB = applyRulePathFix(RULE_B, b.problems[0].fix);
check('b: fix applied', fixedB.xml.includes('<objpath objappl="0">//techstd[not(authex) or not(notes)]</objpath>'), fixedB.xml);
check('b: corrected rule fine (predicate children exist)', checkRulePaths(fixedB.xml, 'BREX-3.0.1', g301, { parseXml }).problems.length === 0);
check('b: //techstd not touched again', !applyRulePathFix(fixedB.xml, b.problems[0].fix).changed);
check('b: root that is a root', run301('/dmodule//techstd').problems.length === 0);
check('b flag 1 suffix', formatPathProblem(run301('/techstd', '1').problems[0], en, { format: 'BREX-3.0.1' }).endsWith('would reject every document.'));

// ─── Case c: BRDP-EXT-02613 (3.0.1) -- a correct path ──────────────────────
check('c: /dmodule[not(//actref)] fine', run301('/dmodule[not(//actref)]').problems.length === 0);

// ─── Edge cases ─────────────────────────────────────────────────────────────
// several alternatives, one impossible: only that one, the rest still runs
const mixed = run301('//reqpers/trade | //perscat/trade');
check('mixed: one problem', mixed.problems.length === 1 && mixed.problems[0].alternative === '//perscat/trade', JSON.stringify(mixed.problems));
check('mixed: not all impossible', !mixed.allImpossible);
check('mixed: names the alternative', formatPathProblem(mixed.problems[0], en).startsWith('In the alternative //perscat/trade: The path cannot exist'));
check('mixed: ES alternative', formatPathProblem(mixed.problems[0], es).startsWith('En la alternativa //perscat/trade: La ruta no puede existir'));
// *, prefix, other axes: that pair is not checked
for (const p of ['//perscat/*/trade', '//perscat/x:trade', '//perscat/following-sibling::trade', '//perscat/../trade', '//perscat/self::node()/trade']) {
  check(`unchecked step: ${p}`, run301(p).problems.length === 0, JSON.stringify(run301(p).problems));
}
// a name the standard does not have: the name check says it, not this one
check('unknown element', run301('//perscat/pokemon').problems.length === 0);
check('unknown attribute', run301('//perscat/@pokemonattr').problems.length === 0);
// a path ending in text() or a function: the last step is not checked
check('text() last', run301('//reqpers/trade/text()').problems.length === 0);
check('text() after impossible pair', run301('//perscat/trade/text()').problems.length === 1);
check('function last', run301('//reqpers/trade/string(.)').problems.length === 0);
// several possible parents: no button, the alternatives listed
const many = run301('//perscat/para');
check('many parents: problem', many.problems.length === 1 && many.problems[0].parents.length > 1);
check('many parents: no fix', many.problems[0]?.fix === null);
check('many parents: "or" and "more"', / or /.test(formatPathProblem(many.problems[0], en)) && /more\.$/.test(formatPathProblem(many.problems[0], en)), formatPathProblem(many.problems[0], en));
// single parent not on the path: no button
const notOnPath = run301('//perscat/trade');
check('parent not on the path: no fix', notOnPath.problems[0]?.fix === null);
// descendant
const desc = run301('//perscat//trade');
check('descendant', desc.problems.length === 1 && desc.problems[0].kind === 'descendant', JSON.stringify(desc.problems));
check('descendant EN', formatPathProblem(desc.problems[0], en) === 'The path cannot exist: <trade> is never inside <perscat>; it goes inside <reqpers>.');
check('reachable descendant', run301('//prelreqs//trade').problems.length === 0);
// attribute
const attr = run301('//trade/@category');
const tradeAttrs = g301.elements.trade[0][2];
check('attribute: trade has no @category', !tradeAttrs.includes('category') && attr.problems.length === 1 && attr.problems[0].kind === 'attribute', JSON.stringify(attr.problems));
check('attribute EN', /^The path cannot exist: <trade> has no @category; @category is on <.+>/.test(formatPathProblem(attr.problems[0], en)), formatPathProblem(attr.problems[0], en));
check('attribute that exists', run301('//perscat/@category').problems.length === 0);
// predicates: simple child paths
const pred = run301('//techstd[not(trade)]');
check('predicate: problem', pred.problems.length === 1 && pred.problems[0].inPredicate && pred.problems[0].element === 'trade', JSON.stringify(pred.problems));
check('predicate: not all impossible', !pred.allImpossible);
check('predicate EN', formatPathProblem(pred.problems[0], en).startsWith('The condition [not(trade)] cannot be met as written: <trade> does not go inside <techstd>'), formatPathProblem(pred.problems[0], en));
check('predicate b/c', run301('//status[techstd/trade]').problems.some((p) => p.inPredicate && p.element === 'trade' && p.parent === 'techstd'));
check('predicate .//x', run301('//techstd[.//trade]').problems.some((p) => p.kind === 'descendant' && p.inPredicate));
check('predicate with comparison', run301("//reqpers[perscat = 'x']").problems.length === 0);
check('predicate number', run301('//reqpers[2]/trade').problems.length === 0);
// a condition is checked too, never "all impossible"
const cond = run301('//perscat/trade and //reqpers');
check('condition: problem', cond.problems.length === 1 && !cond.allImpossible, JSON.stringify(cond));

// ─── Scope: context schemas ─────────────────────────────────────────────────
// A pair valid in one schema and impossible in another (found in the real
// 4.2 graph, not written by hand).
const idx = graphIndex(g42);
let pair = null;
outer: for (const [name, variants] of Object.entries(g42.elements)) {
  for (const [schemas, children] of variants) {
    for (const child of children) {
      for (const s of g42.schemas) {
        if (schemas.includes(s)) continue;
        const parentHere = idx.bySchema.get(s)?.get(name);
        if (parentHere && idx.bySchema.get(s)?.get(child) && !parentHere.children.has(child) && /^[a-z]/i.test(child)) {
          pair = { parent: name, child, ok: schemas[0], bad: s };
          break outer;
        }
      }
    }
  }
}
check('scope: a pair found', Boolean(pair));
const URL = (s) => `http://www.s1000d.org/S1000D_4-2/xml_schema_flat/${s}.xsd`;
const scoped = (schema) => `<contextRules rulesContext="${URL(schema)}"><structureObjectRuleGroup>${sor(`//${pair.parent}/${pair.child}`)}</structureObjectRuleGroup></contextRules>`;
check('scope: general rule, valid somewhere → no warning', run42(sor(`//${pair.parent}/${pair.child}`)).problems.length === 0);
check(`scope: limited to ${pair.ok} → no warning`, run42(scoped(pair.ok)).problems.length === 0);
const bad = run42(scoped(pair.bad));
check(`scope: limited to ${pair.bad} → warning`, bad.problems.length === 1 && bad.problems[0].kind === 'child', `${JSON.stringify(pair)} ${JSON.stringify(bad.problems)}`);
check('scope: parents in that schema only', JSON.stringify(bad.problems[0]?.parents) === JSON.stringify(parentsOf(idx, [pair.bad], pair.child)));

// ─── DITA / Schematron ──────────────────────────────────────────────────────
const sch = (context) => `<sch:pattern xmlns:sch="http://purl.oclc.org/dsdl/schematron"><sch:rule context="${context}"><sch:assert test="true()">x</sch:assert></sch:rule></sch:pattern>`;
const runDita = (context) => checkRulePaths(sch(context), 'SCH-DITA', gDita, { parseXml });
check('dita: topic/topic nested is fine', runDita('topic/topic').problems.length === 0);
check('dita: note/p fine', runDita('note/p').problems.length === 0);
check('dita: a nested topic type is never judged (shell-dependent)', runDita('p/topic').problems.length === 0 && runDita('topic/concept').problems.length === 0);
const ditaBad = runDita('p/li');
check('dita: p/li impossible', ditaBad.problems.length === 1 && ditaBad.problems[0].element === 'li' && ditaBad.problems[0].parents.includes('ul'), JSON.stringify(ditaBad.problems));
const ditaRoot = runDita('/note');
check('dita: /note never a root', ditaRoot.problems.length === 1 && ditaRoot.problems[0].kind === 'root');
check('dita: /topic is a root', runDita('/topic').problems.length === 0);
check('dita: fix on a context', applyRulePathFix(sch('/note'), ditaRoot.problems[0].fix).xml.includes('context="//note"'));

// ─── Without a graph: nothing ───────────────────────────────────────────────
for (const g of [null, { available: false }]) {
  const none = checkRulePaths(RULE_B, 'BREX-3.0.1', g, { parseXml });
  check('no graph: no check', none.available === false && none.problems.length === 0 && !none.allImpossible);
}
check('S1000D 5.0: no graph', schemaGraph('S1000D 5.0').available === false);

// ─── Lint ───────────────────────────────────────────────────────────────────
const lintA = lintRule(RULE_A, 'BREX-3.0.1').filter((f) => f.kind === 'path that cannot exist');
check('lint: finding', lintA.length === 1 && lintA[0].detail === 'The path cannot exist: <trade> does not go inside <perscat>; it goes inside <reqpers>.', JSON.stringify(lintA));
check('lint: correct rule clean', lintRule(fixedA.xml, 'BREX-3.0.1').every((f) => f.kind !== 'path that cannot exist'));
check('lint: graph off', lintRule(RULE_A, 'BREX-3.0.1', { graph: false }).every((f) => f.kind !== 'path that cannot exist'));

// ─── The rule test: "review" before any LLM call ────────────────────────────
const noLlm = async () => {
  throw new Error('the LLM must not be called');
};
const testOf = (ruleXml, format, standard, graph) =>
  generateRuleTestExamples({
    ruleXml,
    format,
    standard,
    schemaLocation: null,
    brdp: { identifier: 'BRDP-EXT-00013', title: 'T', definition: 'D', proposal: 'P' },
    vocabulary: null,
    ask: noLlm,
    askProposalCheck: noLlm,
    ruleDescription: 'x',
    fetchSchemaCards: async () => {
      throw new Error('no fetch expected');
    },
    fetchStructure: async () => {
      throw new Error('no fetch expected');
    },
    fetchSchemaGraph: async () => graph,
    parseXml,
  });
for (const [label, rule] of [['a', RULE_A], ['b', RULE_B]]) {
  const result = await testOf(rule, 'BREX-3.0.1', 'S1000D 3.0.1', g301);
  check(`test ${label}: path_review, no LLM call`, result.status === 'path_review' && result.responses.length === 0, JSON.stringify(result).slice(0, 300));
  const record = verdictToTestRecord({ kind: 'review', path: result.reason });
  check(`test ${label}: recorded as review`, record.result === 'review' && record.reason.code === 'test_impossible_path');
  check(`test ${label}: reason text EN = warning text`, formatRuleTestReason(record.reason, en) === formatPathProblem((label === 'a' ? a : b).problems[0], en, { format: 'BREX-3.0.1' }));
  check(`test ${label}: reason JSON round trip`, formatRuleTestReason(JSON.parse(JSON.stringify(record.reason)), es).length > 0);
}
// with the graph failing, the test goes on as before (here: to the cards)
const failing = await generateRuleTestExamples({
  ruleXml: RULE_B, format: 'BREX-3.0.1', standard: 'S1000D 3.0.1', schemaLocation: null, brdp: { proposal: 'P' }, vocabulary: null, ask: noLlm,
  fetchSchemaCards: async () => ({ cards: {}, document_schemas: [] }),
  fetchStructure: async () => ({ available: false }),
  fetchSchemaGraph: async () => {
    throw new Error('network');
  },
  parseXml,
});
check('graph failure: no path review', failing.status !== 'path_review', failing.status);

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
