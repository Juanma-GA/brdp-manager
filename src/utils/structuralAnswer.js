// Consolidation C1, Part 2: Ask answers structural questions from the
// schema cards, without the LLM. In the 007a9b1 run, "What can
// <identAndStatusSection> contain?" came back 2/3 -- all three answers
// listed its PARENTS (comment, ddn, dmodule, ...) as its children, although
// the card they received was right. These questions have an exact answer in
// the cards, so the application gives it.
//
// Detection is deterministic: normalized text (lowercase, no accents)
// against Spanish and English patterns for four kinds -- children, parents,
// attributes and attribute values -- and exactly ONE schema name in the
// question (for values, one attribute and at most one element that owns
// it). A name is `<x>`, `@x`, a half-typed `<x`/`x>`, a camelCase name, a
// word after "elemento/atributo/element/attribute", or -- only when none of
// those is present -- a bare word that exists in the vocabulary and is the
// only word of the question that is not an ordinary word (STOPWORDS: "para", "and", "to", "values"... are
// real S1000D/DITA names but, in a question, just words). Any other question
// (meaning, decisions, comparisons, "why", several names, no name, no known
// pattern) goes to the LLM as before.
//
// The answer is Markdown in the language of the pattern that matched, built
// from the complete card (GET /api/schema-cards?full=true: no list cut) or,
// for values, from GET /api/schema-cards/attribute (every element that
// declares the attribute). It keeps the card's own structure -- common to
// every schema, "depends on the schema" by groups, or none -- and long lists
// are shown complete, grouped by initial letter.
//
// Pure apart from the injected I/O (fetchCards, fetchAttribute), so the
// panel (hooks/useAskAssistant.js) and the eval harness
// (scripts/run-prompt-eval.mjs) run the same code.
import { extractContextCandidates, resolvePhraseCandidates } from '../validation/schemaValidation.js';
import { summarizeSchemaFactEntry } from './schemaFactSummary.js';

