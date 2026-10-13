// Formato del texto de los elementos y valores compuestos con concat(),
// Part 2. A predicate that compares concat(r1, …, rN) with a literal
// (= or !=, either side) -- /dmodule/idstatus[concat(dmaddres/dmc/avee/
// chapnum, …/section, …/subsect, …/subject) = 'A91251'] -- only selects
// something when the example writes each piece of the literal in its
// element. With the facets of the elements' text (models[x].textFacets,
// from the real XSD) there is often exactly one way to split the literal
// (3.0.1: chapnum [A-Za-z0-9]{2,3}, section {1}, subsect {1}, subject {2}|{4}
// -- 'A91251' is A9 + 1 + 2 + 51); the prompt and the correction round say
// it. Several splits or none: nothing is said. Generic: no element name is
// known here, everything comes from the rule and the structure.
//
// Arguments taken: relative paths of plain element steps (a/b/c, ./a,
// child::a) -- their last step is the element whose text is the piece --
// and string literals (a fixed piece). Anything else (a predicate, an
// attribute, //, a function, a variable) and the comparison is left alone.
import { extractRuleXPaths, meetsTextFacets } from '../validation/schemaValidation.js';

const NAME_RE = /^[A-Za-z_][\w.-]*$/;
const MAX_LITERAL = 64;

// Inside one XPath expression: from `open` (index of "(" after concat), the
// index of the matching ")", skipping string literals; -1 if unbalanced.
function closingParen(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (c === "'" || c === '"') {
      const end = text.indexOf(c, i + 1);
      if (end === -1) return -1;
      i = end;
      continue;
    }
    if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Top-level comma split (outside literals and brackets).
function splitArgs(text) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === "'" || c === '"') {
      const end = text.indexOf(c, i + 1);
      if (end === -1) return null;
      i = end;
      continue;
    }
    if (c === '(' || c === '[') depth += 1;
    else if (c === ')' || c === ']') depth -= 1;
    else if (c === ',' && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.map((a) => a.trim());
}

// A whole string literal ('a''b' and "a""b" are XPath's escapes), or null.
function literalValue(text) {
  const t = text.trim();
  const m = /^'((?:[^']|'')*)'$/.exec(t) || /^"((?:[^"]|"")*)"$/.exec(t);
  if (!m) return null;
  return t[0] === "'" ? m[1].replace(/''/g, "'") : m[1].replace(/""/g, '"');
}

// A concat() argument: { kind: 'element', element, path } for a relative
// path of plain element steps, { kind: 'fixed', value } for a literal, or
// null for anything else.
function concatArgument(text) {
  const value = literalValue(text);
  if (value !== null) return { kind: 'fixed', value };
  const path = text.replace(/\s+/g, '').replace(/^\.\//, '');
  if (!path || path.startsWith('/') || path.includes('//')) return null;
  const steps = path.split('/').map((s) => s.replace(/^child::/, ''));
  if (!steps.every((s) => NAME_RE.test(s))) return null;
  return { kind: 'element', element: steps[steps.length - 1], path: steps.join('/') };
}

// A predicate that is exactly one concat(…) of element paths compared with
// a literal (either side, = or !=): { elements: ['chapnum', …], value,
// negated }, or null for anything else (and/or, a function around it, …) --
// describeRule says it in words only then, never changing its meaning.
export function wholeConcatComparison(predicate) {
  const text = String(predicate || '').trim();
  let m = /^concat\s*\(/.exec(text);
  let literalText;
  let operator;
  let open;
  let close;
  if (m) {
    open = m[0].length - 1;
    close = closingParen(text, open);
    if (close === -1) return null;
    const rest = /^\s*(!?=)\s*('(?:[^']|'')*'|"(?:[^"]|"")*")\s*$/.exec(text.slice(close + 1));
    if (!rest) return null;
    [, operator, literalText] = rest;
  } else {
    m = /^('(?:[^']|'')*'|"(?:[^"]|"")*")\s*(!?=)\s*concat\s*\(/.exec(text);
    if (!m) return null;
    [, literalText, operator] = m;
    open = m[0].length - 1;
    close = closingParen(text, open);
    if (close !== text.length - 1) return null;
  }
  const parts = splitArgs(text.slice(open + 1, close));
  if (!parts || parts.length < 2) return null;
  const args = parts.map(concatArgument);
  if (args.some((a) => !a || a.kind !== 'element')) return null;
  const value = literalValue(literalText);
  if (value === null) return null;
  return { elements: args.map((a) => a.element), value, negated: operator === '!=' };
}

