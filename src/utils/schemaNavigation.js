// "Nombres navegables en las respuestas de Ask sin IA": in an answer taken
// from the schema (utils/structuralAnswer.js), each element `<x>` and
// attribute `@y` that exists in the project's vocabulary is a link; a click
// opens a floating card (components/assistant/SchemaNavCard.jsx) where the
// user can keep walking the schema -- children, parents, attributes,
// values, owning elements -- with a breadcrumb and Back. Nothing is added
// to the Ask thread.
//
// Pure (no React, no fetch), so scripts/test-schema-navigation.mjs checks
// it under Node: which names become links, the navigation stack, the cache
// keys, the list cutting and the two card models.
import { summarizeSchemaFactEntry } from './schemaFactSummary.js';

// Imported helper schemas, never a document type (as structuralAnswer.js
// and the backend's _NON_DOCUMENT_SCHEMAS).
const NON_DOCUMENT_SCHEMAS = new Set(['dc', 'rdf', 'xlink', 'xcf']);

// Longer lists show this many names and a "+N more" that expands the rest.
export const SCHEMA_NAV_LIST_MAX = 20;

// ─── Which names are links ──────────────────────────────────────────────────

// The structural answers write names as inline code: `<x>` for an element,
// `@x` for an attribute. A name is a link only if it exists in the
// vocabulary AS THE KIND IT IS WRITTEN AS -- a name that is both element and
// attribute opens the kind the answer shows; `<x>` for a name that is only
// an attribute (or not in the schema at all) stays plain text.
const ELEMENT_CODE_RE = /^<([^\s<>/@]+)>$/;
const ATTRIBUTE_CODE_RE = /^@([^\s<>/@]+)$/;

export function schemaLinkTarget(codeText, vocabulary) {
  if (!vocabulary || typeof codeText !== 'string') return null;
  const text = codeText.trim();
  const element = ELEMENT_CODE_RE.exec(text);
  if (element) return vocabulary.elements.has(element[1]) ? { kind: 'element', name: element[1] } : null;
  const attribute = ATTRIBUTE_CODE_RE.exec(text);
  if (attribute) return vocabulary.attributes.has(attribute[1]) ? { kind: 'attribute', name: attribute[1] } : null;
  return null;
}

export const targetLabel = (target) => (target.kind === 'attribute' ? `@${target.name}` : `<${target.name}>`);
// Breadcrumb: "para › levelledPara › title", attributes with their "@".
export const crumbLabel = (target) => (target.kind === 'attribute' ? `@${target.name}` : target.name);
export const targetKey = (target) => `${target.kind}:${target.name}`;
const sameTarget = (a, b) => !!a && !!b && a.kind === b.kind && a.name === b.name;

// ─── Navigation stack (breadcrumb) ──────────────────────────────────────────

// The stack is the breadcrumb: the first entry is the name clicked in the
// answer, the last one the card on screen.
export const openStack = (target) => [target];

// Clicking a name in the card. The card on screen again is a no-op; a name
// already in the breadcrumb goes back to it (never a loop in the path).
export function pushStack(stack, target) {
  const existing = stack.findIndex((t) => sameTarget(t, target));
  if (existing >= 0) return stack.slice(0, existing + 1);
  return [...stack, target];
}

// Back: one step. On the first card there is nowhere to go (the caller
// shows no Back button there).
export const backStack = (stack) => (stack.length > 1 ? stack.slice(0, -1) : stack);

// A breadcrumb entry clicked: back to it.
export const goToStack = (stack, index) => (index >= 0 && index < stack.length ? stack.slice(0, index + 1) : stack);

export const currentTarget = (stack) => (stack.length ? stack[stack.length - 1] : null);

// ─── Lists ──────────────────────────────────────────────────────────────────

// Sorted names; with more than `max`, the first `max` and how many more.
// Expanded, all of them -- no name is ever lost.
export function cutNames(names, { expanded = false, max = SCHEMA_NAV_LIST_MAX } = {}) {
  const sorted = [...new Set(names)].sort((a, b) => a.localeCompare(b));
  if (expanded || sorted.length <= max) return { shown: sorted, hidden: 0 };
  return { shown: sorted.slice(0, max), hidden: sorted.length - max };
}

// ─── Card models ────────────────────────────────────────────────────────────