const normalize = (text) =>
  String(text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

// The four kinds; a question must match exactly one (see detectKind).
const PATTERNS = [
  {
    kind: 'values',
    es: [/\bque valores\b/, /\bcuales son los valores\b/, /\bvalores (posibles|permitidos|admitidos|validos)\b/, /\bvalores (de|del|para)\b/],
    en: [/\b(what|which) values\b/, /\b(allowed|possible|valid|permitted) values\b/, /\bvalues (of|for)\b/],
  },
  {
    kind: 'attributes',
    es: [/\bque atributos\b/, /\bcuales son los atributos\b/, /\batributos (de|del|tiene|admite|lleva|puede tener)\b/],
    en: [/\b(what|which) attributes\b/, /\battributes (of|for|does|do|can)\b/],
  },
  {
    kind: 'parents',
    es: [/\bdonde (se )?(puede|pueden|va|van|se usa|se usan|se utiliza|aparece|aparecen)\b/, /\bdentro de (que|cuales)\b/, /\ben que elementos\b/, /\bpadres? (de|del)\b/],
    en: [
      /\bwhere (can|could|may|does|do|is|are|should)\b/,
      /\b(what|which)( elements?)? (can|could|may) contain\b/,
      /\ballowed inside\s*(\?|$|what|which)/,
      /\b(inside|within) (what|which)\b/,
      /\bparents? (elements? )?of\b/,
    ],
  },
  {
    kind: 'children',
    es: [
      /\bque (puede|pueden|podria) (contener|llevar|tener dentro)\b/,
      /\bque (contiene|lleva dentro)\b/,
      /\bque hijos\b/,
      /\bcuales son (sus|los) hijos\b/,
      /\bhijos (de|del|tiene|admite|puede)\b/,
      /\bque (elementos|etiquetas) (puede|pueden|admite) (contener|ir dentro|llevar)\b/,
      /\bque (puede ir|va|van) dentro (de|del)\b/,
    ],
    en: [
      /\bwhat (can|could|may|does|do)\b.*\bcontain\b/,
      /\bchild(ren| elements?)? (of|does|do|can)\b/,
      /\b(what|which) are (its|the) child(ren| elements)\b/,
      /\bwhat (can|could|may) go inside\b/,
      /\bwhat goes inside\b/,
      /\bwhat is allowed inside\b/,
    ],
  },
];

// Questions about reasons or advice always go to the LLM.
const NOT_STRUCTURAL = [/\bpor que\b/, /\bpara que sirve\b/, /\bdeberia\b/, /\brecomiend/, /\bwhy\b/, /\bshould\b/, /\brecommend/];

// Real schema names that, in a question, are ordinary words.
const STOPWORDS = new Set(
  (
    'a an and are be can could do does for from go goes have has i in inside is it its may not of on or should the this that to ' +
    'what where which within value values attribute attributes element elements child children parent parents allowed contain contains used ' +
    'admit admits allow allows appear appears take takes possible valid permitted list show tell me please ' +
    'al con cual cuales de del donde el ella en es esta este hijos hijo la las lo los o padre padres para por puede pueden que se sin su ' +
    'tiene un una uno y valor valores atributo atributos elemento elementos etiqueta etiquetas va van ir admite contener contiene dentro ' +
    'aparecer aparece aparecen tener llevar lleva permitidos posibles admitidos validos cuales sus usa usan utiliza'
  ).split(' ')
);

const NAME_TOKEN_RE = /[\p{L}_][\p{L}\p{N}_.-]*/gu;

// "what (elements) can contain <x>" also looks like a children question
// ("what can … contain"); it is the parents one.
const PARENTS_CONTAIN_RE = /\b(what|which)( elements?)? (can|could|may) contain\b/;

// The kind of the question, or null. A question that asks for two kinds at
// once ("which attributes does <table> allow, and what are its children?")
// is not answered by half: it goes to the LLM, which gets the whole card.
function detectKind(question) {
  const text = normalize(question);
  if (NOT_STRUCTURAL.some((re) => re.test(text))) return null;
  const matched = [];
  for (const { kind, es, en } of PATTERNS) {
    if (es.some((re) => re.test(text))) matched.push({ kind, lang: 'es' });
    else if (en.some((re) => re.test(text))) matched.push({ kind, lang: 'en' });
  }
  const kinds = matched.filter((m) => !(m.kind === 'children' && PARENTS_CONTAIN_RE.test(text) && matched.some((o) => o.kind === 'parents')));
  return kinds.length === 1 ? kinds[0] : null;
}

// The schema names the question mentions: [{ name, type }] where type is
// 'element', 'attribute' or null (camelCase or bare word: decided below).
function questionNames(question, vocabulary) {
  const { elements, attributes, camelCase, phraseCandidates } = extractContextCandidates(question);
  const found = new Map();
  const add = (name, type) => {
    if (!found.has(name)) found.set(name, { name, type });
  };
  for (const n of elements) add(n, 'element');
  for (const n of attributes) add(n, 'attribute');
  for (const n of camelCase) add(n, null);
  for (const r of resolvePhraseCandidates(phraseCandidates, vocabulary)) add(r.name, r.type);
  if (found.size > 0) return [...found.values()];
  // No explicit name: a bare word counts only when it is the ONLY word of
  // the question that is not an ordinary word of the patterns ("Where can
  // table go?"). "Where do the identification data go?" names nothing:
  // "data" is a real S1000D element, but here it is just a word.
  const content = [];
  for (const raw of String(question).match(NAME_TOKEN_RE) || []) {
    const token = raw.replace(/[.-]+$/, '');
    if (token.length < 2 || STOPWORDS.has(normalize(token))) continue;
    content.push(token);
  }
  if (content.length !== 1) return [];
  const [token] = content;
  for (const candidate of [token, token.toLowerCase()]) {
    if (vocabulary.elements.has(candidate) || vocabulary.attributes.has(candidate)) return [{ name: candidate, type: null }];
  }
  return [];
}

// { kind, lang, name, usedAs: 'element'|'attribute'|null, owner } or null.
export function detectStructuralQuestion(question, vocabulary) {
  if (!vocabulary || !String(question || '').trim()) return null;
  const detected = detectKind(question);
  if (!detected) return null;
  const names = questionNames(question, vocabulary);
  if (detected.kind === 'values') {
    // One attribute, and at most one element that owns it.
    const attrs = names.filter((n) => n.type === 'attribute' || (n.type === null && vocabulary.attributes.has(n.name)));
    const others = names.filter((n) => !attrs.includes(n));
    if (attrs.length === 1 && others.length <= 1 && (others.length === 0 || others[0].type !== 'attribute')) {
      return { ...detected, name: attrs[0].name, usedAs: 'attribute', owner: others[0]?.name ?? null };
    }
    if (names.length === 1) return { ...detected, name: names[0].name, usedAs: names[0].type, owner: null };
    return null;
  }
  if (names.length !== 1) return null;
  return { ...detected, name: names[0].name, usedAs: names[0].type, owner: null };
}

// ─── Answer texts ────────────────────────────────────────────────────────────

const el = (name) => `\`<${name}>\``;
const at = (name) => `\`@${name}\``;
const joinNames = (names, fmt) => names.map(fmt).join(', ');

// A list shown complete; above 20 names, grouped by initial letter.
function nameList(names, fmt) {
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  if (sorted.length <= 20) return joinNames(sorted, fmt);
  const groups = new Map();
  for (const n of sorted) {
    const letter = n[0].toUpperCase();
    if (!groups.has(letter)) groups.set(letter, []);
    groups.get(letter).push(n);
  }
  return '\n' + [...groups].map(([letter, list]) => `  - **${letter}**: ${joinNames(list, fmt)}`).join('\n');
}

const T = {
  es: {
    notExist: (display, std) => `${display} no existe en el esquema ${std}.`,
    elementNotAttribute: (name) => `**${name}** es un elemento, no un atributo (${el(name)}).`,
    attributeNotElement: (name) => `**${name}** es un atributo, no un elemento (${at(name)}).`,
    definedIn: (name, n) => `${el(name)} está definido en ${n} esquemas.`,
    children: (name, n) => `${el(name)} puede contener ${n === 1 ? 'un elemento hijo' : `${n} elementos hijos`}: `,
    noChildren: (name) => `${el(name)} no admite elementos hijos.`,
    noChildrenAnySchema: (name) => `${el(name)} no admite elementos hijos en ningún esquema.`,
    childrenCommon: 'En todos los esquemas puede contener: ',
    childrenAdditional: (schemas) => `Además, en ${schemas}: `,
    childrenBySchema: 'Sus hijos dependen del esquema (ninguno es común a todos):',
    none: 'ninguno',
    parents: (name, n) => `${el(name)} puede ir dentro de ${n === 1 ? 'un elemento' : `${n} elementos`}: `,
    root: (name) => `${el(name)} no va dentro de ningún otro elemento: es un elemento raíz.`,
    attrOwners: (name, n) => `${at(name)} se usa en ${n === 1 ? 'un elemento' : `${n} elementos`}: `,
    attributes: (name, n) => `${el(name)} admite ${n === 1 ? 'un atributo' : `${n} atributos`}:`,
    noAttributes: (name) => `${el(name)} no admite atributos.`,
    noAttributesAnySchema: (name) => `${el(name)} no admite atributos en ningún esquema.`,
    attributesCommon: 'En todos los esquemas:',
    attributesAdditional: (schemas) => `Además, en ${schemas}:`,
    attributesBySchema: 'Sus atributos dependen del esquema (ninguno es común a todos):',
    required: 'obligatorio',
    valuesLabel: 'valores',
    valuesAll: (name, values, owners) => `${at(name)} admite estos valores: ${values} (en ${owners}).`,
    valuesFree: (name, std, owners) => `El esquema ${std} no fija una lista cerrada de valores para ${at(name)} (en ${owners}).`,
    valuesMixed: (name) => `Los valores de ${at(name)} dependen del elemento:`,
    valuesFreeShort: 'sin lista cerrada de valores',
    inPrefix: (owners) => `en ${owners}: `,
    notOnOwner: (attr, owner) => `${el(owner)} no tiene el atributo ${at(attr)}.`,
  },
  en: {
    notExist: (display, std) => `${display} does not exist in the ${std} schema.`,
    elementNotAttribute: (name) => `**${name}** is an element, not an attribute (${el(name)}).`,
    attributeNotElement: (name) => `**${name}** is an attribute, not an element (${at(name)}).`,
    definedIn: (name, n) => `${el(name)} is defined in ${n} schemas.`,
    children: (name, n) => `${el(name)} can contain ${n === 1 ? 'one child element' : `${n} child elements`}: `,
    noChildren: (name) => `${el(name)} has no child elements.`,
    noChildrenAnySchema: (name) => `${el(name)} has no child elements in any schema.`,
    childrenCommon: 'In every schema it can contain: ',
    childrenAdditional: (schemas) => `Also, in ${schemas}: `,
    childrenBySchema: 'Its children depend on the schema (none is common to all):',
    none: 'none',
    parents: (name, n) => `${el(name)} can go inside ${n === 1 ? 'one element' : `${n} elements`}: `,
    root: (name) => `${el(name)} does not go inside any other element: it is a root element.`,
    attrOwners: (name, n) => `${at(name)} is used on ${n === 1 ? 'one element' : `${n} elements`}: `,
    attributes: (name, n) => `${el(name)} takes ${n === 1 ? 'one attribute' : `${n} attributes`}:`,
    noAttributes: (name) => `${el(name)} takes no attributes.`,
    noAttributesAnySchema: (name) => `${el(name)} takes no attributes in any schema.`,
    attributesCommon: 'In every schema:',
    attributesAdditional: (schemas) => `Also, in ${schemas}:`,
    attributesBySchema: 'Its attributes depend on the schema (none is common to all):',
    required: 'required',
    valuesLabel: 'values',
    valuesAll: (name, values, owners) => `${at(name)} takes these values: ${values} (on ${owners}).`,
    valuesFree: (name, std, owners) => `The ${std} schema does not fix a closed list of values for ${at(name)} (on ${owners}).`,
    valuesMixed: (name) => `The values of ${at(name)} depend on the element:`,
    valuesFreeShort: 'no closed list of values',
    inPrefix: (owners) => `on ${owners}: `,
    notOnOwner: (attr, owner) => `${el(owner)} has no ${at(attr)} attribute.`,
  },
};

const attributeLine = (a, t) => {
  const parts = [at(a.name)];
  if (a.required) parts.push(`(${t.required})`);
  let line = parts.join(' ');
  if (a.enum && a.enum.length) line += ` — ${t.valuesLabel}: ${a.enum.join(', ')}`;
  return `- ${line}`;
};

function childrenAnswer(name, entry, t) {
  const summary = summarizeSchemaFactEntry(entry);
  if (!summary.common) {
    const children = summary.variants[0]?.children || [];
    return children.length ? t.children(name, children.length) + nameList(children, el) : t.noChildren(name);
  }
  const lines = [t.definedIn(name, summary.schemaCount)];
  if (summary.childrenMode === 'none') return [...lines, t.noChildrenAnySchema(name)].join('\n\n');
  if (summary.childrenMode === 'common') {
    lines.push(t.childrenCommon + nameList(summary.common.children, el));
    const extra = summary.perVariant
      .filter((v) => v.diffChildren.length)
      .map((v) => `- ${t.childrenAdditional(v.schemas.join(', '))}${nameList(v.diffChildren, el)}`);
    if (extra.length) lines.push(extra.join('\n'));
    return lines.join('\n\n');
  }
  lines.push(t.childrenBySchema);
  lines.push(
    summary.perVariant
      .map((v) => `- **${v.schemas.join(', ')}**: ${v.diffChildren.length ? nameList(v.diffChildren, el) : t.none}`)
      .join('\n')
  );
  return lines.join('\n\n');
}

function attributesAnswer(name, entry, t) {
  const summary = summarizeSchemaFactEntry(entry);
  if (!summary.common) {
    const attrs = summary.variants[0]?.attributes || [];
    return attrs.length ? [t.attributes(name, attrs.length), attrs.map((a) => attributeLine(a, t)).join('\n')].join('\n\n') : t.noAttributes(name);
  }
  const lines = [t.definedIn(name, summary.schemaCount)];
  if (summary.attributesMode === 'none') return [...lines, t.noAttributesAnySchema(name)].join('\n\n');
  if (summary.attributesMode === 'common') {
    lines.push(t.attributesCommon, summary.common.attributes.map((a) => attributeLine(a, t)).join('\n'));
    for (const v of summary.perVariant) {
      if (v.diffAttributes.length) {
        lines.push(t.attributesAdditional(v.schemas.join(', ')), v.diffAttributes.map((a) => attributeLine(a, t)).join('\n'));
      }
    }
    return lines.join('\n\n');
  }
  lines.push(t.attributesBySchema);
  for (const v of summary.perVariant) {
    lines.push(`**${v.schemas.join(', ')}**`, v.diffAttributes.length ? v.diffAttributes.map((a) => attributeLine(a, t)).join('\n') : `- ${t.none}`);
  }
  return lines.join('\n\n');
}

function valuesAnswer(name, owners, standard, ownerFilter, t) {
  const relevant = ownerFilter ? owners.filter((o) => o.element === ownerFilter) : owners;
  if (ownerFilter && relevant.length === 0) return t.notOnOwner(name, ownerFilter);
  // Group elements by their value list (the same element can appear once
  // per schema variant; identical lists merge).
  const groups = new Map();
  for (const o of relevant) {
    const key = JSON.stringify(o.enum || null);
    if (!groups.has(key)) groups.set(key, { enum: o.enum, elements: new Set() });
    groups.get(key).elements.add(o.element);
  }
  const list = [...groups.values()];
  const ownersOf = (g) => nameList([...g.elements], el);
  if (list.length === 1) {
    const [g] = list;
    return g.enum ? t.valuesAll(name, g.enum.join(', '), ownersOf(g)) : t.valuesFree(name, standard, ownersOf(g));
  }
  return [
    t.valuesMixed(name),
    list.map((g) => `- ${t.inPrefix(ownersOf(g))}${g.enum ? g.enum.join(', ') : t.valuesFreeShort}`).join('\n'),
  ].join('\n\n');
}

// Markdown answer for a detection, or null when the data needed is missing
// (standard without cards). `data` = { card } for element kinds (the full
// card entry, or null when the name is not an element) and { owners } for
// values/attribute parents.
export function buildStructuralAnswer(detection, data, { standard, vocabulary }) {
  const t = T[detection.lang];
  const { kind, name, usedAs } = detection;
  const isElement = vocabulary.elements.has(name);
  const isAttribute = vocabulary.attributes.has(name);
  const wantsAttribute = kind === 'values';
  // Parents of an attribute: the elements that declare it.
  const attributeParents = kind === 'parents' && (usedAs === 'attribute' || (usedAs === null && !isElement && isAttribute));

  if (!isElement && !isAttribute) {
    const display = usedAs === 'attribute' ? at(name) : usedAs === 'element' ? el(name) : `\`${name}\``;
    return t.notExist(display, standard);
  }
  if (attributeParents) {
    if (!isAttribute) return t.elementNotAttribute(name);
    const elements = [...new Set((data.owners || []).map((o) => o.element))];
    return t.attrOwners(name, elements.length) + nameList(elements, el);
  }
  if (wantsAttribute || usedAs === 'attribute') {
    if (!isAttribute) return t.elementNotAttribute(name);
    if (!wantsAttribute) return t.attributeNotElement(name);
    return valuesAnswer(name, data.owners || [], standard, detection.owner, t);
  }
  if (!isElement) return t.attributeNotElement(name);
  const card = data.card;
  if (!card) return null;
  if (kind === 'children') return childrenAnswer(name, card, t);
  if (kind === 'attributes') return attributesAnswer(name, card, t);
  const parents = card.parents || [];
  return parents.length ? t.parents(name, parents.length) + nameList(parents, el) : t.root(name);
}

// What the answer needs from the backend: the full card, or the owners of
// an attribute.
function needsOwners(detection, vocabulary) {
  const { kind, name, usedAs } = detection;
  if (kind === 'values') return true;
  return kind === 'parents' && (usedAs === 'attribute' || (usedAs === null && !vocabulary.elements.has(name)));
}

// The whole step, as Ask runs it: null when the question is not structural
// (it goes to the LLM), else { detection, text }. `fetchCards(standard,
// names, { full })` → GET /api/schema-cards; `fetchAttribute(standard, name)`
// → GET /api/schema-cards/attribute. Fetch errors propagate: an answer
// presented as "from the schema" must never be a guess (HR7).
export async function answerStructuralQuestion({ question, standard, vocabulary, fetchCards, fetchAttribute }) {
  const detection = detectStructuralQuestion(question, vocabulary);
  if (!detection) return null;
  const exists = vocabulary.elements.has(detection.name) || vocabulary.attributes.has(detection.name);
  const data = {};
  if (exists) {
    if (needsOwners(detection, vocabulary)) {
      if (vocabulary.attributes.has(detection.name)) {
        const res = await fetchAttribute(standard, detection.name);
        if (!res.available) return null;
        data.owners = res.owners;
      }
    } else if (vocabulary.elements.has(detection.name)) {
      const res = await fetchCards(standard, [detection.name], { full: true });
      if (!res.available) return null;
      data.card = res.cards[detection.name] || null;
    }
  }
  const text = buildStructuralAnswer(detection, data, { standard, vocabulary });
  return text ? { detection, text } : null;
}
