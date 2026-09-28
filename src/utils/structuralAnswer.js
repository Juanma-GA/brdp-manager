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
// C2, Part 3: two more kinds. "relation" -- a yes/no question about two
// elements ("¿<para> puede contener <table>?", "¿se puede usar <emphasis>
// dentro de <title>?", "can <table> appear inside <para>?"), only when both
// names exist as elements, with no wh-word and no condition ("si", "if"...);
// the answer is about the DIRECT relation, schema by schema (GET
// /api/schema-cards/relation), and says "not directly" with an example chain
// and the parent's direct children when the child is only reachable through
// other elements. "attributeOwners" -- "¿qué elementos tienen
// @emphasisType?", "which elements allow @changeMark?" -- from the attribute
// owners, grouped by schema, each list cut at 20 names with "+N more" (the
// same answer now serves "where can @x go?").
//
// Pure apart from the injected I/O (fetchCards, fetchAttribute,
// fetchRelation), so the
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

// ─── C2: relation and attribute owners ──────────────────────────────────────

// A relation question is a yes/no question: no wh-word, no condition.
const WH_WORDS = /\b(que|cual|cuales|donde|como|cuanto|cuantos|cuantas|quien|quienes|what|which|where|how|who|whom)\b/;
const CONDITION = /\b(si|cuando|siempre que|salvo|excepto|a menos que|if|when|whenever|unless|except|provided)\b/;
const EN_YES_NO_START = /^[\s"'`(]*(can|could|may|does|do|is|are)\b/;
const RELATION = {
  es: {
    contain: /\b(puede|pueden|podria|podrian)\s+(contener|llevar|tener|incluir|admitir)\b|\b(admite|admiten|contiene|contienen|acepta|aceptan|incluye|incluyen)\b/,
    verbs: /\b(puede|pueden|podria|podrian|va|van|ir|aparecer|aparece|usar|utilizar|poner|meter|permite|permitido|cabe|admite|contiene)\b/,
    strongInside: /\bdentro (de|del)\b/g,
    weakInside: /\ben\b/g,
  },
  en: {
    contain: /\b(contain|contains|include|includes|hold|holds|allow|allows|accept|accepts|take|takes|have|has)\b/,
    verbs: /\b(can|could|may|does|do|is|are)\b/,
    strongInside: /\b(inside|within|into)\b/g,
    weakInside: /\bin\b/g,
  },
};

const OWNERS_PATTERNS = {
  es: [
    /\b(que|cuales) elementos (tienen|llevan|admiten|aceptan|usan|utilizan|permiten|declaran|pueden (tener|llevar|usar))\b/,
    /\belementos (que tienen|con)\b/,
  ],
  en: [
    /\b(what|which) elements (have|take|allow|accept|use|support|declare|carry|can (have|take|use|carry))\b/,
    /\belements (with|that have|having)\b/,
  ],
};

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Index of `name` as a whole word in normalized text, or -1.
function nameIndex(text, name) {
  const m = new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRe(normalize(name))}(?![\\p{L}\\p{N}_])`, 'u').exec(text);
  return m ? m.index + m[1].length : -1;
}
const markerBetween = (re, text, from, to) => [...text.matchAll(re)].some((m) => m.index > from && m.index < to);

// { kind: 'relation', lang, parent, child } or null.
function detectRelation(question, vocabulary) {
  const text = normalize(question);
  if (NOT_STRUCTURAL.some((re) => re.test(text)) || WH_WORDS.test(text) || CONDITION.test(text)) return null;
  let lang = null;
  if (/¿/.test(question)) lang = 'es';
  else if (EN_YES_NO_START.test(text)) lang = 'en';
  else if (RELATION.es.contain.test(text) || RELATION.es.verbs.test(text)) lang = 'es';
  if (!lang) return null;
  const rel = RELATION[lang];
  const names = questionNames(question, vocabulary);
  if (names.length !== 2) return null;
  if (!names.every((n) => n.type !== 'attribute' && vocabulary.elements.has(n.name))) return null;
  const [first, second] = names
    .map((n) => ({ name: n.name, at: nameIndex(text, n.name) }))
    .sort((a, b) => a.at - b.at);
  if (first.at < 0 || second.at < 0 || first.name === second.name) return null;
  // "dentro de" / "inside" between the two names: the name after it is the
  // parent ("¿<table> puede ir dentro de <para>?"). Otherwise a containment
  // verb makes the first name the parent ("¿<para> puede contener
  // <table>?"), and last a plain "en" / "in" between them ("¿se puede usar
  // <emphasis> en <title>?").
  let parent = null;
  if (markerBetween(rel.strongInside, text, first.at, second.at)) parent = second;
  else if (rel.contain.test(text)) parent = first;
  else if (markerBetween(rel.weakInside, text, first.at, second.at)) parent = second;
  if (!parent) return null;
  const child = parent === first ? second : first;
  return { kind: 'relation', lang, parent: parent.name, child: child.name };
}

// { kind: 'attributeOwners', lang, name, usedAs: 'attribute' } or null.
function detectAttributeOwners(question, vocabulary) {
  const text = normalize(question);
  if (NOT_STRUCTURAL.some((re) => re.test(text))) return null;
  const lang = ['es', 'en'].find((l) => OWNERS_PATTERNS[l].some((re) => re.test(text)));
  if (!lang) return null;
  const names = questionNames(question, vocabulary);
  if (names.length !== 1) return null;
  const [n] = names;
  const isAttribute = n.type === 'attribute' || (n.type === null && vocabulary.attributes.has(n.name) && !vocabulary.elements.has(n.name));
  if (!isAttribute) return null;
  return { kind: 'attributeOwners', lang, name: n.name, usedAs: 'attribute', owner: null };
}

// { kind, lang, name, usedAs: 'element'|'attribute'|null, owner } or null.
export function detectStructuralQuestion(question, vocabulary) {
  if (!vocabulary || !String(question || '').trim()) return null;
  const relation = detectRelation(question, vocabulary);
  if (relation) return relation;
  const owners = detectAttributeOwners(question, vocabulary);
  if (owners) return owners;
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
    more: (n) => `+${n} más`,
    relYesAll: (p, c, n) =>
      n > 1
        ? `Sí: ${el(p)} puede contener ${el(c)} como hijo directo en todos los esquemas en los que existe ${el(p)} (${n}).`
        : `Sí: ${el(p)} puede contener ${el(c)} como hijo directo.`,
    relMixed: (p, c, yes, total) => `Sí, en ${yes.length} de los ${total} esquemas en los que existe ${el(p)}: ${yes.join(', ')}.`,
    relMixedNo: (p, c, no) => `No en: ${no.join(', ')}. Ahí ${el(c)} no es un hijo directo de ${el(p)}.`,
    relMixedNoPath: (path) => ` Solo puede llegar a través de otros elementos, por ejemplo ${path}.`,
    relIndirect: (p, c, path) =>
      `No directamente: ${el(c)} no es un hijo directo de ${el(p)} en ningún esquema; solo puede llegar a través de otros elementos, por ejemplo ${path}. Los hijos directos de ${el(p)} son estos:`,
    relNever: (p, c) => `No, en ningún esquema del proyecto: ${el(p)} no puede contener ${el(c)}, ni directamente ni a través de otros elementos.`,
    ownersNone: (name) => `${at(name)} no existe en ningún esquema del proyecto.`,
    ownersSame: (name, n, schemas) =>
      `${at(name)} se usa en ${n === 1 ? 'un elemento' : `${n} elementos`}${schemas > 1 ? `, igual en los ${schemas} esquemas en los que aparece` : ''}: `,
    ownersBySchema: (name, n, schemas) => `${at(name)} se usa en ${n} elementos; cuáles depende del esquema (aparece en ${schemas} esquemas).`,
    ownersCommon: 'En todos esos esquemas: ',
    ownersAdditional: (schemas) => `Además, en ${schemas}: `,
    ownersNoCommon: 'Ningún elemento lo tiene en todos los esquemas:',
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
    more: (n) => `+${n} more`,
    relYesAll: (p, c, n) =>
      n > 1
        ? `Yes: ${el(p)} can contain ${el(c)} as a direct child in every schema where ${el(p)} exists (${n}).`
        : `Yes: ${el(p)} can contain ${el(c)} as a direct child.`,
    relMixed: (p, c, yes, total) => `Yes, in ${yes.length} of the ${total} schemas where ${el(p)} exists: ${yes.join(', ')}.`,
    relMixedNo: (p, c, no) => `Not in: ${no.join(', ')}. There ${el(c)} is not a direct child of ${el(p)}.`,
    relMixedNoPath: (path) => ` It can only be reached through other elements, for example ${path}.`,
    relIndirect: (p, c, path) =>
      `Not directly: ${el(c)} is not a direct child of ${el(p)} in any schema; it can only be reached through other elements, for example ${path}. These are the direct children of ${el(p)}:`,
    relNever: (p, c) => `No, in no schema of the project: ${el(p)} cannot contain ${el(c)}, neither directly nor through other elements.`,
    ownersNone: (name) => `${at(name)} does not exist in any schema of the project.`,
    ownersSame: (name, n, schemas) =>
      `${at(name)} is used on ${n === 1 ? 'one element' : `${n} elements`}${schemas > 1 ? `, the same in the ${schemas} schemas where it appears` : ''}: `,
    ownersBySchema: (name, n, schemas) => `${at(name)} is used on ${n} elements; which ones depends on the schema (it appears in ${schemas} schemas).`,
    ownersCommon: 'In all those schemas: ',
    ownersAdditional: (schemas) => `Also, in ${schemas}: `,
    ownersNoCommon: 'No element has it in every schema:',
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

// ─── C2 answers ─────────────────────────────────────────────────────────────

// Imported helper schemas, never a document type (as the backend's
// _NON_DOCUMENT_SCHEMAS).
const NON_DOCUMENT_SCHEMAS = new Set(['dc', 'rdf', 'xlink', 'xcf']);
const OWNERS_LIST_MAX = 20;

// A list cut at `max` names with "+N more".
function cutList(names, fmt, t, max = OWNERS_LIST_MAX) {
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  if (sorted.length <= max) return joinNames(sorted, fmt);
  return `${joinNames(sorted.slice(0, max), fmt)} ${t.more(sorted.length - max)}`;
}

const chain = (path) => path.map(el).join(' → ');
const shortestPath = (entries) =>
  entries
    .map((e) => e.path)
    .filter(Boolean)
    .sort((a, b) => a.length - b.length || a.join('/').localeCompare(b.join('/')))[0] || null;

function relationAnswer(detection, relation, parentCard, t) {
  const { parent, child } = detection;
  const entries = relation.schemas || [];
  const yes = entries.filter((e) => e.direct).map((e) => e.schema_name);
  const no = entries.filter((e) => !e.direct);
  // No document schema defines the parent: nothing to answer from.
  if (!entries.length) return null;
  if (no.length === 0) return t.relYesAll(parent, child, entries.length);
  if (yes.length) {
    const path = shortestPath(no);
    return [
      t.relMixed(parent, child, yes, entries.length),
      t.relMixedNo(parent, child, no.map((e) => e.schema_name)) + (path ? t.relMixedNoPath(chain(path)) : ''),
    ].join('\n\n');
  }
  const path = shortestPath(no);
  if (!path) return t.relNever(parent, child);
  const lines = [t.relIndirect(parent, child, chain(path))];
  if (parentCard) lines.push(childrenAnswer(parent, parentCard, t));
  return lines.join('\n\n');
}

function ownersAnswer(name, owners, t) {
  if (!owners.length) return t.ownersNone(name);
  const bySchema = new Map();
  for (const o of owners) {
    const schemas = o.schemas.filter((s) => !NON_DOCUMENT_SCHEMAS.has(s));
    for (const schema of schemas.length ? schemas : o.schemas) {
      if (!bySchema.has(schema)) bySchema.set(schema, new Set());
      bySchema.get(schema).add(o.element);
    }
  }
  const elements = [...new Set(owners.map((o) => o.element))];
  // Schemas with the same set of elements are one group.
  const groups = new Map();
  for (const [schema, set] of [...bySchema].sort((a, b) => a[0].localeCompare(b[0]))) {
    const key = [...set].sort().join('|');
    if (!groups.has(key)) groups.set(key, { elements: [...set], schemas: [] });
    groups.get(key).schemas.push(schema);
  }
  const list = [...groups.values()];
  if (list.length <= 1) return t.ownersSame(name, elements.length, bySchema.size) + cutList(elements, el, t);
  const common = elements.filter((e) => [...bySchema.values()].every((set) => set.has(e)));
  const lines = [t.ownersBySchema(name, elements.length, bySchema.size)];
  if (common.length) {
    lines.push(t.ownersCommon + cutList(common, el, t));
    const extra = list
      .map((g) => ({ ...g, diff: g.elements.filter((e) => !common.includes(e)) }))
      .filter((g) => g.diff.length)
      .map((g) => `- ${t.ownersAdditional(g.schemas.join(', '))}${cutList(g.diff, el, t)}`);
    if (extra.length) lines.push(extra.join('\n'));
  } else {
    lines.push(t.ownersNoCommon, list.map((g) => `- **${g.schemas.join(', ')}**: ${cutList(g.elements, el, t)}`).join('\n'));
  }
  return lines.join('\n\n');
}

// Markdown answer for a detection, or null when the data needed is missing
// (standard without cards). `data` = { card } for element kinds (the full
// card entry, or null when the name is not an element) and { owners } for
// values/attribute parents.
export function buildStructuralAnswer(detection, data, { standard, vocabulary }) {
  const t = T[detection.lang];
  const { kind, name, usedAs } = detection;
  if (kind === 'relation') return data.relation ? relationAnswer(detection, data.relation, data.card || null, t) : null;
  if (kind === 'attributeOwners') {
    if (!vocabulary.attributes.has(name)) return vocabulary.elements.has(name) ? t.elementNotAttribute(name) : t.ownersNone(name);
    return ownersAnswer(name, data.owners || [], t);
  }
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
    return ownersAnswer(name, data.owners || [], t);
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
  if (kind === 'values' || kind === 'attributeOwners') return true;
  return kind === 'parents' && (usedAs === 'attribute' || (usedAs === null && !vocabulary.elements.has(name)));
}

// The whole step, as Ask runs it: null when the question is not structural
// (it goes to the LLM), else { detection, text }. `fetchCards(standard,
// names, { full })` → GET /api/schema-cards; `fetchAttribute(standard, name)`
// → GET /api/schema-cards/attribute; `fetchRelation(standard, parent,
// child)` → GET /api/schema-cards/relation. Fetch errors propagate: an answer
// presented as "from the schema" must never be a guess (HR7).
export async function answerStructuralQuestion({ question, standard, vocabulary, fetchCards, fetchAttribute, fetchRelation }) {
  const detection = detectStructuralQuestion(question, vocabulary);
  if (!detection) return null;
  if (detection.kind === 'relation') {
    const relation = await fetchRelation(standard, detection.parent, detection.child);
    if (!relation.available) return null;
    const data = { relation };
    // "Not directly": the answer lists the parent's direct children.
    if (!(relation.schemas || []).some((e) => e.direct) && (relation.schemas || []).some((e) => e.path)) {
      const res = await fetchCards(standard, [detection.parent], { full: true });
      if (res.available) data.card = res.cards[detection.parent] || null;
    }
    const text = buildStructuralAnswer(detection, data, { standard, vocabulary });
    return text ? { detection, text } : null;
  }
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
