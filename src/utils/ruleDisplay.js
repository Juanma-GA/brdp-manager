// Formatted, read-only view of a rule (Test de reglas, progreso y causas,
// Part 2.1). Pure (no React, no API): importable from plain Node, the XML
// parser injected (parseXml), as in utils/ruleTestEngine.js.
//
// formatRuleForDisplay(ruleXml, format, { parseXml }) →
//   { ok: true, lines: [{ indent, tokens: [{ type, text }] }], sharedNamespaces: [{ prefix, uri }] }
//   | { ok: false, reason }     the rule is not well-formed: show it as saved.
// Token types: 'element', 'attribute', 'value', 'variable', 'string',
// 'comment', 'keyword', 'text' (anything else: punctuation, names of
// functions, numbers, operators).
//
// It never changes what is stored: the view is built from the rule's DOM
// and the caller copies the raw text.
//   - Whitespace is collapsed except inside string literals (the _normSpace
//     criterion of api/brexToSchematron.js).
//   - Entities and character references show as their characters (the DOM
//     already decoded them: &lt; shows as <, &#211; as Ó).
//   - Schematron @value/@test/@context/@select and BREX objectPath/objpath
//     that do not fit on one line (XPATH_LINE_WIDTH) are split at let, for,
//     some, every, return, if, then, else, satisfies, top-level commas and
//     the braces of anonymous functions, the parts indented. A short one
//     stays on one line.
//   - sch:let shows as "$name := value".
//   - The same xmlns:x="uri" repeated on several elements (EXT-00008
//     declares xmlns:xs on every function) is shown once at the top
//     (sharedNamespaces) and hidden in the elements.
//   - Comments stay where they are.
//
// formatXPath(expr) → [{ indent, glue, tokens }] is exported for the safety
// test (scripts/test-rule-display.mjs): rejoining the lines, each with its
// glue (' ' where the expression had whitespace, '' where it had none),
// gives exactly the expression with whitespace outside literals collapsed.
import { wrapRuleXmlFragment } from './ruleXmlFragment.js';

export const XPATH_LINE_WIDTH = 72;
const SCH_NS = 'http://purl.oclc.org/dsdl/schematron';
const XPATH_ATTRS_SCH = { let: ['value'], assert: ['test'], report: ['test'], rule: ['context'], 'value-of': ['select'] };
const XPATH_TEXT_BREX = new Set(['objectPath', 'objpath']);
const KEYWORDS = new Set(['let', 'for', 'some', 'every', 'return', 'if', 'then', 'else', 'satisfies', 'in', 'as', 'function', 'and', 'or']);
const CLAUSE_OPEN = new Set(['let', 'for', 'some', 'every']);
const CONTINUES = new Set(['return', 'then', 'else', 'satisfies', ':=']);

