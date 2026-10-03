// "Comparar dos BRDP lado a lado": everything the side-by-side view
// computes, deterministically and without AI. Pure (no React, no fetch), so
// scripts/test-brdp-compare.mjs imports it from Node; the XML parser is
// injectable (options.parseXml) exactly like ruleTestEngine.js.
//
// - diffSequences: Myers' O(ND) diff, written here (no `diff` dependency).
// - diffText: word-level diff of two texts (whitespace never counts as a
//   difference), as the two columns show it.
// - normalizeRuleXml + diffRuleLines: a rule as normalized XML (uniform
//   indentation and whitespace, so formatting never shows as a change) and
//   a side-by-side line diff, with long unchanged runs folded.
// - compareRuleStructure: the structural summary (BREX: path, flag,
//   values added/removed per rule; Schematron: context and test per
//   assert/report), from ruleStructure in ruleTestEngine.js.
// - compareSummary: the counts behind the summary line at the top.

import { _normSpace } from '../api/brexToSchematron.js';
import { parseXmlDocument, ruleFormatFamily, ruleStructure } from './ruleTestEngine.js';
import { wrapRuleXmlFragment } from './ruleXmlFragment.js';

// Past this many edits the diff stops looking for the shortest script and
// reports "all removed, all added": still a correct diff, just not a minimal
// one, and it keeps memory bounded (the Myers trace grows with D²) for two
// texts with nothing in common.
export const MAX_DIFF_EDITS = 3000;

// Myers' diff of two sequences. Returns [{ op: 'equal'|'delete'|'insert',
// a?: index in a, b?: index in b }] in order.
export function diffSequences(a, b, eq = (x, y) => x === y) {
  const n = a.length;
  const m = b.length;
  // Common prefix and suffix first: cheap, and the usual case (small edits).
  let start = 0;
  while (start < n && start < m && eq(a[start], b[start])) start += 1;
  let endA = n;
  let endB = m;
  while (endA > start && endB > start && eq(a[endA - 1], b[endB - 1])) { endA -= 1; endB -= 1; }
  const ops = [];
  for (let i = 0; i < start; i += 1) ops.push({ op: 'equal', a: i, b: i });
  const middle = myersMiddle(a, b, start, endA, start, endB, eq);
  ops.push(...middle);
  for (let i = 0; i < n - endA; i += 1) ops.push({ op: 'equal', a: endA + i, b: endB + i });
  return ops;
}

function myersMiddle(a, b, a0, a1, b0, b1, eq) {
  const n = a1 - a0;
  const m = b1 - b0;
  if (n === 0 && m === 0) return [];
  const replaceAll = () => [
    ...Array.from({ length: n }, (_, i) => ({ op: 'delete', a: a0 + i })),
    ...Array.from({ length: m }, (_, i) => ({ op: 'insert', b: b0 + i })),
  ];
  if (n === 0 || m === 0) return replaceAll();
  const max = n + m;
  const v = new Int32Array(2 * max + 2);
  const trace = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d += 1) {
    if (d > MAX_DIFF_EDITS) return replaceAll();
    // V as it was after step d-1, for k in [-d, d] (local index k + d).
    trace.push(v.slice(max - d, max + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[max + k - 1] < v[max + k + 1]) ? v[max + k + 1] : v[max + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && eq(a[a0 + x], b[b0 + y])) { x += 1; y += 1; }
      v[max + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
  }
  const ops = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d -= 1) {
    const vp = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && vp[k - 1 + d] < vp[k + 1 + d]) ? k + 1 : k - 1;
    const prevX = vp[prevK + d];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push({ op: 'equal', a: a0 + x - 1, b: b0 + y - 1 }); x -= 1; y -= 1; }
    if (x === prevX) ops.push({ op: 'insert', b: b0 + y - 1 });
    else ops.push({ op: 'delete', a: a0 + x - 1 });
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) { ops.push({ op: 'equal', a: a0 + x - 1, b: b0 + y - 1 }); x -= 1; y -= 1; }
  return ops.reverse();
}

// ── Text: word-level diff ─────────────────────────────────────────────────

const TOKEN_RE = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;
const isSpace = (t) => /^\s+$/.test(t);

export function tokenizeWords(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').match(TOKEN_RE) || [];
}

// Two texts are equal when they only differ in whitespace.
export function textsEqual(a, b) {
  const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  return norm(a) === norm(b);
}