// Element card, from the full card entry (GET /api/schema-cards?full=true):
// children and attributes grouped as in the structural answers --
// 'common' (common to every schema, plus what some schemas add), 'bySchema'
// (nothing is common: one group per schema set), 'none' -- and the parents
// (never per variant in this data).
export function elementCardModel(entry) {
  const summary = summarizeSchemaFactEntry(entry);
  const parents = entry.parents || [];
  if (!summary.common) {
    const v = (entry.variants || [])[0] || { schemas: [], attributes: [], children: [] };
    const kind = (list) => ({ mode: list.length ? 'single' : 'none', common: list, groups: [] });
    return {
      schemas: v.schemas || [],
      schemaCount: summary.schemaCount,
      multiVariant: false,
      children: kind(v.children || []),
      attributes: kind(v.attributes || []),
      parents,
    };
  }
  const groupsOf = (key) =>
    summary.perVariant.map((v) => ({ schemas: v.schemas, items: key === 'children' ? v.diffChildren : v.diffAttributes }));
  const kind = (mode, common, key) => {
    if (mode === 'common') return { mode, common, groups: groupsOf(key).filter((g) => g.items.length) };
    if (mode === 'bySchema') return { mode, common: [], groups: groupsOf(key) };
    return { mode: 'none', common: [], groups: [] };
  };
  return {
    schemas: [],
    schemaCount: summary.schemaCount,
    multiVariant: true,
    children: kind(summary.childrenMode, summary.common.children, 'children'),
    attributes: kind(summary.attributesMode, summary.common.attributes, 'attributes'),
    parents,
  };
}

// Attribute card, from GET /api/schema-cards/attribute's owners
// ([{ element, schemas, required, enum }]): its values grouped by value
// list (with the elements each list applies to) and the elements that have
// it grouped by schema (as the "which elements have @x" answer).
export function attributeCardModel(owners) {
  const list = owners || [];
  const valueGroups = new Map();
  for (const o of list) {
    const key = JSON.stringify(o.enum || null);
    if (!valueGroups.has(key)) valueGroups.set(key, { values: o.enum || null, elements: new Set() });
    valueGroups.get(key).elements.add(o.element);
  }
  const values = [...valueGroups.values()].map((g) => ({ values: g.values, elements: [...g.elements].sort((a, b) => a.localeCompare(b)) }));

  const bySchema = new Map();
  for (const o of list) {
    const documentSchemas = (o.schemas || []).filter((s) => !NON_DOCUMENT_SCHEMAS.has(s));
    for (const schema of documentSchemas.length ? documentSchemas : o.schemas || []) {
      if (!bySchema.has(schema)) bySchema.set(schema, new Set());
      bySchema.get(schema).add(o.element);
    }
  }
  const elements = [...new Set(list.map((o) => o.element))];
  const groups = new Map();
  for (const [schema, set] of [...bySchema].sort((a, b) => a[0].localeCompare(b[0]))) {
    const key = [...set].sort().join('|');
    if (!groups.has(key)) groups.set(key, { elements: [...set], schemas: [] });
    groups.get(key).schemas.push(schema);
  }
  const schemaGroups = [...groups.values()];
  let ownersModel;
  if (!elements.length) ownersModel = { mode: 'none', common: [], groups: [] };
  else if (schemaGroups.length <= 1) ownersModel = { mode: 'same', common: elements, groups: [] };
  else {
    const common = elements.filter((e) => [...bySchema.values()].every((set) => set.has(e)));
    ownersModel = common.length
      ? {
          mode: 'common',
          common,
          groups: schemaGroups
            .map((g) => ({ schemas: g.schemas, items: g.elements.filter((e) => !common.includes(e)) }))
            .filter((g) => g.items.length),
        }
      : { mode: 'bySchema', common: [], groups: schemaGroups.map((g) => ({ schemas: g.schemas, items: g.elements })) };
  }
  return { exists: elements.length > 0, schemaCount: bySchema.size, values, owners: ownersModel };
}

// ─── Card cache ─────────────────────────────────────────────────────────────

