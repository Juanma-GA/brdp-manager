// Mejoras A, Part 3: a BREX rule element allows ONE path and ONE use --
// <structureObjectRule> (brDecisionRef*, objectPath, objectUse?,
// objectValue*) in brex4.2.xsd / brex4.1.xsd, <objrule> (objpath, objuse?,
// objval*) in the 3.0.1 brex.xsd. Suggest Rule on BRDP-S1-00186 got ONE
// <structureObjectRule> with two <objectPath> and two <objectUse>
// (invalid against the XSD). When the children alternate mechanically --
// path, use, [values], path, use, [values], … with as many uses as paths
// (after the 4.2 brDecisionRef, which each new rule keeps) -- the
// application splits it into one rule per path, before validating: same
// attributes (brSeverityLevel…), id "{id}-1" … "{id}-N" (never one already
// used in the fragment), each objectValue with the path before it. Anything
// else (two paths and one use, loose text, an unknown child) is left as it
// is, and the format check says what is wrong (rule_format_multiple).
// Pure and text-based (the rest of the fragment stays byte for byte), so
// the same code runs in the browser and in Node.

const SHAPES = {
  'BREX-4.2': { rule: 'structureObjectRule', path: 'objectPath', use: 'objectUse', value: 'objectValue', head: 'brDecisionRef' },
  'BREX-4.1': { rule: 'structureObjectRule', path: 'objectPath', use: 'objectUse', value: 'objectValue', head: 'brDecisionRef' },
  'BREX-3.0.1': { rule: 'objrule', path: 'objpath', use: 'objuse', value: 'objval', head: null },
};

