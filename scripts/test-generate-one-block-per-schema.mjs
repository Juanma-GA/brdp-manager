// Generate writes ONE context block per schema (BREX 4.2, 4.1, 3.0.1 and the
// Schematron made from them), and only warns about schema URLs a rule
// really compares with the DM's xsi:noNamespaceSchemaLocation.
//
// The round trip original BREX -> AI Extract -> Generate with the two real
// files of backend/tests/fixtures/brex/ (Lufthansa: 61 rules, 469
// nonContextRule; "CA": 5 536 rules), read with the same code as the
// import (scripts/lib/extractRules.mjs), generated with the real 4.2
// assembler (scripts/lib/nodeDom.mjs gives it a DOM in Node):
//   - the blocks, their order (general first, then each schema in order of
//     first appearance) and their rule counts;
//   - every rule of the original, the same (context, brDecisionRef, flag,
//     path, objectUse, values);
//   - valid against sources/S4.2/brex4.2.xsd;
//   - s1kd-brexcheck's selection (scripts/lib/brexcheckEmulation.mjs) picks
//     the same rules for each schema as in the original file;
//   - BRDP-S1-00146 (noNamespaceSchemaLocation only in a predicate) is not
//     warned about; the 11 contexts with S1000D 4.1 URLs still are.
// Plus the edge cases of mergeContextBlocks and of the per-rule decision.
// Run: node scripts/test-generate-one-block-per-schema.mjs
import fs from 'node:fs';
import { validateXML } from 'xmllint-wasm';
import { installNodeDom } from './lib/nodeDom.mjs';
import { extractRules } from './lib/extractRules.mjs';
import { selectedRules } from './lib/brexcheckEmulation.mjs';
import { mergeContextBlocks } from '../src/utils/ruleWrappers.js';
import { pathTargetsSchemaLocation, rewriteRuleSchemaUrls, rewriteApprovedRulesSchemaUrls } from '../src/utils/ruleSchemaContext.js';

