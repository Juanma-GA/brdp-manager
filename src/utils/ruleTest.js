// Test rule (T2 of 4, T2b): everything between the LLM's examples and the
// panel, deterministic and pure (no React, no API) so scripts/ can test it in
// Node.
// - materializeExample (T2b): the LLM writes only the content of an
//   insertion point; the application builds the complete fragment on the
//   schema's skeleton (utils/ruleTestSkeleton.js).
// - validateExample: well-formed XML + names checked against the standard's
//   vocabulary (same check as the rest of the app) + (T2b) the structure of
//   the example's schema: every child allowed inside its parent, every
//   attribute declared on its element. An example that fails is shown with
//   its warnings and never run -- never dropped (HR7).
// - exampleProblems (T2b): the same problems in English, for the one
//   automatic correction round.
// - runExample: the T1 engine on one example, compared with what the
//   example expects.
// - ruleTestVerdict: the global verdict (correct / incorrect / inconclusive
//   / not executable / nothing runnable).
// - xmlDisplayLines: the example re-indented, split into segments so the
//   panel can highlight the nodes the rule selected and dim the skeleton.
import { nodePath, parseXmlDocument, runRuleOnFragment } from './ruleTestEngine.js';
import { checkAgainstVocabulary } from './vocabularyCheck.js';
import { assembleExample, checkExampleStructure, formatStructureProblem } from './ruleTestSkeleton.js';

// Unprefixed element and attribute names of a parsed fragment. Prefixed
// names (xsi:…, xlink:…) and namespace declarations are not schema
// vocabulary and are left out.
function fragmentNames(doc) {
  const elements = new Set();
  const attributes = new Set();
  const walk = (el) => {
    if (!String(el.nodeName).includes(':')) elements.add(el.nodeName);
    for (const a of Array.from(el.attributes || [])) {
      if (!a.name.includes(':') && a.name !== 'xmlns') attributes.add(a.name);
    }
    for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) walk(n);
  };
  walk(doc.documentElement);
  return { elements: [...elements], attributes: [...attributes], camelCase: [] };
}

// T2b: the LLM's example ({ label, expected, schema, content }) on its
// schema's skeleton → the same example with `xml` (the complete fragment
// that is run and shown), `skeletonNodePaths` and `structure`.
// `setup` = { standard, schemaLocation, placements: { [schema]: { structure,
// placement } } }. A schema the application did not offer gets no xml; its
// validation says so. With a single offered schema, a missing schema is that
// one.
export function materializeExample(example, setup) {
  const offered = Object.keys(setup.placements || {});
  const schema = example.schema || (offered.length === 1 ? offered[0] : null);
  const entry = schema ? setup.placements[schema] : null;
  if (!entry) return { ...example, schema, xml: null, skeletonNodePaths: [], structure: null, unmaterialized: true };
  const { xml, skeletonNodePaths } = assembleExample({
    standard: setup.standard,
    schema,
    schemaLocation: setup.schemaLocation,
    placement: entry.placement,
    content: example.content,
  });
  return { ...example, schema, xml, skeletonNodePaths, structure: entry.structure, insertion: entry.placement.insertion };
}

// { wellFormed, error, names, structure, unknownSchema, runnable }
// `structure` (T2b) is the example's schema structure, or null (then only
// the vocabulary is checked).
export function validateExample(xml, vocabulary, parseXml = parseXmlDocument, structure = null, options = {}) {
  const empty = { available: false, notFound: [], wrongType: [] };
  if (options.unknownSchema) {
    return { wellFormed: true, error: null, names: empty, structure: [], unknownSchema: options.unknownSchema, runnable: false };
  }
  let doc;
  try {
    doc = parseXml(String(xml || ''));
    if (!doc?.documentElement) throw new Error('no root element');
  } catch (err) {
    return { wellFormed: false, error: err.message, names: empty, structure: [], unknownSchema: null, runnable: false };
  }
  const names = checkAgainstVocabulary(fragmentNames(doc), vocabulary);
  const namesOk = !names.available || (names.notFound.length === 0 && names.wrongType.length === 0);
  // A name the vocabulary already reports is not repeated as "does not exist
  // in the <schema> schema".
  const reported = new Set(names.notFound.map((n) => n.replace(/^[<@]|>$/g, '')));
  const structureProblems = structure
    ? checkExampleStructure(doc, structure).filter((p) => !(p.kind === 'unknownElement' && reported.has(p.element)))
    : [];
  return {
    wellFormed: true,
    error: null,
    names,
    structure: structureProblems,
    unknownSchema: null,
    runnable: namesOk && structureProblems.length === 0,
  };
}

