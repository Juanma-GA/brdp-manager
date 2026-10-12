// Test de reglas: lo que la app puede arreglar sola en los ejemplos.
// Pure and deterministic (no React, no API), so scripts/ can test it in Node.
//
// Real case: BRDP-EXT-00127 of «Official Default S1000D 4.2 - 001» -- three
// generations in a row, the LLM wrote <pmCode>PM-001</pmCode> (no
// @modelIdentCode, @pmIssuer, @pmNumber, @pmVolume, which are required) and
// the test could never run an example. What the rule tests was fine; only
// the markup around it was not valid. These are the fixes the application
// makes on its own, on the TEXT the LLM wrote (content, identification and
// status section, dossier files), the rest left exactly as written:
//   - Part 1, required attributes: an element written without a required
//     attribute of its model gets it, with the neutral value the backend
//     already gives (structure.models[x].attributes: METADATA_ATTRIBUTE_VALUES
//     or the enum's first value) -- only when neither the rule nor the
//     Proposal names that attribute (then it may be what is tested, and the
//     example goes to the correction round as before) and a neutral value is
//     known (an xs:ID or IDREF has none).
// The application's own elements (skeleton, minimal section, examples the
// application assembles) are never in this text, so never touched.

// Comments, CDATA (its text counts as text), processing instructions, a
// doctype, and start/end tags.
const TOKEN_RE =
  /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
const ATTRIBUTE_RE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeEntities(text) {
  return String(text).replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return XML_ENTITIES[e] ?? m;
  });
}
function escapeAttribute(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

// Every element of `text` in document order:
//   { name, tagStart, tagEnd, attributes: [{ name, value, start, end }],
//     selfClosing, closeStart, closeEnd, parent, childElements, text }
// `text` = the element's own text nodes (CDATA included), with their spans
// (`textSpans`). null when the tags do not balance (malformed: its
// validation says so, nothing is fixed).
export function scanElements(text) {
  const source = String(text ?? '');
  const elements = [];
  const stack = [];
  let last = 0;
  const addText = (start, end, value) => {
    const top = stack[stack.length - 1];
    if (top === undefined) return;
    elements[top].textSpans.push({ start, end, value });
  };
  for (const m of source.matchAll(TOKEN_RE)) {
    if (m.index > last) addText(last, m.index, decodeEntities(source.slice(last, m.index)));
    last = m.index + m[0].length;
    if (m[1] !== undefined) {
      addText(m.index, last, m[1]);
      continue;
    }
    if (m[3] === undefined) continue; // comment, PI, doctype
    if (m[2] === '/') {
      const top = stack.pop();
      if (top === undefined || elements[top].name !== m[3]) return null;
      elements[top].closeStart = m.index;
      elements[top].closeEnd = last;
      continue;
    }
    const attributes = [];
    const attrOffset = m.index + 1 + m[3].length;
    for (const a of m[4].matchAll(ATTRIBUTE_RE)) {
      attributes.push({ name: a[1], value: decodeEntities(a[2] ?? a[3] ?? ''), start: attrOffset + a.index, end: attrOffset + a.index + a[0].length });
    }
    const parent = stack.length ? stack[stack.length - 1] : null;
    const element = {
      name: m[3],
      tagStart: m.index,
      tagEnd: last,
      attributes,
      selfClosing: m[5] === '/',
      closeStart: null,
      closeEnd: null,
      parent,
      childElements: 0,
      textSpans: [],
    };
    if (parent !== null) elements[parent].childElements += 1;
    elements.push(element);
    if (!element.selfClosing) stack.push(elements.length - 1);
  }
  // Text after the last tag is outside every element (nothing to record).
  if (stack.length) return null;
  return elements;
}

// Applies [{ at, del, text }] edits to `source` (non-overlapping).
function applyEdits(source, edits) {
  let out = source;
  for (const e of [...edits].sort((a, b) => b.at - a.at)) out = out.slice(0, e.at) + e.text + out.slice(e.at + e.del);
  return out;
}

// Where a new attribute goes in a start tag: before its "/>" or ">" (after
// the last attribute, keeping the tag's own spacing).
function attributeInsertPoint(source, element) {
  const tag = source.slice(element.tagStart, element.tagEnd);
  const closing = element.selfClosing ? tag.lastIndexOf('/') : tag.length - 1;
  let at = element.tagStart + closing;
  while (at > element.tagStart && /\s/.test(source[at - 1])) at -= 1;
  return at;
}

// Groups [{ element, name }] by element: [{ element, attributes: [names] }].
function groupByElement(items) {
  const out = [];
  for (const item of items) {
    let group = out.find((g) => g.element === item.element);
    if (!group) out.push((group = { element: item.element, attributes: [] }));
    if (!group.attributes.includes(item.name)) group.attributes.push(item.name);
  }
  return out;
}

// Part 1. → { text, added: [{ element, attributes: [names] }] }
// `named(attribute)`: the rule or the Proposal names it.
export function addMissingRequiredAttributes(text, structure, { named = () => false } = {}) {
  const source = String(text ?? '');
  const unchanged = { text: source, added: [] };
  if (!structure?.models || !structure?.elements) return unchanged;
  const elements = scanElements(source);
  if (!elements) return unchanged;
  const edits = [];
  const added = [];
  for (const el of elements) {
    if (el.name.includes(':') || !structure.elements[el.name]) continue;
    const required = structure.models[el.name]?.attributes || [];
    if (!required.length) continue;
    const present = new Set(el.attributes.map((a) => a.name.replace(/^xlink:/, '')));
    const missing = required.filter(
      ([name, value]) => !String(name).includes(':') && !present.has(name) && value !== null && value !== undefined && !named(name)
    );
    if (!missing.length) continue;
    edits.push({ at: attributeInsertPoint(source, el), del: 0, text: missing.map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`).join('') });
    for (const [name] of missing) added.push({ element: el.name, name });
  }
  if (!edits.length) return unchanged;
  return { text: applyEdits(source, edits), added: groupByElement(added) };
}

// The rule names it (its XPath: extractRuleNames) or the Proposal mentions
// it as a word (with or without @) -- then it may be what is tested, and the
// application leaves it to the LLM. Same reading as the "the schema already
// requires it" check of the required attributes.
export function namedByRuleOrProposal(ruleNames, proposal) {
  const attributes = new Set(ruleNames?.attributes || []);
  const elements = new Set(ruleNames?.elements || []);
  const text = String(proposal || '');
  const inProposal = (name) => new RegExp(`(^|[^\\w@.-])@?${String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(text);
  return {
    attribute: (name) => attributes.has(name) || inProposal(name),
    element: (name) => elements.has(name) || inProposal(name),
  };
}

// All the fixes of this module on one text, in order. → { text, requiredAttributesAdded }
export function applyExampleSchemaFixes(text, structure, named) {
  if (text == null || !named || !structure?.models) return { text, requiredAttributesAdded: [] };
  const attrs = addMissingRequiredAttributes(text, structure, { named: named.attribute });
  return { text: attrs.text, requiredAttributesAdded: attrs.added };
}
