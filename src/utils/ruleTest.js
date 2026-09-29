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
import {
  addMissingCalsColspecs,
  checkAgainstVocabulary,
  checkCalsColspecs,
  checkCalsTableSpans,
  checkExampleStructure,
  extractDocumentNames,
  formatStructureProblem,
  removeSpannedCalsEntries,
} from '../validation/schemaValidation.js';
import { SKELETON_TEXT_SUFFIX, assembleExample } from './ruleTestSkeleton.js';

// Unprefixed element and attribute names of a parsed fragment. Prefixed
// names (xsi:…, xlink:…) and namespace declarations are not schema
// vocabulary and are left out.

// T2b: the LLM's example ({ label, expected, schema, content }) on its
// schema's skeleton → the same example with `xml` (the complete fragment
// that is run and shown), `skeletonNodePaths` and `structure`.
// `setup` = { standard, schemaLocation, placements: { [schema]: { structure,
// placement } } }. A schema the application did not offer gets no xml; its
// validation says so. With a single offered schema, a missing schema is that
// one.
//
// C3b: before anything else, the application removes the table cells that
// sit in a column a morerows above already covers (always an error, always
// the same fix -- see removeSpannedCalsEntries). The example then carries
// the fixed content and `spannedEntriesRemoved` (the rows, one per removed
// cell) for the panel's "Adjusted by the app" note. Every path goes through
// here: the LLM's first answer, the correction round, "Run again" on an
// edited example and the prompt eval.
// C3b follow-up: first of all, the colspecs its tables' colnames need and do
// not have are added (addMissingCalsColspecs), so the morerows fix and the
// checks read the columns by name; the example carries `colspecsAdded`.
export function materializeExample(example, setup, parseXml = parseXmlDocument) {
  const offered = Object.keys(setup.placements || {});
  const schema = example.schema || (offered.length === 1 ? offered[0] : null);
  const withColspecs = addMissingCalsColspecs(example.content, parseXml);
  const { content, removedRows } = removeSpannedCalsEntries(withColspecs.content, parseXml);
  const adjusted = { ...example, content, colspecsAdded: withColspecs.added, spannedEntriesRemoved: removedRows };
  const entry = schema ? setup.placements[schema] : null;
  if (!entry) return { ...adjusted, schema, xml: null, skeletonNodePaths: [], structure: null, unmaterialized: true };
  const { xml, skeletonNodePaths } = assembleExample({
    standard: setup.standard,
    schema,
    schemaLocation: setup.schemaLocation,
    placement: entry.placement,
    content,
    metadata: example.metadata,
  });
  // Rule test on DM metadata: the rule looks at the identification and
  // status section, so the LLM had to write it; an example without it is
  // not run (its validation says so).
  const section = entry.placement.metadata;
  const missingMetadata =
    section?.insertion && entry.placement.path.length > 0 && !String(example.metadata || '').trim() ? section.element : null;
  return {
    ...adjusted,
    schema,
    xml,
    skeletonNodePaths,
    structure: entry.structure,
    insertion: entry.placement.insertion,
    metadataElement: section?.insertion && entry.placement.path.length > 0 ? section.element : null,
    contentInsertion: entry.placement.contentInsertion !== false,
    missingMetadata,
  };
}

// { wellFormed, error, names, structure, cards, unknownSchema, runnable }
// `structure` (T2b) is the example's schema structure, or null (then only
// the vocabulary is checked). `structure` in the result also carries the
// CALS table-span problems (C3, Part 1b), which need no schema.
export function validateExample(xml, vocabulary, parseXml = parseXmlDocument, structure = null, options = {}) {
  const empty = { available: false, notFound: [], wrongType: [] };
  if (options.unknownSchema) {
    return { wellFormed: true, error: null, names: empty, structure: [], cards: [], unknownSchema: options.unknownSchema, runnable: false };
  }
  if (options.missingMetadata) {
    return { wellFormed: true, error: null, names: empty, structure: [], cards: [], unknownSchema: null, missingMetadata: options.missingMetadata, runnable: false };
  }
  let doc;
  try {
    doc = parseXml(String(xml || ''));
    if (!doc?.documentElement) throw new Error('no root element');
  } catch (err) {
    return { wellFormed: false, error: err.message, names: empty, structure: [], cards: [], unknownSchema: null, runnable: false };
  }
  const names = checkAgainstVocabulary(extractDocumentNames(doc), vocabulary);
  const namesOk = !names.available || (names.notFound.length === 0 && names.wrongType.length === 0);
  // A name the vocabulary already reports is not repeated as "does not exist
  // in the <schema> schema".
  const reported = new Set(names.notFound.map((n) => n.replace(/^[<@]|>$/g, '')));
  const structureProblems = [
    ...(structure
      ? checkExampleStructure(doc, structure).filter((p) => !(p.kind === 'unknownElement' && reported.has(p.element)))
      : []),
    ...checkCalsColspecs(doc),
    ...checkCalsTableSpans(doc),
  ];
  return {
    wellFormed: true,
    error: null,
    names,
    structure: structureProblems,
    cards: structure ? elementCards(doc, names, structureProblems, structure) : [],
    unknownSchema: null,
    runnable: namesOk && structureProblems.length === 0,
  };
}

// ─── Element cards for the correction round (C3, Part 1a) ──────────────────
// A real run wrote <quantity quantityValue="25" unitOfMeasure="N·m"> and,
// asked to fix it, <quantity><quantityValue>… -- both invalid, because the
// correction request only said what was wrong, never what the element takes.
// For every problem about an element (a child not allowed inside it, an
// element there that does not exist in the schema, an attribute it does not
// have, an attribute that is really an element or the reverse), the request
// now carries a compact card of that element in the example's schema: its
// allowed children and its attributes, from the same structure the check
// used. Lists over CARD_MAX_NAMES are cut with "+N more".
export const CARD_MAX_NAMES = 20;