// → { equal, left: [{ text, changed }], right: [{ text, changed }] }:
// the left column highlights what was removed, the right what was added.
// Whitespace tokens always count as equal to each other, so a line break or
// a double space is never marked.
export function diffText(a, b) {
  const ta = tokenizeWords(a);
  const tb = tokenizeWords(b);
  const ops = diffSequences(ta, tb, (x, y) => x === y || (isSpace(x) && isSpace(y)));
  const left = [];
  const right = [];
  const push = (list, text, changed) => {
    const last = list[list.length - 1];
    if (last && last.changed === changed) last.text += text;
    else list.push({ text, changed });
  };
  for (const o of ops) {
    if (o.op === 'equal') { push(left, ta[o.a], false); push(right, tb[o.b], false); }
    // A whitespace token alone is never a change worth highlighting.
    else if (o.op === 'delete') push(left, ta[o.a], !isSpace(ta[o.a]));
    else push(right, tb[o.b], !isSpace(tb[o.b]));
  }
  return { equal: textsEqual(a, b), left, right };
}

// ── Rule: normalized XML and line diff ────────────────────────────────────

// Text that is XPath keeps whitespace inside its string literals
// (_normSpace, the same quote-aware collapse the BREX→Schematron converter
// uses); every other text and attribute is prose or a value, where only
// formatting whitespace can differ.
const XPATH_ELEMENTS = new Set(['objectPath', 'objpath']);
const XPATH_ATTRIBUTES = new Set(['context', 'test', 'select', 'value', 'path']);
const collapse = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const localName = (name) => name.replace(/^[^:]*:/, '');
const escText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => escText(s).replace(/"/g, '&quot;');

function serialize(node, depth, out) {
  const pad = '  '.repeat(depth);
  if (node.nodeType === 8) {
    out.push(`${pad}<!-- ${collapse(node.data)} -->`);
    return;
  }
  if (node.nodeType === 3 || node.nodeType === 4) {
    const text = collapse(node.data);
    if (text) out.push(pad + escText(text));
    return;
  }
  if (node.nodeType !== 1) return;
  const name = node.nodeName;
  const attrs = Array.from(node.attributes || [])
    .map((a) => {
      const value = XPATH_ATTRIBUTES.has(localName(a.name)) ? _normSpace(a.value) : collapse(a.value);
      return ` ${a.name}="${escAttr(value)}"`;
    })
    .join('');
  const children = Array.from(node.childNodes || []).filter((c) => !((c.nodeType === 3 || c.nodeType === 4) && !collapse(c.data)));
  if (!children.length) {
    out.push(`${pad}<${name}${attrs}/>`);
    return;
  }
  if (children.every((c) => c.nodeType === 3 || c.nodeType === 4)) {
    const raw = children.map((c) => c.data).join('');
    const text = XPATH_ELEMENTS.has(localName(name)) ? _normSpace(raw) : collapse(raw);
    out.push(`${pad}<${name}${attrs}>${escText(text)}</${name}>`);
    return;
  }
  out.push(`${pad}<${name}${attrs}>`);
  for (const c of children) serialize(c, depth + 1, out);
  out.push(`${pad}</${name}>`);
}

// → { ok: true, text } or, for XML that does not parse, { ok: false, text }
// with the rule as written (line endings unified) -- still diffable, just
// not normalized.
export function normalizeRuleXml(xml, options = {}) {
  const raw = String(xml ?? '').replace(/\r\n?/g, '\n');
  if (!raw.trim()) return { ok: true, text: '' };
  const parseXml = options.parseXml || parseXmlDocument;
  let doc;
  try {
    doc = parseXml(wrapRuleXmlFragment(raw));
  } catch {
    return { ok: false, text: raw.trim() };
  }
  const out = [];
  for (const child of Array.from(doc.documentElement.childNodes)) serialize(child, 0, out);
  return { ok: true, text: out.join('\n') };
}

// Side-by-side rows: { kind: 'equal'|'changed'|'removed'|'added', left, right }
// (a changed row pairs a removed line with an added one; left/right are
// null on the side without a line).
export function diffRuleLines(leftText, rightText) {
  const a = leftText ? leftText.split('\n') : [];
  const b = rightText ? rightText.split('\n') : [];
  const ops = diffSequences(a, b);
  const rows = [];
  let dels = [];
  let ins = [];
  const flush = () => {
    const pairs = Math.max(dels.length, ins.length);
    for (let i = 0; i < pairs; i += 1) {
      const l = dels[i] ?? null;
      const r = ins[i] ?? null;
      rows.push({ kind: l !== null && r !== null ? 'changed' : l !== null ? 'removed' : 'added', left: l, right: r });
    }
    dels = [];
    ins = [];
  };
  for (const o of ops) {
    if (o.op === 'equal') { flush(); rows.push({ kind: 'equal', left: a[o.a], right: b[o.b] }); }
    else if (o.op === 'delete') dels.push(a[o.a]);
    else ins.push(b[o.b]);
  }
  flush();
  return rows;
}

// Folds every run of more than 2*context+1 equal rows, keeping `context`
// rows next to each change (none at the start or end of the rule without a
// change on that side). → [row | { kind: 'fold', rows: [...] }]
export function foldEqualRows(rows, context = 3) {
  const out = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i].kind !== 'equal') { out.push(rows[i]); i += 1; continue; }
    let j = i;
    while (j < rows.length && rows[j].kind === 'equal') j += 1;
    const run = rows.slice(i, j);
    const keepBefore = i === 0 ? 0 : context;
    const keepAfter = j === rows.length ? 0 : context;
    if (run.length > keepBefore + keepAfter + 1) {
      out.push(...run.slice(0, keepBefore));
      out.push({ kind: 'fold', rows: run.slice(keepBefore, run.length - keepAfter) });
      out.push(...run.slice(run.length - keepAfter));
    } else {
      out.push(...run);
    }
    i = j;
  }
  return out;
}