// ─── XPath ──────────────────────────────────────────────────────────────────
// Tokens: { type, text, space } -- space: whitespace before it in the source.
function tokenizeXPath(expr) {
  const s = String(expr ?? '');
  const out = [];
  let i = 0;
  let space = false;
  const push = (type, text) => {
    out.push({ type, text, space: space && out.length > 0 });
    space = false;
  };
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) {
      space = true;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < s.length) {
        if (s[j] === ch) {
          if (s[j + 1] === ch) {
            j += 2; // '' inside '...' is an escaped quote
            continue;
          }
          break;
        }
        j += 1;
      }
      push('string', s.slice(i, Math.min(j + 1, s.length)));
      i = j + 1;
      continue;
    }
    if (ch === '(' && s[i + 1] === ':') {
      const end = s.indexOf(':)', i + 2);
      const stop = end < 0 ? s.length : end + 2;
      push('comment', s.slice(i, stop).replace(/\s+/g, ' '));
      i = stop;
      continue;
    }
    if (ch === '$') {
      const m = /^\$[\p{L}_][\p{L}\p{N}_.-]*(?::[\p{L}_][\p{L}\p{N}_.-]*)?/u.exec(s.slice(i));
      if (m) {
        push('variable', m[0]);
        i += m[0].length;
        continue;
      }
    }
    if (ch === '@') {
      const m = /^@(?:\*|[\p{L}_][\p{L}\p{N}_.-]*(?::(?:\*|[\p{L}_][\p{L}\p{N}_.-]*))?)/u.exec(s.slice(i));
      if (m) {
        push('attribute', m[0]);
        i += m[0].length;
        continue;
      }
    }
    const name = /^[\p{L}_][\p{L}\p{N}_.-]*(?::[\p{L}_*][\p{L}\p{N}_.-]*)?/u.exec(s.slice(i));
    if (name) {
      const text = name[0];
      const after = s.slice(i + text.length).match(/^\s*(\S)/)?.[1];
      const prev = out[out.length - 1];
      const axis = s.slice(i + text.length).startsWith('::');
      // A keyword even before "(" ("then ()", "else (...)"): no function
      // is called then/else/return...; a name step after "/" or "::" is a
      // name ("//if" is an element).
      const isKeyword = KEYWORDS.has(text) && !axis && !(prev && (prev.text === '/' || prev.text === '//' || prev.text === '::'));
      push(isKeyword ? 'keyword' : after === '(' || axis ? 'text' : 'element', text);
      i += text.length;
      continue;
    }
    const two = s.slice(i, i + 2);
    if ([':=', '//', '::', '!=', '<=', '>=', '=>', '||', '..'].includes(two)) {
      push('text', two);
      i += 2;
      continue;
    }
    const num = /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(s.slice(i));
    if (num) {
      push('text', num[0]);
      i += num[0].length;
      continue;
    }
    push('text', ch);
    i += 1;
  }
  return out;
}

export function formatXPath(expr) {
  const tokens = tokenizeXPath(expr);
  const flat = tokens.map((t, i) => (i && t.space ? ' ' : '') + t.text).join('');
  if (flat.length <= XPATH_LINE_WIDTH) {
    return [{ indent: 0, glue: '', tokens: tokens.map((t, i) => ({ type: t.type, text: (i && t.space ? ' ' : '') + t.text })) }];
  }
  // Split. Inside each brace block, a token is "at statement level" when no
  // ( or [ opened since the block started. Clauses on a stack: a let/for/
  // some/every (its binding commas one level in, its return/satisfies back
  // at its own level) and an if (then/else one level in). A clause starts at
  // the indentation of the line it is written on.
  const lines = [];
  let line = null;
  const newLine = (indent) => {
    line = { indent, glue: '', tokens: [] };
    lines.push(line);
  };
  newLine(0);
  const blocks = [{ depth: 0, clauses: [], base: 0 }];
  const top = () => blocks[blocks.length - 1];
  const lastText = () => {
    for (let l = lines.length - 1; l >= 0; l -= 1) {
      const toks = lines[l].tokens;
      if (toks.length) return toks[toks.length - 1].text.trim();
    }
    return '';
  };
  const breakAt = (indent) => {
    if (line.tokens.length === 0) line.indent = indent;
    else newLine(indent);
  };
  const lastClause = (b, kind) => {
    for (let k = b.clauses.length - 1; k >= 0; k -= 1) if (b.clauses[k].kind === kind) return k;
    return -1;
  };
  for (const tok of tokens) {
    const text = tok.text;
    const b = top();
    const atStatement = b.depth === 0;
    if (tok.type === 'keyword' && atStatement) {
      if (CLAUSE_OPEN.has(text) || text === 'if') {
        if (line.tokens.length && !CONTINUES.has(lastText())) breakAt(line.indent);
        b.clauses.push({ kind: text === 'if' ? 'if' : 'bind', indent: line.indent });
      } else if (text === 'return' || text === 'satisfies') {
        const k = lastClause(b, 'bind');
        if (k >= 0) {
          const { indent } = b.clauses[k];
          b.clauses.length = k;
          breakAt(indent);
        }
      } else if (text === 'then' || text === 'else') {
        const k = lastClause(b, 'if');
        if (k >= 0) {
          const { indent } = b.clauses[k];
          if (text === 'else') b.clauses.length = k;
          else b.clauses.length = k + 1;
          breakAt(indent + 1);
        }
      }
    } else if (text === '}' && blocks.length > 1) {
      const closed = blocks.pop();
      breakAt(Math.max(0, closed.base - 1));
      line.tokens.push({ type: 'text', text: (tok.space ? ' ' : '') + text });
      continue;
    }
    line.tokens.push({ type: tok.type, text: (tok.space ? ' ' : '') + text });
    if (text === '(' || text === '[') b.depth += 1;
    else if (text === ')' || text === ']') b.depth = Math.max(0, b.depth - 1);
    else if (text === '{') {
      blocks.push({ depth: 0, clauses: [], base: line.indent + 1 });
      newLine(line.indent + 1);
    } else if (text === ',' && atStatement) {
      const k = lastClause(b, 'bind');
      newLine(k >= 0 ? b.clauses[k].indent + 1 : line.indent);
    }
  }
  // A break written where the source had whitespace keeps it as glue; a
  // line that starts right after one with nothing in between glues with ''.
  for (const l of lines) {
    if (!l.tokens.length) continue;
    l.glue = l.tokens[0].text.startsWith(' ') ? ' ' : '';
    l.tokens[0] = { ...l.tokens[0], text: l.tokens[0].text.replace(/^ /, '') };
  }
  return lines.filter((l, i) => l.tokens.length || i === 0);
}