// A request that never answers must not leave the card loading forever
// (HR7): after this long it becomes a visible error with Retry.
const SCHEMA_NAV_TIMEOUT_MS = 20000;

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'timeout' })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// One card's data: { status: 'ready', data } for an element ({ entry }, or
// { missing: true }) or an attribute ({ owners }); 'unavailable' when the
// standard has no schema cards.
async function loadCard(target, standard, fetchCards, fetchAttribute) {
  if (target.kind === 'element') {
    const res = await fetchCards(standard, [target.name], { full: true });
    if (!res.available) return { status: 'unavailable' };
    const entry = res.cards?.[target.name];
    return { status: 'ready', data: entry ? { entry } : { missing: true } };
  }
  const res = await fetchAttribute(standard, target.name);
  if (!res.available) return { status: 'unavailable' };
  return { status: 'ready', data: { owners: res.owners || [] } };
}

// The cards already loaded, in memory only (a UI cache, never
// authoritative state). A card already loaded (or loading) is never asked
// for again -- Back and coming back to a card reuse it; an error is asked
// for again on the next visit or on Retry. reset() empties it and drops
// any answer still on its way (a new BRDP or project). `onChange(map)`
// gets a new Map after every change.
export function createCardStore({ standard, fetchCards, fetchAttribute, timeoutMs = SCHEMA_NAV_TIMEOUT_MS, onChange = () => {} }) {
  let cards = new Map();
  let generation = 0;
  const set = (key, value) => {
    cards = new Map(cards);
    cards.set(key, value);
    onChange(cards);
  };
  return {
    get: (target) => cards.get(targetKey(target)) || null,
    load(target, { force = false } = {}) {
      const key = targetKey(target);
      const cached = cards.get(key);
      if (!force && cached && cached.status !== 'error') return Promise.resolve(cached);
      const mine = generation;
      set(key, { status: 'loading' });
      return withTimeout(loadCard(target, standard, fetchCards, fetchAttribute), timeoutMs)
        .catch((err) => ({ status: 'error', error: err?.code === 'timeout' ? 'timeout' : err?.message || String(err) }))
        .then((result) => {
          if (mine === generation) set(key, result);
          return result;
        });
    },
    reset() {
      generation += 1;
      cards = new Map();
      onChange(cards);
    },
  };
}

// ─── "+N more" in the answers ───────────────────────────────────────────────

// The display version of an answer taken from the schema writes each cut
// list's "+N more" as this inline code; the answer renderer turns it into a
// button that expands the hidden names (utils/structuralAnswer.js's cutList).
const MORE_MARKER_RE = /^\+more:(\d+)$/;
export const moreMarker = (id) => `+more:${id}`;
export function parseMoreMarker(codeText) {
  const m = typeof codeText === 'string' ? MORE_MARKER_RE.exec(codeText.trim()) : null;
  return m ? Number(m[1]) : null;
}

// ─── Schema search ──────────────────────────────────────────────────────────

export const SCHEMA_SEARCH_MAX = 10;

// Suggestions for the schema search box, from the same vocabulary that
// decides which names are links: prefix match, case-insensitive; "@" at the
// start keeps attributes only, "<" elements only (a closing ">" is ignored).
// An exact name comes first, then alphabetical; a name that is both an
// element and an attribute gives both, element first. At most `max`.
// Returns { items: [{ kind, name }], query, noMatch } -- noMatch only when
// something was typed and nothing matched.
export function schemaSuggestions(input, vocabulary, max = SCHEMA_SEARCH_MAX) {
  let text = String(input || '').trim();
  let only = null;
  if (text.startsWith('@')) {
    only = 'attribute';
    text = text.slice(1);
  } else if (text.startsWith('<')) {
    only = 'element';
    text = text.slice(1).replace(/\/?>$/, '');
  }
  const query = text.trim().toLowerCase();
  if (!query || !vocabulary) return { items: [], query, noMatch: false };
  const found = [];
  const collect = (names, kind) => {
    for (const name of names) if (name.toLowerCase().startsWith(query)) found.push({ kind, name });
  };
  if (only !== 'attribute') collect(vocabulary.elements, 'element');
  if (only !== 'element') collect(vocabulary.attributes, 'attribute');
  found.sort((a, b) => {
    const exactA = a.name.toLowerCase() === query ? 0 : 1;
    const exactB = b.name.toLowerCase() === query ? 0 : 1;
    if (exactA !== exactB) return exactA - exactB;
    const byName = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.name.localeCompare(b.name);
    if (byName) return byName;
    return a.kind === b.kind ? 0 : a.kind === 'element' ? -1 : 1;
  });
  return { items: found.slice(0, max), query, noMatch: found.length === 0 };
}
