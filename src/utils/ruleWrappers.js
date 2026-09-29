// Legacy wrappers around stored BREX rules, taken apart the way Generate
// always took them apart.
//
// Real cases: BRDP-S1-00507 (S1000D 4.2) is stored as
// <rules><structureObjectRule/><nonContextRule/></rules> and BRDP-S1-00070 as
// a bare <structureObjectRuleGroup> holding two structureObjectRule. Generate
// ignored such wrappers when assembling the BREX (it took every rule wherever
// it sat), but the format check -- and with it the rule test -- rejects them.
// The stored text is cleaned instead of making the check more tolerant: the
// Excel import stores it clean and backend/scripts/normalize_rule_wrappers.py
// cleans what is already stored.
//
// Mirror of backend/app/services/rule_wrappers.py -- same token scan, same
// pieces, same result. Shared cases:
// backend/tests/fixtures/rule_wrapper_cases.json (pytest and
// scripts/test-rule-wrappers.mjs).
//
// splitRuleXmlPieces(xml, format) scans the text and returns, in document
// order, what Generate keeps -- each as the exact text it was written with:
//   block       a context block with a non-empty scope attribute
//               (<contextRules rulesContext="…"> / <contextrules context="…">),
//               whole, nothing inside it taken again
//   rule        <structureObjectRule> (4.x) / <objrule> (3.0.1), at any depth
//   noncontext  <nonContextRule> (4.x) / a comment starting with
//               "nonContextRule" (3.0.1), at any depth
//   comment     any other comment outside the pieces above (Generate drops
//               these; the stored rule keeps them)
// Everything else -- the wrapper tags themselves (<rules>, a bare
// <structureObjectRuleGroup>/<structrules>, a <contextRules> with no scope),
// whitespace, text -- is not a piece. Only the BREX formats have wrappers;
// another format gives null. The text must be well-formed (Generate parses
// each rule before splitting it).
//
// unwrapRuleXml(xml, format) -> { xml, changed }: the rule unchanged unless the
// format check reports a wrapper (rule_format_wrapper), everything left out of
// the pieces is only wrapper tags (WRAPPER_ELEMENTS) and whitespace -- never
// text or another element, which would be lost -- and the pieces, joined by a
// line break, pass the check.
import { checkRuleFormat } from '../validation/schemaValidation.js';

const SHAPES = {
  'BREX-4.2': { blocks: { contextRules: 'rulesContext' }, rules: { structureObjectRule: 'rule', nonContextRule: 'noncontext' }, comment: false },
  'BREX-4.1': { blocks: { contextRules: 'rulesContext' }, rules: { structureObjectRule: 'rule', nonContextRule: 'noncontext' }, comment: false },
  'BREX-3.0.1': { blocks: { contextrules: 'context' }, rules: { objrule: 'rule' }, comment: true },
};

const TOKEN_RE = /<!--([\s\S]*?)-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
const NON_CONTEXT_COMMENT_RE = /^\s*nonContextRule/;
const TAG_RE = /<(\/?)([A-Za-z_][\w.:-]*)(?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*\s*\/?>/g;

// The legacy containers that may be dropped: nothing but structure around the
// rules (a <contextRules>/<contextrules> gets here only without a scope --
// with one it is a block piece).
export const WRAPPER_ELEMENTS = {
  'BREX-4.2': new Set(['rules', 'structureObjectRuleGroup', 'nonContextRules', 'contextRules']),
  'BREX-4.1': new Set(['rules', 'structureObjectRuleGroup', 'nonContextRules', 'contextRules']),
  'BREX-3.0.1': new Set(['rules', 'structrules', 'contextrules']),
};

const localName = (name) => name.split(':').pop();

function attribute(attrs, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs || '');
  return (m && (m[1] ?? m[2])) || '';
}

export function splitRuleXmlPieces(xml, format) {
  const shape = SHAPES[format];
  if (!shape) return null;
  const text = String(xml ?? '');
  const pieces = [];
  let depth = 0;
  let kept = null; // { kind, start, depth at which it closes }
  for (const m of text.matchAll(TOKEN_RE)) {
    const [whole, comment, closing, name, attrs, selfClosing] = m;
    if (name === undefined) {
      if (comment !== undefined && !kept) {
        const kind = shape.comment && NON_CONTEXT_COMMENT_RE.test(comment) ? 'noncontext' : 'comment';
        pieces.push({ kind, text: whole, start: m.index, end: m.index + whole.length });
      }
      continue;
    }
    if (closing) {
      depth -= 1;
      if (kept && depth === kept.depth) {
        pieces.push({ kind: kept.kind, text: text.slice(kept.start, m.index + whole.length), start: kept.start, end: m.index + whole.length });
        kept = null;
      }
      continue;
    }
    if (!kept) {
      const local = localName(name);
      let kind = null;
      const scope = shape.blocks[local];
      if (scope !== undefined && attribute(attrs, scope).trim()) kind = 'block';
      else if (shape.rules[local]) kind = shape.rules[local];
      if (kind) {
        if (selfClosing) {
          pieces.push({ kind, text: whole, start: m.index, end: m.index + whole.length });
          continue;
        }
        kept = { kind, start: m.index, depth };
      }
    }
    if (!selfClosing) depth += 1;
  }
  return pieces;
}

export function unwrapRuleXml(xml, format) {
  const source = String(xml ?? '');
  if (!SHAPES[format] || !source.trim()) return { xml: source, changed: false };
  const check = checkRuleFormat(source, format);
  if (check.ok || check.problem?.code !== 'rule_format_wrapper') return { xml: source, changed: false };
  const pieces = splitRuleXmlPieces(source, format) || [];
  if (!onlyWrappersLeft(source, pieces, WRAPPER_ELEMENTS[format])) return { xml: source, changed: false };
  const cleaned = pieces.map((p) => p.text).join('\n');
  if (!cleaned.trim() || !checkRuleFormat(cleaned, format).ok) return { xml: source, changed: false };
  return { xml: cleaned, changed: true };
}

// True when what the pieces leave out is only wrapper tags and whitespace.
function onlyWrappersLeft(xml, pieces, wrappers) {
  let left = '';
  let cursor = 0;
  for (const p of pieces) {
    left += xml.slice(cursor, p.start);
    cursor = p.end;
  }
  left += xml.slice(cursor);
  for (const m of left.matchAll(TAG_RE)) if (!wrappers.has(localName(m[2]))) return false;
  return !left.replace(TAG_RE, '').trim();
}
