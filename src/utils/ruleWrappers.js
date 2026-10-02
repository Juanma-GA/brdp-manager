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

// ---------------------------------------------------------------------------
// One context block per schema in a generated BREX.
//
// Each approved rule carries its own <contextRules rulesContext="…"> (3.0.1
// <contextrules context="…">) blocks, so a project with four BRDPs limited
// to proced got four proced blocks. The XSDs allow that (maxOccurs
// "unbounded"), but a real customer BREX has one block per schema, and the
// round trip original → AI Extract → Generate must give it back.
//
// mergeContextBlocks(blockTexts, format) -> blockTexts: the blocks (output of
// splitRuleXmlPieces, in BRDP order, schema URLs already rewritten to the
// project's "Schema location") with every set of blocks that share the same
// block attributes -- and the same attributes on their group and notation
// list -- joined into one, placed where the first of them was:
//   <contextRules rulesContext="X">          (opening tag of the first block)
//   <structureObjectRuleGroup>               (3.0.1 <structrules>)
//     the rules of each block, in order
//   </structureObjectRuleGroup>
//   <notationRuleList>…</notationRuleList>   (3.0.1 <notationrules>), if any
//   </contextRules>
// Comments inside a group stay next to their rule; a comment written at block
// level goes with the group (or notation list) that follows it.
// A block that is not exactly that shape (other children, text, a CDATA
// section) is left as written and never merged; a block whose attributes
// differ from the others in anything (id, changeMark…) is a different block.
// A block that is alone with its attributes is returned byte for byte.
const BLOCK_PARTS = {
  'BREX-4.2': { block: 'contextRules', group: 'structureObjectRuleGroup', list: 'notationRuleList' },
  'BREX-4.1': { block: 'contextRules', group: 'structureObjectRuleGroup', list: 'notationRuleList' },
  'BREX-3.0.1': { block: 'contextrules', group: 'structrules', list: 'notationrules' },
};

const ATTR_PAIR_RE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function attributeKey(attrs) {
  const pairs = [];
  for (const m of String(attrs || '').matchAll(ATTR_PAIR_RE)) pairs.push(`${m[1]}=${m[2] ?? m[3]}`);
  return pairs.sort().join('\u0000');
}

// The parts of one block, or null when it cannot be merged safely.
function parseContextBlock(text, parts) {
  let depth = 0;
  let root = null;
  let cursor = 0;
  const children = []; // { name, attrsKey, openTag, closeTag, inner }
  let open = null; // child being read: { name, attrs, openTag, innerStart }
  const pendingComments = [];
  const commentsFor = new Map(); // child index -> leading block-level comments
  const trailingComments = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    const [whole, comment, closing, name, attrs, selfClosing] = m;
    const between = text.slice(cursor, m.index);
    cursor = m.index + whole.length;
    if (depth === 1 && !open && between.trim()) return null;
    if (depth === 0 && between.trim()) return null;
    if (name === undefined) {
      if (depth === 0) {
        if (comment === undefined) return null;
        continue; // a comment outside the block is not ours
      }
      if (depth === 1 && !open) {
        if (comment === undefined) return null; // CDATA / PI at block level
        pendingComments.push(whole);
      }
      continue;
    }
    const local = localName(name);
    if (closing) {
      depth -= 1;
      if (depth === 1 && open) {
        children.push({ ...open, closeTag: whole, inner: text.slice(open.innerStart, m.index) });
        open = null;
      }
      if (depth === 0) {
        if (local !== parts.block) return null;
        if (text.slice(cursor).trim()) return null;
        trailingComments.push(...pendingComments);
        pendingComments.length = 0;
        break;
      }
      continue;
    }
    if (depth === 0) {
      if (root || local !== parts.block || selfClosing) return null;
      root = { openTag: whole, closeTag: `</${name}>`, attrsKey: attributeKey(attrs) };
      depth = 1;
      continue;
    }
    if (depth === 1 && !open) {
      if (local !== parts.group && local !== parts.list) return null;
      if (children.some((c) => localName(c.name) === local)) return null;
      if (local === parts.group && children.length) return null; // group must come first
      commentsFor.set(children.length, pendingComments.splice(0));
      const child = { name, attrsKey: attributeKey(attrs), openTag: whole };
      if (selfClosing) {
        children.push({ ...child, openTag: `<${name}${attrs || ''}>`, closeTag: `</${name}>`, inner: '' });
      } else {
        open = { ...child, innerStart: cursor };
        depth = 2;
      }
      continue;
    }
    if (!selfClosing) depth += 1;
  }
  if (!root || depth !== 0 || open) return null;
  if (!children.length) return null;
  const out = { root, group: null, list: null };
  children.forEach((c, i) => {
    const lead = (commentsFor.get(i) || []).join('\n');
    const inner = [lead, c.inner.trim()].filter(Boolean).join('\n');
    const entry = { name: c.name, openTag: c.openTag, closeTag: c.closeTag, attrsKey: c.attrsKey, inners: inner ? [inner] : [] };
    if (localName(c.name) === parts.group) out.group = entry;
    else out.list = entry;
  });
  if (trailingComments.length) {
    const last = out.list || out.group;
    last.inners.push(trailingComments.join('\n'));
  }
  return out;
}

function renderMergedBlock(block) {
  const lines = [block.root.openTag];
  for (const part of [block.group, block.list]) {
    if (!part) continue;
    lines.push(part.openTag, ...part.inners, part.closeTag);
  }
  lines.push(block.root.closeTag);
  return lines.join('\n');
}

export function mergeContextBlocks(blockTexts, format) {
  const parts = BLOCK_PARTS[format];
  const texts = (blockTexts || []).map((t) => String(t ?? ''));
  if (!parts) return texts;
  const slots = []; // { text } or { key }
  const merged = new Map(); // key -> { block, count, firstText }
  for (const text of texts) {
    const block = parseContextBlock(text, parts);
    if (!block) {
      slots.push({ text });
      continue;
    }
    const key = [block.root.attrsKey, block.group?.attrsKey ?? '', block.list?.attrsKey ?? ''].join('\u0001');
    const seen = merged.get(key);
    if (!seen) {
      merged.set(key, { block, count: 1, firstText: text });
      slots.push({ key });
      continue;
    }
    seen.count += 1;
    for (const part of ['group', 'list']) {
      if (!block[part]) continue;
      if (!seen.block[part]) seen.block[part] = { ...block[part], inners: [] };
      seen.block[part].inners.push(...block[part].inners);
    }
  }
  return slots.map((s) => {
    if (s.text !== undefined) return s.text;
    const m = merged.get(s.key);
    return m.count === 1 ? m.firstText : renderMergedBlock(m.block);
  });
}