// Glue of a line written after a token: the space it had in the source.
// Rejoins the lines like the source, whitespace outside literals collapsed.
export function joinXPathLines(lines) {
  return lines.map((l, i) => (i ? l.glue : '') + l.tokens.map((t) => t.text).join('')).join('');
}

// Whitespace outside string literals collapsed to one space, trimmed.
export function collapseOutsideLiterals(text) {
  return joinXPathLines([{ indent: 0, glue: '', tokens: tokenizeXPath(text).map((t, i) => ({ text: (i && t.space ? ' ' : '') + t.text })) }]);
}

// ─── XML ────────────────────────────────────────────────────────────────────
const local = (n) => n.localName || String(n.nodeName).replace(/^.*:/, '');
const collapse = (s) => String(s || '').replace(/\s+/g, ' ');

// A Schematron element of the rule: by local name, with or without prefix
// (the fragment's own prefix is declared with a dummy URI by
// wrapRuleXmlFragment, so the namespace cannot tell it apart).
const isSchElement = (el, name) => local(el) === name && (!el.namespaceURI || el.namespaceURI === SCH_NS || el.prefix === 'sch' || !el.prefix);

function xpathAttrsOf(el, format) {
  if (format !== 'SCH-DITA') return [];
  const name = local(el);
  return XPATH_ATTRS_SCH[name] && isSchElement(el, name) ? XPATH_ATTRS_SCH[name] : [];
}

// A comment's text is not parsed by XML: its references show decoded here.
const decodeRefs = (s) =>
  String(s).replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|(lt|gt|amp|quot|apos));/g, (m, dec, hex, named) =>
    dec ? String.fromCodePoint(Number(dec)) : hex ? String.fromCodePoint(parseInt(hex, 16)) : { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[named]
  );

function namespaceUsage(root) {
  const seen = new Map();
  const walk = (el) => {
    for (const a of Array.from(el.attributes || [])) {
      if (a.name.startsWith('xmlns:')) {
        const key = `${a.name}\u0000${a.value}`;
        seen.set(key, (seen.get(key) || 0) + 1);
      }
    }
    for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) walk(n);
  };
  for (let n = root.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) walk(n);
  return seen;
}

