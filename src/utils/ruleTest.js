// Test rule (T2 of 4): everything between the LLM's examples and the panel,
// deterministic and pure (no React, no API) so scripts/ can test it in Node.
// - validateExample: well-formed XML + names checked against the standard's
//   vocabulary (same check as the rest of the app). An example that fails
//   is shown with its warning and never run -- never dropped (HR7).
// - runExample: the T1 engine on one example, compared with what the
//   example expects.
// - ruleTestVerdict: the global verdict (correct / incorrect / inconclusive
//   / not executable / nothing runnable).
// - xmlDisplayLines: the example re-indented, split into segments so the
//   panel can highlight the nodes the rule selected.
import { nodePath, parseXmlDocument, runRuleOnFragment } from './ruleTestEngine.js';
import { checkAgainstVocabulary } from './vocabularyCheck.js';

// The schema of the "does not apply here" example of a context-scoped rule:
// the first of these the rule is not limited to, else any other document
// schema of the standard. null when there is none (general rule).
const OTHER_SCHEMA_PREFERENCE = ['descript', 'proced', 'ipd', 'fault'];
export function pickOtherSchema(contextSchemas, documentSchemas = []) {
  if (!contextSchemas || contextSchemas.length === 0) return null;
  const taken = new Set(contextSchemas);
  const candidates = [...OTHER_SCHEMA_PREFERENCE, ...documentSchemas];
  return candidates.find((s) => !taken.has(s) && (documentSchemas.length === 0 || documentSchemas.includes(s))) || null;
}

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

// { wellFormed, error, names, runnable }
export function validateExample(xml, vocabulary, parseXml = parseXmlDocument) {
  let doc;
  try {
    doc = parseXml(String(xml || ''));
    if (!doc?.documentElement) throw new Error('no root element');
  } catch (err) {
    return { wellFormed: false, error: err.message, names: { available: false, notFound: [], wrongType: [] }, runnable: false };
  }
  const names = checkAgainstVocabulary(fragmentNames(doc), vocabulary);
  const namesOk = !names.available || (names.notFound.length === 0 && names.wrongType.length === 0);
  return { wellFormed: true, error: null, names, runnable: namesOk };
}

// One example → { validation, result (engine output) | null, matches }.
// matches: true/false when the rule ran and gave a verdict, null otherwise.
export function runExample(ruleXml, format, example, { vocabulary = null, parseXml = parseXmlDocument } = {}) {
  const validation = validateExample(example.xml, vocabulary, parseXml);
  if (!validation.runnable) return { validation, result: null, matches: null };
  const result = runRuleOnFragment(ruleXml, format, example.xml, example.schema || null, { parseXml });
  const expectedStatus = example.expected === 'reject' ? 'rejected' : 'accepted';
  const matches = result.status === 'not_executable' ? null : result.status === expectedStatus;
  return { validation, result, matches };
}

// The global verdict from the examples and their runs:
//   { kind: 'not_executable', reason }  -- the engine could not judge an example
//   { kind: 'no_runnable' }             -- every example failed validation
//   { kind: 'inconclusive', why: 'nothing_selected' | 'missing_expectation' }
//   { kind: 'incorrect', permissive, strict } -- which way the rule was wrong
//   { kind: 'correct' }
export function ruleTestVerdict(examples, runs) {
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
//   [{ depth, segments: [{ text, highlight }] }]
// highlight marks the tag of a selected element (start and end tag) and the
// name="value" of a selected attribute. An element with text inside (a
// <para>, even with <emphasis> in it) stays on one line. Display only: whitespace inside text is tidied, so the rule
// always runs on the example's own XML, never on these lines (and the edit
// box starts from that XML). null when the XML does not parse.
export function xmlDisplayLines(xml, selectedNodePaths = [], parseXml = parseXmlDocument) {
  let doc;
  try {
    doc = parseXml(String(xml || ''));
  } catch {
    return null;
  }
  const selected = new Set(selectedNodePaths);
  const lines = [];
  const startTag = (el, selfClose) => {
    const hl = selected.has(nodePath(el));
    const segments = [{ text: `<${el.nodeName}`, highlight: hl }];
    for (const a of Array.from(el.attributes || [])) {
      segments.push({ text: ' ', highlight: false });
      segments.push({ text: `${a.name}="${escAttr(a.value)}"`, highlight: selected.has(nodePath(a)) });
    }
    segments.push({ text: selfClose ? '/>' : '>', highlight: hl });
    return segments;
  };
  const endTag = (el) => ({ text: `</${el.nodeName}>`, highlight: selected.has(nodePath(el)) });
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
      else if (n.nodeType === 8) segments.push({ text: `<!--${n.data}-->`, highlight: false });
      else segments.push({ text: escText(n.data.replace(/\s+/g, ' ')), highlight: false });
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
      else lines.push({ depth: depth + 1, segments: [{ text: `<!--${n.data}-->`, highlight: false }] });
    }
    lines.push({ depth, segments: [endTag(el)] });
  };
  walk(doc.documentElement, 0);
  return lines;
}