// Every concat(…) compared with a literal in the rule's XPath expressions:
// [{ literal, args: [{ kind, element?, path?, value? }], expression }].
export function concatComparisons(ruleXml) {
  const out = [];
  const seen = new Set();
  for (const expression of extractRuleXPaths(ruleXml || '')) {
    const re = /\bconcat\s*\(/g;
    let m;
    while ((m = re.exec(expression))) {
      const open = m.index + m[0].length - 1;
      const close = closingParen(expression, open);
      if (close === -1) continue;
      const parts = splitArgs(expression.slice(open + 1, close));
      if (!parts || parts.length < 2) continue;
      const args = parts.map(concatArgument);
      if (args.some((a) => !a) || !args.some((a) => a.kind === 'element')) continue;
      const after = /^\s*!?=\s*('(?:[^']|'')*'|"(?:[^"]|"")*")/.exec(expression.slice(close + 1));
      const before = /('(?:[^']|'')*'|"(?:[^"]|"")*")\s*!?=\s*$/.exec(expression.slice(0, m.index));
      const quoted = after?.[1] ?? before?.[1];
      if (!quoted) continue;
      const literal = literalValue(quoted);
      if (literal === null || literal.length > MAX_LITERAL) continue;
      const key = JSON.stringify([literal, args]);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ literal, args, expression: expression.slice(m.index, close + 1) });
    }
  }
  return out;
}

// The ways (at most `limit`) to split `literal` over `args` such that each
// element piece meets that element's facets in `structure` and each fixed
// piece is where it must be. null when an element has no simple-content
// model in the structure (its text cannot be judged).
export function literalSplits(literal, args, structure, limit = 2) {
  const models = structure?.models || {};
  for (const a of args) {
    if (a.kind !== 'element') continue;
    const model = models[a.element];
    if (!model || model.text === false || (model.order || []).length > 0) return null;
  }
  const chars = Array.from(literal);
  const found = [];
  const pieces = [];
  const walk = (i, at) => {
    if (found.length >= limit) return;
    if (i === args.length) {
      if (at === chars.length) found.push([...pieces]);
      return;
    }
    const arg = args[i];
    if (arg.kind === 'fixed') {
      const fixed = Array.from(arg.value);
      if (chars.slice(at, at + fixed.length).join('') !== arg.value) return;
      pieces.push(arg.value);
      walk(i + 1, at + fixed.length);
      pieces.pop();
      return;
    }
    const facets = models[arg.element].textFacets;
    for (let end = at; end <= chars.length; end += 1) {
      const piece = chars.slice(at, end).join('');
      if (!meetsTextFacets(piece, facets)) continue;
      pieces.push(piece);
      walk(i + 1, end);
      pieces.pop();
      if (found.length >= limit) return;
    }
  };
  walk(0, 0);
  return found;
}

// The comparisons of the rule whose literal has exactly one split in every
// given structure (and the same one in all of them):
// [{ literal, pieces: [{ element, text } | { fixed }], expression }].
export function uniqueConcatSplits(ruleXml, structures) {
  const usable = (structures || []).filter(Boolean);
  if (usable.length === 0) return [];
  const out = [];
  for (const comparison of concatComparisons(ruleXml)) {
    let agreed = null;
    let ok = true;
    for (const structure of usable) {
      const splits = literalSplits(comparison.literal, comparison.args, structure);
      if (!splits || splits.length !== 1) {
        ok = false;
        break;
      }
      const key = JSON.stringify(splits[0]);
      if (agreed !== null && agreed !== key) {
        ok = false;
        break;
      }
      agreed = key;
    }
    if (!ok || agreed === null) continue;
    const split = JSON.parse(agreed);
    out.push({
      literal: comparison.literal,
      expression: comparison.expression,
      pieces: comparison.args.map((a, i) => (a.kind === 'element' ? { element: a.element, text: split[i] } : { fixed: a.value })),
    });
  }
  return out;
}

const xmlText = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// "In this rule, 'A91251' is split as <chapnum>A9</chapnum>, <section>1</section>,
// <subsect>2</subsect>, <subject>51</subject>." -- for the prompt and the
// correction round (English, like the rest of what the LLM reads).
export function concatSplitSentence(split) {
  const pieces = split.pieces
    .filter((p) => p.element)
    .map((p) => `<${p.element}>${xmlText(p.text)}</${p.element}>`)
    .join(', ');
  return `In this rule, '${split.literal}' is split as ${pieces}.`;
}