function elementsNamed(doc, predicate) {
  const out = [];
  const walk = (el) => {
    if (predicate(el)) out.push(el);
    for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) walk(n);
  };
  walk(doc.documentElement);
  return out;
}

function elementCards(doc, names, problems, structure) {
  const wanted = [];
  const want = (name) => {
    if (name && structure.elements[name] && !wanted.includes(name)) wanted.push(name);
  };
  for (const p of problems) {
    if (p.kind === 'notAllowed') want(p.parent);
    else if (p.kind === 'unknownAttribute') want(p.element);
    else if (p.kind === 'unknownElement') {
      for (const el of elementsNamed(doc, (e) => e.nodeName === p.element)) want(el.parentNode?.nodeName);
    }
  }
  for (const w of names.wrongType || []) {
    if (w.usedAs === 'element') {
      // <x> written as an element, but x is an attribute: the card of the
      // element it was written inside says where @x may go.
      for (const el of elementsNamed(doc, (e) => e.nodeName === w.name)) want(el.parentNode?.nodeName);
    } else {
      // @x written as an attribute, but x is an element: the element that
      // carries it, and the element x itself.
      for (const el of elementsNamed(doc, (e) => e.hasAttribute?.(w.name))) want(el.nodeName);
      want(w.name);
    }
  }
  return wanted.map((element) => ({
    element,
    children: [...structure.elements[element].children],
    attributes: [...structure.elements[element].attributes],
  }));
}

// "a, b, c" with at most CARD_MAX_NAMES names, then "+N more".
export function cardNameList(names, prefix = '') {
  if (!names.length) return 'none';
  const shown = names.slice(0, CARD_MAX_NAMES).map((n) => `${prefix}${n}`).join(', ');
  const omitted = names.length - CARD_MAX_NAMES;
  return omitted > 0 ? `${shown}, +${omitted} more` : shown;
}

export function formatElementCard(card, schema) {
  const where = schema ? ` in the ${schema} schema` : '';
  return `card of <${card.element}>${where}: allowed children: ${cardNameList(card.children)}; attributes: ${cardNameList(card.attributes, '@')}`;
}

// C3b: an example often fails on the markup of an element the rule does
// not even look at (a real run: <quantity> and <dmCode> written wrong in
// "Procedure without emphasis", for a rule about <emphasis>). The problem
// about such an element then also offers the simplest fix.
export const PLAIN_TEXT_HINT = 'If this element is not needed to test the rule, remove it and use plain text.';

// The validation problems of one example, in English (the correction
// request to the LLM), followed by the cards of the elements involved.
// `ruleNames` ({ elements, attributes } of the rule, extractRuleNames), when
// given, adds PLAIN_TEXT_HINT to each problem about the markup of an element
// the rule does not name.
export function exampleProblems(validation, { standard, schema, ruleNames = null } = {}) {
  const ruleElements = new Set(ruleNames?.elements || []);
  const ruleAttributes = new Set(ruleNames?.attributes || []);
  const offer = (line, element, alsoAttribute = false) =>
    ruleNames && element && !ruleElements.has(element) && !(alsoAttribute && ruleAttributes.has(element))
      ? `${line}. ${PLAIN_TEXT_HINT}`
      : line;
  const out = [];
  if (validation.unknownSchema) out.push(`schema "${validation.unknownSchema}" was not offered; use one of the listed schemas`);
  if (validation.missingMetadata) out.push(`"metadata" is missing: write the complete <${validation.missingMetadata}> of this example`);
  if (!validation.wellFormed) out.push(`not well-formed XML: ${validation.error}`);
  for (const name of validation.names?.notFound || []) {
    const element = /^<(.+)>$/.exec(name)?.[1];
    out.push(offer(`${name} does not exist in ${standard}`, element));
  }
  for (const w of validation.names?.wrongType || []) {
    out.push(
      w.usedAs === 'element'
        ? offer(`<${w.name}> is not an element (it is the attribute @${w.name})`, w.name, true)
        : `@${w.name} is not an attribute (it is the element <${w.name}>)`
    );
  }
  for (const p of validation.structure || []) {
    const element = ['unknownElement', 'notAllowed', 'unknownAttribute'].includes(p.kind) ? p.element : null;
    out.push(offer(formatStructureProblem(p, schema), element));
  }
  for (const card of validation.cards || []) out.push(formatElementCard(card, schema));
  return out;
}

// One example → { validation, result (engine output) | null, matches }.
// matches: true/false when the rule ran and gave a verdict, null otherwise.
// A materialized example (T2b) is validated against its schema's structure.
export function runExample(ruleXml, format, example, { vocabulary = null, parseXml = parseXmlDocument } = {}) {
  const unknownSchema = example.unmaterialized ? example.schema || '(none)' : null;
  const validation = validateExample(example.xml, vocabulary, parseXml, example.structure || null, {
    unknownSchema,
    missingMetadata: example.missingMetadata || null,
  });
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
    // The text of a skeleton element the application wrote (a DITA title).
    const skeletonText = skeleton.has(`${nodePath(el)}${SKELETON_TEXT_SUFFIX}`);
    for (const n of children) {
      if (n.nodeType === 1) segments.push(...inline(n));
      else if (n.nodeType === 8) segments.push({ text: `<!--${n.data}-->`, highlight: false, skeleton: false });
      else segments.push({ text: escText(n.data.replace(/\s+/g, ' ')), highlight: false, skeleton: skeletonText });
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