const TOKEN_RE = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
const ID_ATTR_RE = /(\sid\s*=\s*)(["'])([^"']*)\2/;

const localName = (name) => name.replace(/^.*:/, '');

// Every element of `name` in the fragment with its direct children:
// [{ start, openEnd, closeStart, end, openTag, children: [{ kind:
// 'element'|'comment'|'text', name, start, end }] }].
function ruleElements(xml, name) {
  const out = [];
  const stack = []; // { rule } for a rule element, {} for any other
  let m;
  let last = 0;
  TOKEN_RE.lastIndex = 0;
  const inRule = () => stack[stack.length - 1]?.rule || null;
  while ((m = TOKEN_RE.exec(xml))) {
    const start = m.index;
    const end = TOKEN_RE.lastIndex;
    const between = xml.slice(last, start);
    if (inRule() && between.trim()) inRule().children.push({ kind: 'text', start: last, end: start });
    last = end;
    const [token, closing, qname, , selfClosing] = m;
    const rule = inRule();
    if (!qname) {
      if (rule && token.startsWith('<!--')) rule.children.push({ kind: 'comment', start, end });
      else if (rule && token.startsWith('<![CDATA[') && token.slice(9, -3).trim()) rule.children.push({ kind: 'text', start, end });
      continue;
    }
    if (closing) {
      const frame = stack.pop();
      if (!frame) return null; // not well-formed: left alone
      if (frame.child) frame.child.end = end;
      if (frame.rule) {
        frame.rule.closeStart = start;
        frame.rule.end = end;
        out.push(frame.rule);
      }
      continue;
    }
    const local = localName(qname);
    const child = rule ? { kind: 'element', name: local, start, end } : null;
    if (child) rule.children.push(child);
    if (selfClosing) continue;
    stack.push(local === name ? { rule: { start, openEnd: end, openTag: token, children: [] }, child } : { child });
  }
  return stack.length === 0 ? out : null;
}

// The new rules of one rule element, or null when it is not mechanical.
function splitOne(xml, rule, shape, usedIds) {
  const elements = rule.children.filter((c) => c.kind === 'element');
  const paths = elements.filter((c) => c.name === shape.path).length;
  if (paths < 2) return null;
  if (rule.children.some((c) => c.kind === 'text')) return null;
  // head: comments and brDecisionRef before the first path.
  const head = [];
  let i = 0;
  const items = rule.children;
  while (i < items.length && (items[i].kind === 'comment' || (shape.head && items[i].name === shape.head))) {
    head.push(items[i]);
    i += 1;
  }
  const groups = [];
  let pendingComments = [];
  for (; i < items.length; i += 1) {
    const c = items[i];
    if (c.kind === 'comment') {
      pendingComments.push(c);
      continue;
    }
    if (c.name === shape.path) {
      groups.push({ parts: [...pendingComments, c], hasUse: false, values: 0 });
    } else if (c.name === shape.use) {
      const g = groups[groups.length - 1];
      if (!g || g.hasUse || g.values > 0) return null;
      g.hasUse = true;
      g.parts.push(...pendingComments, c);
    } else if (c.name === shape.value) {
      const g = groups[groups.length - 1];
      if (!g || !g.hasUse) return null;
      g.values += 1;
      g.parts.push(...pendingComments, c);
    } else {
      return null;
    }
    pendingComments = [];
  }
  if (groups.length < 2 || groups.some((g) => !g.hasUse)) return null;
  if (pendingComments.length) groups[groups.length - 1].parts.push(...pendingComments);

  const text = (c) => xml.slice(c.start, c.end);
  const firstChild = rule.children[0];
  const lead = firstChild ? xml.slice(rule.openEnd, firstChild.start) : '';
  const indent = /\n([ \t]*)$/.exec(lead)?.[1];
  const sep = indent !== undefined ? `\n${indent}` : '';
  const closeIndent = /\n([ \t]*)$/.exec(xml.slice(rule.children[rule.children.length - 1].end, rule.closeStart))?.[1];
  const closeSep = closeIndent !== undefined ? `\n${closeIndent}` : '';
  const idMatch = ID_ATTR_RE.exec(rule.openTag);
  const id = idMatch ? idMatch[3] : null;
  const closeTag = xml.slice(rule.closeStart, rule.end);
  const headText = head.filter((c) => c.kind !== 'comment').map(text);
  const leadingComments = head.filter((c) => c.kind === 'comment').map(text);
  let n = 1;
  const rules = groups.map((g, index) => {
    let openTag = rule.openTag;
    if (id !== null) {
      while (usedIds.has(`${id}-${n}`)) n += 1;
      const newId = `${id}-${n}`;
      usedIds.add(newId);
      n += 1;
      openTag = openTag.replace(ID_ATTR_RE, (_m, pre, q) => `${pre}${q}${newId}${q}`);
    }
    const parts = [...(index === 0 ? leadingComments : []), ...headText, ...g.parts.map(text)];
    return `${openTag}${sep}${parts.join(sep)}${closeSep}${closeTag}`;
  });
  // Between rules: the indentation the original rule element had.
  const before = xml.slice(0, rule.start);
  const ruleIndent = /\n([ \t]*)$/.exec(before)?.[1] ?? '';
  return rules.join(`\n${ruleIndent}`);
}

// → { xml, rules: [{ id, count }], total } -- `rules` lists every split rule
// element (its id, or null, and how many rules it became); `total` the
// rules produced. xml is unchanged when nothing was split.
export function splitMultiPathRules(ruleXml, format) {
  const shape = SHAPES[format];
  const source = String(ruleXml ?? '');
  const none = { xml: source, rules: [], total: 0 };
  if (!shape) return none;
  const found = ruleElements(source, shape.rule);
  if (!found || found.length === 0) return none;
  const usedIds = new Set([...source.matchAll(/\sid\s*=\s*["']([^"']*)["']/g)].map((m) => m[1]));
  const edits = [];
  for (const rule of found) {
    const replacement = splitOne(source, rule, shape, usedIds);
    if (replacement === null) continue;
    const count = rule.children.filter((c) => c.kind === 'element' && c.name === shape.path).length;
    edits.push({ start: rule.start, end: rule.end, replacement, id: ID_ATTR_RE.exec(rule.openTag)?.[3] ?? null, count });
  }
  if (edits.length === 0) return none;
  edits.sort((a, b) => a.start - b.start);
  let xml = '';
  let at = 0;
  for (const e of edits) {
    xml += source.slice(at, e.start) + e.replacement;
    at = e.end;
  }
  xml += source.slice(at);
  return { xml, rules: edits.map((e) => ({ id: e.id, count: e.count })), total: edits.reduce((sum, e) => sum + e.count, 0) };
}

// The first rule element with more than one path or use child -- { element,
// child, count } -- or null (checkRuleFormat's rule_format_multiple; the
// backend twin is rule_format_check.py).
export function multiplePathOrUse(ruleXml, format) {
  const shape = SHAPES[format];
  if (!shape) return null;
  const found = ruleElements(String(ruleXml ?? ''), shape.rule) || [];
  found.sort((a, b) => a.start - b.start);
  for (const rule of found) {
    for (const child of [shape.path, shape.use]) {
      const count = rule.children.filter((c) => c.kind === 'element' && c.name === child).length;
      if (count > 1) return { element: shape.rule, child, count };
    }
  }
  return null;
}

// Generate (Mejoras A, Part 3): a stored rule with two objectPath used to
// be written as it is -- a BREX invalid against its XSD, reported as valid
// -- and the Schematron output kept only its first path. The output now
// splits a mechanical one (the stored rule never changes) and reports a
// rule that cannot be split, which stays as written: { rules, multiPath:
// { split: [{ identifier, count }], invalid: [{ identifier, element,
// child, count }] } }.
export function splitApprovedRulesMultiPath(rules, format) {
  const split = [];
  const invalid = [];
  const out = rules.map((rule) => {
    const r = splitMultiPathRules(rule.xml, format);
    if (r.total > 0) split.push({ identifier: rule.identifier, count: r.total });
    const left = multiplePathOrUse(r.xml, format);
    if (left) invalid.push({ identifier: rule.identifier, ...left });
    return { ...rule, xml: r.xml };
  });
  return { rules: out, multiPath: { split, invalid } };
}

// ─── Duplicate ids (Mejoras B, Part 4.3) ────────────────────────────────────
// A rule element's id is xs:ID in the three BREX XSDs: two rules with the
// same id make the BREX invalid. Real case: Suggest Rule on
// rule-4-2-two-decisions-levels-and-title answered two <structureObjectRule>
// with the same id. The ids of the rule elements of one fragment:
//   duplicateRuleIds(ruleXml, format) → { element, ids: [id] } | null
export function duplicateRuleIds(ruleXml, format) {
  const shape = SHAPES[format];
  if (!shape) return null;
  const found = ruleElements(String(ruleXml ?? ''), shape.rule) || [];
  const seen = new Map();
  for (const rule of found) {
    const id = ID_ATTR_RE.exec(rule.openTag)?.[3];
    if (id) seen.set(id, (seen.get(id) || 0) + 1);
  }
  const ids = [...seen].filter(([, n]) => n > 1).map(([id]) => id);
  return ids.length ? { element: shape.rule, ids } : null;
}

// Every rule element sharing a duplicated id gets {id}-1 … {id}-N, in
// document order, skipping ids already used in the fragment ("next free").
// Text-based: only those id attributes change.
//   numberDuplicateRuleIds(ruleXml, format) → { xml, renamed: [{ id, to: [ids] }] }
export function numberDuplicateRuleIds(ruleXml, format) {
  const source = String(ruleXml ?? '');
  const dup = duplicateRuleIds(source, format);
  if (!dup) return { xml: source, renamed: [] };
  const shape = SHAPES[format];
  const found = (ruleElements(source, shape.rule) || []).sort((a, b) => a.start - b.start);
  const usedIds = new Set([...source.matchAll(/\sid\s*=\s*["']([^"']*)["']/g)].map((m) => m[1]));
  const next = new Map();
  const renamed = new Map();
  const edits = [];
  for (const rule of found) {
    const m = ID_ATTR_RE.exec(rule.openTag);
    if (!m || !dup.ids.includes(m[3])) continue;
    const id = m[3];
    let n = next.get(id) || 1;
    while (usedIds.has(`${id}-${n}`)) n += 1;
    const newId = `${id}-${n}`;
    usedIds.add(newId);
    next.set(id, n + 1);
    if (!renamed.has(id)) renamed.set(id, []);
    renamed.get(id).push(newId);
    const openTag = rule.openTag.replace(ID_ATTR_RE, (_x, pre, q) => `${pre}${q}${newId}${q}`);
    edits.push({ start: rule.start, end: rule.openEnd, text: openTag });
  }
  let xml = '';
  let at = 0;
  for (const e of edits) {
    xml += source.slice(at, e.start) + e.text;
    at = e.end;
  }
  xml += source.slice(at);
  return { xml, renamed: [...renamed].map(([id, to]) => ({ id, to })) };
}

// Generate (Mejoras B, Part 4.3): before this, a stored rule with two rule
// elements sharing an id was written as it is and the BREX was invalid
// against its XSD (xs:ID) while the application's own check said "valid";
// only the server-side XSD validation showed it, as a libxml2 message. Now,
// in the output only (the stored rule never changes): duplicates WITHIN one
// BRDP's rule are numbered ({id}-1 …); the same id in rules of DIFFERENT
// BRDPs is reported (never renamed -- which one to rename is the person's
// decision): { rules, duplicateIds: { numbered: [{ identifier, ids }],
// clashes: [{ id, identifiers }] } }.
export function numberApprovedRulesDuplicateIds(rules, format) {
  const numbered = [];
  const out = rules.map((rule) => {
    const r = numberDuplicateRuleIds(rule.xml, format);
    if (r.renamed.length) numbered.push({ identifier: rule.identifier, ids: r.renamed.map((x) => x.id) });
    return { ...rule, xml: r.xml };
  });
  const shape = SHAPES[format];
  const owners = new Map();
  if (shape) {
    for (const rule of out) {
      for (const el of ruleElements(String(rule.xml ?? ''), shape.rule) || []) {
        const id = ID_ATTR_RE.exec(el.openTag)?.[3];
        if (!id) continue;
        if (!owners.has(id)) owners.set(id, new Set());
        owners.get(id).add(rule.identifier);
      }
    }
  }
  const clashes = [...owners].filter(([, set]) => set.size > 1).map(([id, set]) => ({ id, identifiers: [...set] }));
  return { rules: out, duplicateIds: { numbered, clashes } };
}

// The ids of the rule elements of a fragment, in document order (BREX:
// structureObjectRule / objrule; Schematron: pattern, rule, assert, report)
// -- for "an id used by the rules of two BRDPs" (Corrección propuesta).
const SCH_ID_RE = /<(?:[A-Za-z_][\w.-]*:)?(?:pattern|rule|assert|report)\b[^>]*?\sid\s*=\s*(["'])([^"']*)\1/g;
export function ruleElementIds(ruleXml, format) {
  const source = String(ruleXml ?? '');
  const shape = SHAPES[format];
  if (shape) {
    return (ruleElements(source, shape.rule) || [])
      .sort((a, b) => a.start - b.start)
      .map((rule) => ID_ATTR_RE.exec(rule.openTag)?.[3])
      .filter(Boolean);
  }
  if (format === 'SCH-DITA') {
    const text = source.replace(/<!--[\s\S]*?-->/g, (c) => ' '.repeat(c.length));
    return [...text.matchAll(SCH_ID_RE)].map((m) => m[2]);
  }
  return [];
}