installNodeDom();
const { generateBREX } = await import('../src/api/generateBREX.js');
const { generateBREX41 } = await import('../src/api/generateBREX41.js');
const { generateBREX301 } = await import('../src/api/generateBREX301.js');
const { generateBREXSch } = await import('../src/api/generateBREXSch.js');

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) passed += 1;
  else {
    failed += 1;
    console.log(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
  }
}
const summary = (file) => JSON.parse(fs.readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8'));
const parse = (text) => new DOMParser().parseFromString(text, 'text/xml');
const elements = (node, name) => Array.from(node.getElementsByTagName(name));
const child = (el, name) => Array.from(el.childNodes).find((n) => n.nodeType === 1 && n.nodeName === name) || null;
const kids = (el, name) => Array.from(el.childNodes).filter((n) => n.nodeType === 1 && n.nodeName === name);
const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const flat42 = (schema) => `http://www.s1000d.org/S1000D_4-2/xml_schema_flat/${schema}.xsd`;
const flat41 = (schema) => `http://www.s1000d.org/S1000D_4-1/xml_schema_flat/${schema}.xsd`;
const schemaName = (url) => (url ? url.replace(/^.*\//, '').replace(/\.xsd$/, '') : 'general');

async function xsdErrors(dir, main, xml) {
  const base = new URL(`../sources/${dir}/`, import.meta.url);
  const files = fs.readdirSync(base).filter((f) => f.endsWith('.xsd')).map((f) => ({ fileName: f, contents: fs.readFileSync(new URL(f, base), 'utf8') }));
  const text = xml.replace(/ xsi:noNamespaceSchemaLocation="[^"]*"/, '');
  const result = await validateXML({ xml: { fileName: 'brex.xml', contents: text }, schema: files.find((f) => f.fileName === main), preload: files.filter((f) => f.fileName !== main) });
  return result.errors.map((e) => e.rawMessage || e.message);
}

// The context blocks of a BREX 4.x: [{ context, rules }] in document order.
function contextBlocks(doc) {
  return elements(doc, 'contextRules').map((b) => ({
    context: b.hasAttribute('rulesContext') ? b.getAttribute('rulesContext') : null,
    rules: elements(b, 'structureObjectRule').length,
  }));
}

// Every structureObjectRule as a comparable key: its context, brDecisionRef,
// flag, path, objectUse and values.
function ruleKeys(doc) {
  const out = [];
  for (const rule of elements(doc, 'structureObjectRule')) {
    let p = rule.parentNode;
    while (p && p.nodeName !== 'contextRules') p = p.parentNode;
    const context = p && p.getAttribute('rulesContext') ? p.getAttribute('rulesContext') : '';
    const path = child(rule, 'objectPath');
    const ref = child(rule, 'brDecisionRef');
    out.push(
      JSON.stringify([
        context,
        ref ? ref.getAttribute('brDecisionIdentNumber') : '',
        path ? path.getAttribute('allowedObjectFlag') || '2' : '',
        squash(path?.textContent),
        squash(child(rule, 'objectUse')?.textContent),
        kids(rule, 'objectValue').map((v) => [v.getAttribute('valueForm') || '', v.getAttribute('valueAllowed') || '', squash(v.textContent)]),
      ])
    );
  }
  return out.sort();
}

// The rules s1kd-brexcheck picks for each schema, as rule keys.
function selectionBySchema(doc, schemas) {
  const keyOf = new Map();
  const all = elements(doc, 'structureObjectRule');
  const keys = ruleKeys(doc); // sorted -- recompute per element instead
  void keys;
  for (const rule of all) {
    const path = child(rule, 'objectPath');
    keyOf.set(rule, JSON.stringify([rule.getAttribute('id') || '', child(rule, 'brDecisionRef')?.getAttribute('brDecisionIdentNumber') || '', squash(path?.textContent), path?.getAttribute('allowedObjectFlag') || '2', kids(rule, 'objectValue').map((v) => v.getAttribute('valueAllowed'))]));
  }
  const out = new Map();
  for (const schema of schemas) out.set(schema, selectedRules(doc, schema).map((r) => keyOf.get(r)).sort());
  return out;
}

async function roundTrip(file) {
  const path = new URL(`../backend/tests/fixtures/brex/${file}`, import.meta.url);
  const original = fs.readFileSync(path, 'utf8');
  const extracted = extractRules(path.pathname, 'BREX-4.2', 'S1000D 4.2', '4.2');
  const withRule = extracted.candidates.filter((c) => c.rule_xml);
  const brdps = withRule.map((c, i) => ({ id: `b${i}`, identifier: c.identifier, validation: 'Validated' }));
  const approvals = new Map(withRule.map((c, i) => [`b${i}`, { brdp_id: `b${i}`, status: 'approved', rule_xml: c.rule_xml }]));
  const out = await generateBREX(brdps, { modelIdentCode: 'TEST', projectName: 'x' }, { approvals, schemaSummary: summary('brex-schema-summary-4-2.json') });
  return { original, extracted, withRule, out, doc: parse(out.xml), originalDoc: parse(original) };
}

// ── 1. Lufthansa ─────────────────────────────────────────────────────────
{
  const { withRule, out, doc, originalDoc } = await roundTrip('DMC-LHTSTD-A-00-00-00-000A-022A-D_001-00_SX-US.xml');
  check('Lufthansa: generated', out.valid, out.error);
  const blocks = contextBlocks(doc).map((b) => [schemaName(b.context), b.rules]);
  check(
    'Lufthansa: one block per schema with its rules',
    JSON.stringify(blocks) === JSON.stringify([['general', 40], ['ddn', 2], ['condcrossreftable', 1], ['fault', 1], ['prdcrossreftable', 1], ['proced', 4], ['ipd', 3], ['pm', 1], ['comrep', 8]]),
    JSON.stringify(blocks)
  );
  // Order: general first, then each schema as it first appears in the BRDPs.
  const firstSeen = [];
  for (const c of withRule) for (const m of c.rule_xml.matchAll(/rulesContext="([^"]+)"/g)) if (!firstSeen.includes(m[1])) firstSeen.push(m[1]);
  check('Lufthansa: schema blocks in order of first appearance', JSON.stringify(contextBlocks(doc).slice(1).map((b) => b.context)) === JSON.stringify(firstSeen));
  check('Lufthansa: 61 rules, as in the original', elements(doc, 'structureObjectRule').length === 61 && JSON.stringify(ruleKeys(doc)) === JSON.stringify(ruleKeys(originalDoc)));
  check('Lufthansa: 469 nonContextRule', elements(doc, 'nonContextRule').length === 469);
  const xsd = await xsdErrors('S4.2', 'brex4.2.xsd', out.xml);
  check('Lufthansa: valid against brex4.2.xsd', xsd.length === 0, xsd.slice(0, 3).join(' | '));
  check('Lufthansa: no schema URL left unrecognized', out.schemaUrls.unrecognized.length === 0, JSON.stringify(out.schemaUrls.unrecognized));
  const schemas = [...new Set([...firstSeen, flat42('descript'), flat42('crew')])];
  const before = selectionBySchema(originalDoc, schemas);
  const after = selectionBySchema(doc, schemas);
  check('Lufthansa: s1kd-brexcheck picks the same rules for every schema', schemas.every((s) => JSON.stringify(before.get(s)) === JSON.stringify(after.get(s))), schemas.filter((s) => JSON.stringify(before.get(s)) !== JSON.stringify(after.get(s))).join(', '));
  check('Lufthansa: proced picks the general rules plus its 4', after.get(flat42('proced')).length === 44);
}

// ── 2. CA ────────────────────────────────────────────────────────────────
{
  const t0 = Date.now();
  const { out, doc, originalDoc } = await roundTrip('DMC-CAAA00000000AAA022AD-001-00-SX-ZZ.xml');
  check('CA: generated', out.valid, out.error);
  const blocks = contextBlocks(doc).map((b) => [b.context ? schemaName(b.context) : 'general', b.rules, b.context]);
  check(
    'CA: 4 blocks (general 5525, dml 9, ddn 1, pm 1)',
    JSON.stringify(blocks.map((b) => [b[0], b[1]])) === JSON.stringify([['general', 5525], ['dml', 9], ['ddn', 1], ['pm', 1]]),
    JSON.stringify(blocks.map((b) => [b[0], b[1]]))
  );
  check('CA: the schema blocks keep their S1000D 4.1 URLs (not recognized, left as written)', blocks.slice(1).every((b) => b[2] === flat41(b[0])));
  const origKeys = ruleKeys(originalDoc);
  const genKeys = ruleKeys(doc);
  check('CA: 5 536 rules equal to the original', genKeys.length === 5536 && origKeys.length === 5536 && JSON.stringify(genKeys) === JSON.stringify(origKeys), `${genKeys.length} / ${origKeys.length}`);
  const xsd = await xsdErrors('S4.2', 'brex4.2.xsd', out.xml);
  check('CA: valid against brex4.2.xsd', xsd.length === 0, xsd.slice(0, 3).join(' | '));
  const unrec = out.schemaUrls.unrecognized;
  check('CA: BRDP-S1-00146 not warned about', !unrec.some((u) => u.identifier === 'BRDP-S1-00146'));
  const contextWarnings = unrec.flatMap((u) => u.values.filter((v) => v.where === 'context').map((v) => [u.identifier, v.value]));
  check(
    'CA: the 11 contexts with S1000D 4.1 URLs still warned',
    contextWarnings.length === 11 && contextWarnings.every(([, v]) => v.includes('S1000D_4-1')),
    JSON.stringify(contextWarnings)
  );
  check('CA: nothing else warned', unrec.every((u) => u.values.every((v) => v.where === 'context')), JSON.stringify(unrec.filter((u) => u.values.some((v) => v.where !== 'context'))));
  const schemas = [flat41('dml'), flat41('ddn'), flat41('pm'), flat42('dml'), flat42('descript')];
  const before = selectionBySchema(originalDoc, schemas);
  const after = selectionBySchema(doc, schemas);
  check('CA: s1kd-brexcheck picks the same rules for every schema', schemas.every((s) => JSON.stringify(before.get(s)) === JSON.stringify(after.get(s))));
  check('CA: generated in a reasonable time', Date.now() - t0 < 60000, `${Date.now() - t0} ms`);
}

// ── 3. mergeContextBlocks: edge cases ────────────────────────────────────
const rule42 = (id, path) => `<structureObjectRule id="${id}"><objectPath allowedObjectFlag="0">${path}</objectPath><objectUse>${id}</objectUse></structureObjectRule>`;
const block42 = (context, inner, attrs = '') => `<contextRules rulesContext="${context}"${attrs}>\n  <structureObjectRuleGroup>\n    ${inner}\n  </structureObjectRuleGroup>\n</contextRules>`;
{
  const a = block42(flat42('proced'), rule42('a', '//a'));
  const b = block42(flat42('proced'), `<!-- b's comment -->\n    ${rule42('b', '//b')}`);
  const c = block42(flat42('ipd'), rule42('c', '//c'));
  const merged = mergeContextBlocks([a, c, b], 'BREX-4.2');
  check('merge: same schema -> one block, at its first place', merged.length === 2 && merged[0].includes('id="a"') && merged[0].includes('id="b"') && merged[1] === c);
  check('merge: rules in BRDP order, comment kept with its rule', merged[0].indexOf('id="a"') < merged[0].indexOf("b's comment") && merged[0].indexOf("b's comment") < merged[0].indexOf('id="b"'));
  check('merge: one structureObjectRuleGroup', (merged[0].match(/<structureObjectRuleGroup>/g) || []).length === 1);
  check('merge: a block alone is kept byte for byte', mergeContextBlocks([a], 'BREX-4.2')[0] === a);
  const other = block42(flat42('proced'), rule42('d', '//d'), ' id="ctx-2"');
  check('merge: same schema, other contextRules attributes -> not merged', mergeContextBlocks([a, other], 'BREX-4.2').length === 2);
  const notations = `<contextRules rulesContext="${flat42('proced')}">\n  <notationRuleList>\n    <notationRule><notationName allowedNotationFlag="1">cgm</notationName></notationRule>\n  </notationRuleList>\n</contextRules>`;
  const withNotation = mergeContextBlocks([a, notations, b], 'BREX-4.2');
  check('merge: one notationRuleList after the group', withNotation.length === 1 && (withNotation[0].match(/<notationRuleList>/g) || []).length === 1 && withNotation[0].indexOf('</structureObjectRuleGroup>') < withNotation[0].indexOf('<notationRuleList>'));
  const odd = `<contextRules rulesContext="${flat42('proced')}"><structureObjectRuleGroup>${rule42('e', '//e')}</structureObjectRuleGroup>text</contextRules>`;
  check('merge: a block of another shape is never touched', JSON.stringify(mergeContextBlocks([a, odd], 'BREX-4.2')) === JSON.stringify([a, odd]));
  const r301 = (id) => `<objrule id="${id}"><objpath objappl="0">//${id}</objpath><objuse>${id}</objuse></objrule>`;
  const b301 = (ctx, id) => `<contextrules context="${ctx}">\n  <structrules>\n    ${r301(id)}\n  </structrules>\n</contextrules>`;
  const m301 = mergeContextBlocks([b301('x.xsd', 'p'), b301('y.xsd', 'q'), b301('x.xsd', 'r')], 'BREX-3.0.1');
  check('merge: 3.0.1 contextrules/structrules', m301.length === 2 && (m301[0].match(/<structrules>/g) || []).length === 1 && m301[0].includes('id="r"'));
}

// Through the generators: S1-00006-like rule (general rule + schema block),
// flat vs custom compared after the rewrite, rulesContext="" stays general.
{
  const s00006 = `${rule42('S1-00006', '//dmodule')}\n${block42(flat42('fault'), rule42('S1-00006-f', '//x'))}`;
  const other = block42(flat42('fault'), rule42('S1-00099', '//y'));
  const emptyCtx = `<contextRules rulesContext="">\n  <structureObjectRuleGroup>\n    ${rule42('S1-00100', '//z')}\n  </structureObjectRuleGroup>\n</contextRules>`;
  const brdps = ['B1', 'B2', 'B3'].map((id, i) => ({ id, identifier: `BRDP-S1-0000${i}`, validation: 'Validated' }));
  const approvals = new Map([['B1', s00006], ['B2', other], ['B3', emptyCtx]].map(([id, rule_xml]) => [id, { brdp_id: id, status: 'approved', rule_xml }]));
  const out = await generateBREX(brdps, { modelIdentCode: 'TEST', projectName: 'x' }, { approvals, schemaSummary: summary('brex-schema-summary-4-2.json') });
  const blocks = contextBlocks(parse(out.xml));
  check('S1-00006: general rule in the general block, its fault block merged with the other fault rule', JSON.stringify(blocks.map((b) => [schemaName(b.context), b.rules])) === JSON.stringify([['general', 2], ['fault', 2]]), JSON.stringify(blocks));
  check('rulesContext="" still general (never written)', !out.xml.includes('rulesContext=""'));

  const custom = (s) => `../schemas/${s}.xsd`;
  const viaCustom = block42(custom('proced'), rule42('C1', '//c1'));
  const viaFlat = block42(flat42('proced'), rule42('C2', '//c2'));
  const ap = new Map([['B1', viaCustom], ['B2', viaFlat]].map(([id, rule_xml]) => [id, { brdp_id: id, status: 'approved', rule_xml }]));
  const outCustom = await generateBREX(brdps.slice(0, 2), { modelIdentCode: 'TEST', projectName: 'x', schemaLocation: 'custom', schemaLocationPattern: '../schemas/{schema}.xsd' }, { approvals: ap, schemaSummary: summary('brex-schema-summary-4-2.json') });
  const cb = contextBlocks(parse(outCustom.xml));
  // (no general rule: the empty general block is left out)
  check('flat and custom of the same schema: compared after the rewrite, one block', cb.length === 1 && cb[0].context === custom('proced') && cb[0].rules === 2, JSON.stringify(cb));

  // 4.1 and 3.0.1 generators merge too.
  const b41 = (ctx, id) => `<contextRules rulesContext="${ctx}">\n  <structureObjectRuleGroup>\n    <structureObjectRule id="${id}"><objectPath allowedObjectFlag="0">//${id}</objectPath><objectUse>${id}</objectUse></structureObjectRule>\n  </structureObjectRuleGroup>\n</contextRules>`;
  const a41 = new Map([['B1', b41(flat41('proced'), 'p1')], ['B2', b41(flat41('ipd'), 'p2')], ['B3', b41(flat41('proced'), 'p3')]].map(([id, rule_xml]) => [id, { brdp_id: id, status: 'approved', rule_xml }]));
  const out41 = await generateBREX41(brdps, { modelIdentCode: 'TEST', projectName: 'x' }, { approvals: a41, schemaSummary: summary('brex-schema-summary-4-1.json') });
  const k41 = contextBlocks(parse(out41.xml)).map((b) => [schemaName(b.context), b.rules]);
  check('4.1: one block per schema', JSON.stringify(k41) === JSON.stringify([['proced', 2], ['ipd', 1]]), JSON.stringify(k41));
  const xsd41 = await xsdErrors('S4.1', 'brex4.1.xsd', out41.xml);
  check('4.1: valid against brex4.1.xsd', xsd41.length === 0, xsd41.slice(0, 3).join(' | '));
  const f301 = (s) => `http://www.s1000d.org/S1000D_3-0-1/xml_schema_flat/${s}.xsd`;
  const c301 = (ctx, id) => `<contextrules context="${ctx}">\n  <structrules>\n    <objrule id="${id}"><objpath objappl="0">//${id}</objpath><objuse>${id}</objuse></objrule>\n  </structrules>\n</contextrules>`;
  const a301 = new Map([['B1', c301(f301('proced'), 'q1')], ['B2', c301(f301('ipd'), 'q2')], ['B3', c301(f301('proced'), 'q3')]].map(([id, rule_xml]) => [id, { brdp_id: id, status: 'approved', rule_xml }]));
  const out301 = await generateBREX301(brdps, { modelIdentCode: 'TEST', projectName: 'x' }, { approvals: a301, schemaSummary: summary('brex-schema-summary-3-0-1.json') });
  const d301 = parse(out301.xml);
  const k301 = elements(d301, 'contextrules').filter((b) => b.getAttribute('context')).map((b) => [schemaName(b.getAttribute('context')), elements(b, 'objrule').length]);
  check('3.0.1: one block per schema', JSON.stringify(k301) === JSON.stringify([['proced', 2], ['ipd', 1]]), JSON.stringify(k301));
  const xsd301 = await xsdErrors('S3.0.1', 'brex.xsd', out301.xml);
  check('3.0.1: valid against brex.xsd', xsd301.length === 0, xsd301.slice(0, 3).join(' | '));
  const sch = await generateBREXSch(brdps, { modelIdentCode: 'TEST', projectName: 'x' }, { approvals: a301, schemaSummary: summary('brex-schema-summary-3-0-1.json') });
  check('Schematron from 3.0.1: the merged proced block gives both rules', sch.xml.includes('q1') && sch.xml.includes('q3'));
}

// ── 4. Schema URL warnings decided rule by rule ──────────────────────────
{
  check('target: //@xsi:noNamespaceSchemaLocation', pathTargetsSchemaLocation('//@xsi:noNamespaceSchemaLocation'));
  check('target: /dmodule/@xsi:noNamespaceSchemaLocation', pathTargetsSchemaLocation('/dmodule/@xsi:noNamespaceSchemaLocation'));
  check('target: one alternative of a union', pathTargetsSchemaLocation('//@x | //@xsi:noNamespaceSchemaLocation'));
  check('target: attribute:: axis', pathTargetsSchemaLocation('/dmodule/attribute::xsi:noNamespaceSchemaLocation'));
  check('not a target: only in a predicate', !pathTargetsSchemaLocation("//dmodule[contains(@xsi:noNamespaceSchemaLocation, 'proced')]//@tradeCode"));
  check('not a target: inside a string literal', !pathTargetsSchemaLocation("//@x[. = '@xsi:noNamespaceSchemaLocation']"));

  // S1-00146-like: predicate only -> values are not schema URLs, no warning.
  const s00146 = `<structureObjectRule id="S1-00146"><objectPath allowedObjectFlag="2">//dmodule[contains(@xsi:noNamespaceSchemaLocation, 'ipd')]//@tradeCode</objectPath><objectUse>Trade codes</objectUse><objectValue valueForm="single" valueAllowed="A1">A1</objectValue></structureObjectRule>`;
  const r146 = rewriteRuleSchemaUrls(s00146, 'BREX-4.2', 'S1000D 4.2', 'flat');
  check('S1-00146: values intact, no warning', r146.xml === s00146 && r146.unrecognized.length === 0, JSON.stringify(r146.unrecognized));

  // EXT-02772-like: the path targets the attribute -> rewrite as before.
  const target = (vals) => `<structureObjectRule id="T"><objectPath allowedObjectFlag="2">//@xsi:noNamespaceSchemaLocation</objectPath><objectUse>Schemas</objectUse>${vals}</structureObjectRule>`;
  const master = `<objectValue valueForm="single" valueAllowed="http://www.s1000d.org/S1000D_4-2/xml_schema_flat/proced.xsd">p</objectValue>`;
  const rt = rewriteRuleSchemaUrls(target(master), 'BREX-4.2', 'S1000D 4.2', '../schemas/{schema}.xsd');
  check('target rule: values rewritten to the project form', rt.xml.includes('valueAllowed="../schemas/proced.xsd"'));
  const unknown = `<objectValue valueForm="single" valueAllowed="urn:x:proced.xsd">p</objectValue>`;
  const ru = rewriteRuleSchemaUrls(target(unknown), 'BREX-4.2', 'S1000D 4.2', 'flat');
  check('target rule: unrecognized value still warned', ru.unrecognized.some((v) => v.value === 'urn:x:proced.xsd'));

  // One fragment, one rule of each kind: each decided on its own.
  const both = `${s00146}\n${target(unknown)}`;
  const rb = rewriteRuleSchemaUrls(both, 'BREX-4.2', 'S1000D 4.2', 'flat');
  check('two rules in a fragment: only the target rule warned', rb.unrecognized.length === 1 && rb.unrecognized[0].value === 'urn:x:proced.xsd' && rb.xml.includes('valueAllowed="A1"'), JSON.stringify(rb.unrecognized));
  // A value ending in .xsd is still warned, whatever the path (kept).
  const xsdValue = s00146.replace('valueAllowed="A1"', 'valueAllowed="other.xsd"');
  check('non-target rule: a value ending in .xsd still warned', rewriteRuleSchemaUrls(xsdValue, 'BREX-4.2', 'S1000D 4.2', 'flat').unrecognized.some((v) => v.value === 'other.xsd'));
  const all = rewriteApprovedRulesSchemaUrls([{ identifier: 'BRDP-S1-00146', xml: s00146 }], 'BREX-4.2', 'S1000D 4.2', 'flat');
  check('S1-00146 in Generate\'s report: nothing', all.schemaUrls.unrecognized.length === 0 && all.schemaUrls.rewritten.length === 0, JSON.stringify(all.schemaUrls));
  // Unrecognized contexts are still warned whatever the rule's path.
  const ctx = block42('urn:other:proced.xsd', rule42('U', '//u'));
  check('unrecognized context still warned', rewriteRuleSchemaUrls(ctx, 'BREX-4.2', 'S1000D 4.2', 'flat').unrecognized.some((v) => v.where === 'context'));
  // 3.0.1: objrule / objpath / objval val1.
  const t301 = `<objrule id="X"><objpath>//dmodule[contains(@xsi:noNamespaceSchemaLocation, 'x')]//@a</objpath><objuse>u</objuse><objval valtype="single" val1="v"/></objrule>`;
  check('3.0.1: predicate only, no warning', rewriteRuleSchemaUrls(t301, 'BREX-3.0.1', 'S1000D 3.0.1', 'flat').unrecognized.length === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