// ── Rule: structural summary ──────────────────────────────────────────────

function pairBy(left, right, keys) {
  const pairs = [];
  const l = left.map((item, i) => ({ item, i }));
  const r = right.map((item, i) => ({ item, i }));
  for (const key of keys) {
    for (const le of l.filter((x) => !x.used)) {
      const k = key(le.item);
      if (!k) continue;
      const re = r.find((x) => !x.used && key(x.item) === k);
      if (re) { le.used = true; re.used = true; pairs.push([le.item, re.item]); }
    }
  }
  // The rest, one to one in order (two different BRDPs have different rule
  // ids, and a changed path is a change, not a removal plus an addition).
  const restL = l.filter((x) => !x.used);
  const restR = r.filter((x) => !x.used);
  const n = Math.min(restL.length, restR.length);
  for (let i = 0; i < n; i += 1) pairs.push([restL[i].item, restR[i].item]);
  for (const x of restL.slice(n)) pairs.push([x.item, null]);
  for (const x of restR.slice(n)) pairs.push([null, x.item]);
  return pairs;
}

const multisetDiff = (a, b) => {
  const counts = new Map();
  for (const x of b) counts.set(x, (counts.get(x) || 0) + 1);
  const onlyA = [];
  for (const x of a) {
    const c = counts.get(x) || 0;
    if (c > 0) counts.set(x, c - 1);
    else onlyA.push(x);
  }
  return onlyA;
};