// The validation problems of one example, in English (the correction
// request to the LLM).
export function exampleProblems(validation, { standard, schema } = {}) {
  const out = [];
  if (validation.unknownSchema) out.push(`schema "${validation.unknownSchema}" was not offered; use one of the listed schemas`);
  if (!validation.wellFormed) out.push(`not well-formed XML: ${validation.error}`);
  for (const name of validation.names?.notFound || []) out.push(`${name} does not exist in ${standard}`);
  for (const w of validation.names?.wrongType || []) {
    out.push(w.usedAs === 'element' ? `<${w.name}> is not an element (it is the attribute @${w.name})` : `@${w.name} is not an attribute (it is the element <${w.name}>)`);
  }
  for (const p of validation.structure || []) out.push(formatStructureProblem(p, schema));
  return out;
}

// One example → { validation, result (engine output) | null, matches }.
// matches: true/false when the rule ran and gave a verdict, null otherwise.
// A materialized example (T2b) is validated against its schema's structure.
export function runExample(ruleXml, format, example, { vocabulary = null, parseXml = parseXmlDocument } = {}) {
  const unknownSchema = example.unmaterialized ? example.schema || '(none)' : null;
  const validation = validateExample(example.xml, vocabulary, parseXml, example.structure || null, { unknownSchema });
  if (!validation.runnable) return { validation, result: null, matches: null };
  const result = runRuleOnFragment(ruleXml, format, example.xml, example.schema || null, { parseXml });
  const expectedStatus = example.expected === 'reject' ? 'rejected' : 'accepted';
  const matches = result.status === 'not_executable' ? null : result.status === expectedStatus;
  return { validation, result, matches };
}

// The global verdict from the examples and their runs:
//   { kind: 'not_executable', reason }  -- the rule cannot be tested (T2b:
//                                          analyzeRule, known before any
//                                          example) or the engine could not
//                                          judge an example
//   { kind: 'no_runnable' }             -- every example failed validation
//   { kind: 'inconclusive', why: 'nothing_selected' | 'missing_expectation' }
//   { kind: 'incorrect', permissive, strict } -- which way the rule was wrong
//   { kind: 'correct' }
export function ruleTestVerdict(examples, runs, analysis = null) {
  if (analysis?.status === 'not_executable') return { kind: 'not_executable', reason: analysis.reason };
  const ran = runs.filter((r) => r.result);
  const notExecutable = ran.find((r) => r.result.status === 'not_executable');
  if (notExecutable) return { kind: 'not_executable', reason: notExecutable.result.notExecutableReason };
  if (ran.length === 0) return { kind: 'no_runnable' };
  if (ran.every((r) => r.result.selectedNodePaths.length === 0)) return { kind: 'inconclusive', why: 'nothing_selected' };
  const ranExpectations = new Set(runs.map((r, i) => (r.result ? examples[i].expected : null)).filter(Boolean));
  const mismatches = runs.map((r, i) => (r.matches === false ? examples[i].expected : null)).filter(Boolean);
  if (mismatches.length > 0) {
    return {
      kind: 'incorrect',
      // accepted an example meant to violate it / rejected one meant to comply
      permissive: mismatches.includes('reject'),
      strict: mismatches.includes('accept'),
    };
  }
  if (!ranExpectations.has('accept') || !ranExpectations.has('reject')) return { kind: 'inconclusive', why: 'missing_expectation' };
  return { kind: 'correct' };
}