export function formatRuleForDisplay(ruleXml, format, { parseXml } = {}) {
  let doc;
  try {
    const parse = parseXml || ((x) => new DOMParser().parseFromString(x, 'application/xml'));
    doc = parse(wrapRuleXmlFragment(String(ruleXml || '')));
    if (!doc?.documentElement || doc.getElementsByTagName('parsererror').length) throw new Error('not well-formed');
  } catch (err) {
    return { ok: false, reason: err?.message || 'not well-formed' };
  }
  const root = doc.documentElement;
  const usage = namespaceUsage(root);
  const shared = new Set([...usage].filter(([, n]) => n > 1).map(([k]) => k));
  const sharedNamespaces = [...shared].map((k) => {
    const [name, uri] = k.split('\u0000');
    return { prefix: name.slice(6), uri };
  });
  const lines = [];
  const emit = (indent, tokens) => lines.push({ indent, tokens });

  const shownAttrs = (el) =>
    Array.from(el.attributes || []).filter((a) => !(a.name.startsWith('xmlns:') && shared.has(`${a.name}\u0000${a.value}`)));

  // An XPath value: on its line if it fits, else its lines under the
  // element, two more levels in.
  const xpathTokens = (expr) => formatXPath(collapseOutsideLiterals(expr));
  const pushAttr = (tokens, a, isXPath, indent, after) => {
    if (!isXPath) {
      tokens.push({ type: 'text', text: ' ' }, { type: 'attribute', text: a.name }, { type: 'text', text: '="' }, { type: 'value', text: collapse(a.value) }, { type: 'text', text: '"' });
      return;
    }
    const xl = xpathTokens(a.value);
    tokens.push({ type: 'text', text: ' ' }, { type: 'attribute', text: a.name }, { type: 'text', text: '="' });
    if (xl.length === 1) {
      tokens.push(...xl[0].tokens, { type: 'text', text: '"' });
      return;
    }
    after.push({ lines: xl, indent: indent + 2 });
  };

  const inlineTokens = (el) => {
    const tokens = [];
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3 || n.nodeType === 4) tokens.push({ type: 'text', text: collapse(n.data) });
      else if (n.nodeType === 8) tokens.push({ type: 'comment', text: `<!--${collapse(decodeRefs(n.data))}-->` });
      else if (n.nodeType === 1) {
        const open = [{ type: 'text', text: '<' }, { type: 'element', text: n.nodeName }];
        for (const a of shownAttrs(n)) open.push({ type: 'text', text: ' ' }, { type: 'attribute', text: a.name }, { type: 'text', text: '="' }, { type: 'value', text: collapse(a.value) }, { type: 'text', text: '"' });
        if (!n.firstChild) tokens.push(...open, { type: 'text', text: '/>' });
        else tokens.push(...open, { type: 'text', text: '>' }, ...inlineTokens(n), { type: 'text', text: `</${n.nodeName}>` });
      }
    }
    return tokens;
  };
  const trimTokens = (tokens) => {
    const t = tokens.filter((x) => x.text !== '');
    if (t.length && t[0].type === 'text') t[0] = { ...t[0], text: t[0].text.replace(/^\s+/, '') };
    const last = t.length - 1;
    if (last >= 0 && t[last].type === 'text') t[last] = { ...t[last], text: t[last].text.replace(/\s+$/, '') };
    return t.filter((x) => x.text !== '');
  };

  const walk = (el, indent) => {
    const name = local(el);
    // sch:let → "$name := value".
    if (format === 'SCH-DITA' && isSchElement(el, 'let') && el.getAttribute('name')) {
      const head = [{ type: 'variable', text: `$${el.getAttribute('name')}` }, { type: 'text', text: ' := ' }];
      const xl = xpathTokens(el.getAttribute('value') || '');
      if (xl.length === 1) emit(indent, [...head, ...xl[0].tokens]);
      else {
        emit(indent, [...head, ...xl[0].tokens]);
        // A function's body one level in and its "}" under "$name"; any
        // other split one more level in.
        const opensBlock = /\{$/.test(xl[0].tokens.map((t) => t.text).join('').trim());
        for (const l of xl.slice(1)) emit(indent + (opensBlock ? 0 : 1) + l.indent, l.tokens);
      }
      return;
    }
    const xpathAttrs = xpathAttrsOf(el, format);
    const open = [{ type: 'text', text: '<' }, { type: 'element', text: el.nodeName }];
    const after = [];
    for (const a of shownAttrs(el)) pushAttr(open, a, xpathAttrs.includes(a.name), indent, after);
    const children = Array.from(el.childNodes);
    const hasText = children.some((n) => (n.nodeType === 3 || n.nodeType === 4) && n.data.trim());
    const isXPathText = format !== 'SCH-DITA' && XPATH_TEXT_BREX.has(name);
    if (children.length === 0 || (!hasText && children.every((n) => n.nodeType === 3))) {
      if (after.length) {
        emit(indent, open);
        for (const { lines: xl, indent: ind } of after) xl.forEach((l, i) => emit(ind + l.indent, i === xl.length - 1 ? [...l.tokens, { type: 'text', text: '"' }] : l.tokens));
        emit(indent, [{ type: 'text', text: '/>' }]);
      } else emit(indent, [...open, { type: 'text', text: '/>' }]);
      return;
    }
    const close = [{ type: 'text', text: `</${el.nodeName}>` }];
    if (after.length) {
      emit(indent, open);
      for (const { lines: xl, indent: ind } of after) xl.forEach((l, i) => emit(ind + l.indent, i === xl.length - 1 ? [...l.tokens, { type: 'text', text: '"' }] : l.tokens));
      emit(indent, [{ type: 'text', text: '>' }]);
    } else open.push({ type: 'text', text: '>' });
    if (isXPathText && children.every((n) => n.nodeType === 3 || n.nodeType === 4)) {
      const xl = xpathTokens(el.textContent);
      if (xl.length === 1 && !after.length) {
        emit(indent, [...open, ...xl[0].tokens, ...close]);
        return;
      }
      if (!after.length) emit(indent, open);
      for (const l of xl) emit(indent + 1 + l.indent, l.tokens);
      emit(indent, close);
      return;
    }
    if (hasText) {
      // Mixed content (a message with sch:value-of): on one line, as text.
      const body = trimTokens(inlineTokens(el));
      if (!after.length) emit(indent, [...open, ...body, ...close]);
      else {
        emit(indent + 1, body);
        emit(indent, close);
      }
      return;
    }
    if (!after.length) emit(indent, open);
    for (const n of children) {
      if (n.nodeType === 1) walk(n, indent + 1);
      else if (n.nodeType === 8) commentLines(n, indent + 1);
    }
    emit(indent, close);
  };
  const commentLines = (n, indent) => {
    const rows = decodeRefs(n.data).split('\n').map((r) => r.trim());
    while (rows.length && !rows[0]) rows.shift();
    while (rows.length && !rows[rows.length - 1]) rows.pop();
    if (rows.length <= 1) {
      emit(indent, [{ type: 'comment', text: `<!-- ${rows[0] || ''} -->` }]);
      return;
    }
    emit(indent, [{ type: 'comment', text: `<!-- ${rows[0]}` }]);
    for (const r of rows.slice(1, -1)) emit(indent + 1, [{ type: 'comment', text: r }]);
    emit(indent + 1, [{ type: 'comment', text: `${rows[rows.length - 1]} -->` }]);
  };
  for (let n = root.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1) walk(n, 0);
    else if (n.nodeType === 8) commentLines(n, 0);
  }
  return { ok: true, lines, sharedNamespaces };
}

// The XPath expressions of a formatted rule, each rejoined -- for the
// safety test: every one must parse and equal its source collapsed.
export function ruleXPathExpressions(ruleXml, format, { parseXml } = {}) {
  let doc;
  try {
    const parse = parseXml || ((x) => new DOMParser().parseFromString(x, 'application/xml'));
    doc = parse(wrapRuleXmlFragment(String(ruleXml || '')));
  } catch {
    return [];
  }
  const out = [];
  const walk = (el) => {
    for (const name of xpathAttrsOf(el, format)) if (el.hasAttribute(name)) out.push(el.getAttribute(name));
    if (format !== 'SCH-DITA' && XPATH_TEXT_BREX.has(local(el))) out.push(el.textContent);
    for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) walk(n);
  };
  walk(doc.documentElement);
  return out;
}