// left/right: { format, xml } or null (no rule on that side).
// → { status: 'none' }                        neither side has a rule
//   { status: 'missing', side }               only one side has one
//   { status: 'formats_differ', leftFormat, rightFormat }
//   { status: 'unavailable' }                 one of them does not parse
//   { status: 'compared', family, items, valuesAdded, valuesRemoved, changed }
// items: [{ kind: 'same'|'changed'|'added'|'removed', left, right,
//           changes: { path?, flag?, schema?, context?, test?, kind?,
//                      valuesAdded, valuesRemoved } }]
export function compareRuleStructure(left, right, options = {}) {
  const hasL = Boolean(left && String(left.xml || '').trim());
  const hasR = Boolean(right && String(right.xml || '').trim());
  if (!hasL && !hasR) return { status: 'none' };
  if (!hasL || !hasR) return { status: 'missing', side: hasL ? 'right' : 'left' };
  const famL = ruleFormatFamily(left.format);
  const famR = ruleFormatFamily(right.format);
  if (!famL || !famR || famL !== famR) return { status: 'formats_differ', leftFormat: left.format, rightFormat: right.format };
  const sL = ruleStructure(left.xml, left.format, options);
  const sR = ruleStructure(right.xml, right.format, options);
  if (!sL.available || !sR.available) return { status: 'unavailable' };

  const items = [];
  let valuesAdded = [];
  let valuesRemoved = [];
  if (famL === 'sch') {
    const pairs = pairBy(sL.checks, sR.checks, [(c) => c.ruleId, (c) => `${c.context}\u0000${c.test}`]);
    for (const [l, r] of pairs) {
      if (!l) { items.push({ kind: 'added', left: null, right: r, changes: {} }); continue; }
      if (!r) { items.push({ kind: 'removed', left: l, right: null, changes: {} }); continue; }
      const changes = {};
      if (l.kind !== r.kind) changes.kind = [l.kind, r.kind];
      if (l.context !== r.context) changes.context = [l.context, r.context];
      if (l.test !== r.test) changes.test = [l.test, r.test];
      items.push({ kind: Object.keys(changes).length ? 'changed' : 'same', left: l, right: r, changes });
    }
  } else {
    const pairs = pairBy(sL.parts, sR.parts, [(p) => p.ruleId, (p) => p.path || null]);
    for (const [l, r] of pairs) {
      if (!l) { items.push({ kind: 'added', left: null, right: r, changes: {} }); valuesAdded = valuesAdded.concat(r.values); continue; }
      if (!r) { items.push({ kind: 'removed', left: l, right: null, changes: {} }); valuesRemoved = valuesRemoved.concat(l.values); continue; }
      const changes = {};
      if (l.kind !== r.kind) changes.kind = [l.kind, r.kind];
      if (l.path !== r.path) changes.path = [l.path, r.path];
      if (l.flag !== r.flag) changes.flag = [l.flag, r.flag];
      if (l.schema !== r.schema) changes.schema = [l.schema, r.schema];
      const added = multisetDiff(r.values, l.values);
      const removed = multisetDiff(l.values, r.values);
      if (added.length) changes.valuesAdded = added;
      if (removed.length) changes.valuesRemoved = removed;
      valuesAdded = valuesAdded.concat(added);
      valuesRemoved = valuesRemoved.concat(removed);
      items.push({ kind: Object.keys(changes).length ? 'changed' : 'same', left: l, right: r, changes });
    }
  }
  return {
    status: 'compared',
    family: famL,
    items,
    valuesAdded,
    valuesRemoved,
    changed: items.some((i) => i.kind !== 'same'),
  };
}

// ── Summary line ──────────────────────────────────────────────────────────

// left/right: the compare-detail objects of the two BRDPs. → the facts the
// summary line and each row need: which fields are equal, and for the
// rule, whether it is equal as normalized XML plus its structural summary.
//   { title, definition, proposal, validation, ruleState, lastTest: bool,
//     rule: { status: 'equal'|'different'|'none'|'missing', side?, structure,
//             leftText, rightText } }
export function ruleStateOfDetail(detail) {
  const approval = detail?.rule;
  if (!approval) return 'todo';
  return approval.status === 'approved' ? 'verified' : 'draft';
}

export function lastTestOfDetail(detail) {
  const approval = detail?.rule;
  if (!approval || !approval.last_test_result) return null;
  return { result: approval.last_test_result, upToDate: approval.last_test_up_to_date !== false };
}

export function compareDetails(left, right, options = {}) {
  const lRule = left?.rule ? { format: left.rule_format, xml: left.rule.rule_xml } : null;
  const rRule = right?.rule ? { format: right.rule_format, xml: right.rule.rule_xml } : null;
  const nL = lRule ? normalizeRuleXml(lRule.xml, options) : { ok: true, text: '' };
  const nR = rRule ? normalizeRuleXml(rRule.xml, options) : { ok: true, text: '' };
  const structure = compareRuleStructure(lRule, rRule, options);
  let ruleStatus;
  if (!lRule && !rRule) ruleStatus = 'none';
  else if (!lRule || !rRule) ruleStatus = 'missing';
  else ruleStatus = nL.text === nR.text ? 'equal' : 'different';
  const lt = lastTestOfDetail(left);
  const rt = lastTestOfDetail(right);
  return {
    title: textsEqual(left?.title, right?.title),
    definition: textsEqual(left?.definition, right?.definition),
    proposal: textsEqual(left?.proposal, right?.proposal),
    validation: left?.validation === right?.validation,
    ruleState: ruleStateOfDetail(left) === ruleStateOfDetail(right),
    lastTest: JSON.stringify(lt) === JSON.stringify(rt),
    standard: left?.standard === right?.standard,
    rule: {
      status: ruleStatus,
      side: structure.status === 'missing' ? structure.side : undefined,
      structure,
      leftText: nL.text,
      rightText: nR.text,
      normalized: nL.ok && nR.ok,
    },
  };
}