// ─── Display ────────────────────────────────────────────────────────────────
const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

// The fragment re-indented, as lines of segments:
//   [{ depth, segments: [{ text, highlight, skeleton }] }]
// highlight marks the tag of a selected element (start and end tag) and the
// name="value" of a selected attribute; skeleton (T2b) marks the tags of the
// application's skeleton (skeletonNodePaths), shown dimmed next to the
// LLM's content. An element with text inside (a <para>, even with
// <emphasis> in it) stays on one line. Display only: whitespace inside text
// is tidied, so the rule always runs on the example's own XML, never on
// these lines. null when the XML does not parse.
export function xmlDisplayLines(xml, selectedNodePaths = [], parseXml = parseXmlDocument, skeletonNodePaths = []) {
  let doc;
  try {
    doc = parseXml(String(xml || ''));
  } catch {
    return null;
  }
  const selected = new Set(selectedNodePaths);
  const skeleton = new Set(skeletonNodePaths);
  const lines = [];
  const startTag = (el, selfClose) => {
    const path = nodePath(el);
    const hl = selected.has(path);
    const sk = skeleton.has(path);
    const segments = [{ text: `<${el.nodeName}`, highlight: hl, skeleton: sk }];
    for (const a of Array.from(el.attributes || [])) {
      segments.push({ text: ' ', highlight: false, skeleton: sk });
      segments.push({ text: `${a.name}="${escAttr(a.value)}"`, highlight: selected.has(nodePath(a)), skeleton: sk });
    }
    segments.push({ text: selfClose ? '/>' : '>', highlight: hl, skeleton: sk });
    return segments;
  };
  const endTag = (el) => {
    const path = nodePath(el);
    return { text: `</${el.nodeName}>`, highlight: selected.has(path), skeleton: skeleton.has(path) };
  };
  const visible = (el) =>
    Array.from(el.childNodes).filter((n) => n.nodeType === 1 || n.nodeType === 8 || (n.nodeType === 3 || n.nodeType === 4) && n.data.trim());
  // Mixed content (text next to elements, as in a <para>) stays on one
  // line, the way a reader sees it.
  const inline = (el) => {
    const children = Array.from(el.childNodes).filter((n) => n.nodeType !== 7);
    if (children.length === 0 || children.every((n) => (n.nodeType === 3 || n.nodeType === 4) && !n.data.trim())) {
      return startTag(el, true);
    }
    const segments = startTag(el, false);
    for (const n of children) {
      if (n.nodeType === 1) segments.push(...inline(n));
      else if (n.nodeType === 8) segments.push({ text: `<!--${n.data}-->`, highlight: false, skeleton: false });
      else segments.push({ text: escText(n.data.replace(/\s+/g, ' ')), highlight: false, skeleton: false });
    }
    segments.push(endTag(el));
    return segments;
  };
  const walk = (el, depth) => {
    const children = visible(el);
    if (children.length === 0 || children.some((n) => n.nodeType === 3 || n.nodeType === 4)) {
      lines.push({ depth, segments: inline(el) });
      return;
    }
    lines.push({ depth, segments: startTag(el, false) });
    for (const n of children) {
      if (n.nodeType === 1) walk(n, depth + 1);
      else lines.push({ depth: depth + 1, segments: [{ text: `<!--${n.data}-->`, highlight: false, skeleton: false }] });
    }
    lines.push({ depth, segments: [endTag(el)] });
  };
  walk(doc.documentElement, 0);
  return lines;
}

// The indentation of a display line as real spaces, so a copied example
// keeps its structure (T2b, Part 6).
export function displayIndent(depth) {
  return '  '.repeat(depth);
}

// The display lines as plain text, indented with spaces ("Copy XML").
export function displayText(lines) {
  return lines.map((line) => displayIndent(line.depth) + line.segments.map((s) => s.text).join('')).join('\n');
}
