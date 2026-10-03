// Pure helpers for the prompt-eval checks that need more than a regex
// (C2b, adjustments before the reference pass). Kept apart from
// run-prompt-eval.mjs -- which logs in and runs on import -- so
// scripts/test-prompt-eval-checks.mjs can test them against saved answers.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UNFILLED_MARKER_RE } from "../../src/utils/proposalMarkers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

// ---- ignorePlaceholders --------------------------------------------------

const PLACEHOLDER_GLOBAL_RE = new RegExp(UNFILLED_MARKER_RE.source, "gu");

// Empties every placeholder "[…]" -- same definition as the app's Suggest
// Rule prerequisite (UNFILLED_MARKER_RE) -- keeping the brackets, so a value
// from another project offered as an example INSIDE a placeholder never
// counts as copied, while the same value outside one still does.
export function stripPlaceholders(text) {
  return String(text ?? "").replace(PLACEHOLDER_GLOBAL_RE, "[]");
}

// ---- language ---------------------------------------------------------------

// Heuristic, word-list based: counts frequent Spanish and English words.
const ES_WORDS = new Set([
  "el", "la", "los", "las", "de", "del", "que", "para", "con", "una", "uno",
  "por", "este", "esta", "estos", "estas", "es", "son", "debe", "deben",
  "se", "como", "sus", "más", "pero", "porque", "cuando", "sin", "entre",
  "sobre", "así", "un", "también", "ya", "muy", "puede", "pueden",
]);
const EN_WORDS = new Set([
  "the", "is", "and", "of", "to", "for", "with", "this", "that", "are",
  "shall", "must", "be", "as", "it", "on", "in", "not", "if", "when",
  "without", "between", "about", "so", "a", "an", "its", "can", "should",
]);
// Below this many words a text may have no frequent word at all ("Data
// module title"): "unknown" is then not a failure -- only detecting the
// other language is.
export const LANGUAGE_MIN_WORDS = 8;

export function detectLanguage(text) {
  const words = String(text ?? "").toLowerCase().match(/[a-zà-ÿñ]+/gi) || [];
  let es = 0;
  let en = 0;
  for (const w of words) {
    if (ES_WORDS.has(w)) es++;
    if (EN_WORDS.has(w)) en++;
  }
  if (es === 0 && en === 0) return "unknown";
  return es > en ? "es" : "en";
}

export function languageCheck(text, expect) {
  const detected = detectLanguage(text);
  const words = String(text ?? "").trim().split(/\s+/).filter(Boolean).length;
  if (detected === "unknown" && words < LANGUAGE_MIN_WORDS) {
    return { status: "pass", detail: `expected ${expect}, too short to tell (${words} words, under ${LANGUAGE_MIN_WORDS}): not another language` };
  }
  return { status: detected === expect ? "pass" : "fail", detail: `expected ${expect}, detected ${detected} (heuristic, word-list based)` };
}

// ---- Schema names in any form --------------------------------------------

const CAMEL_CASE_RE = /^[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*$/;

// Name written as <x>, </x>, <x attr="…">, <x/> -- counted whether or not it
// is in the vocabulary (an invented name dumped in a list is still a name).
const TAG_RE = /<\/?([\p{L}_][\p{L}\p{N}_.:-]*)(?:\s[^<>]*)?\/?>/gu;
// Contents of *x*, **x**, _x_, __x__ and `x` spans.
const EMPHASIS_RE = /(\*\*|__|\*|_|`)([^*_`\n]{1,80}?)\1/gu;
const AT_RE = /(?<![\p{L}\p{N}_])@([\p{L}_][\p{L}\p{N}_.-]*)/gu;
const WORD_RE = /[\p{L}_][\p{L}\p{N}_-]*/gu;

function vocabName(raw, vocabulary) {
  const s = raw.trim();
  let m = /^<\/?([\p{L}_][\p{L}\p{N}_.:-]*)[^<>]*>$/u.exec(s);
  if (m) return { name: m[1], kind: "element" };
  m = /^@([\p{L}_][\p{L}\p{N}_.-]*)$/u.exec(s);
  if (m) return vocabulary?.attributes.has(m[1]) ? { name: m[1], kind: "attribute" } : null;
  if (!/^[\p{L}_][\p{L}\p{N}_.-]*$/u.test(s)) return null;
  if (vocabulary?.elements.has(s)) return { name: s, kind: "element" };
  if (vocabulary?.attributes.has(s)) return { name: s, kind: "attribute" };
  return null;
}

// Every schema name the text mentions, with its position: <x> always;
// *x* / **x** / _x_ / `x` (bare, <x> or @x inside) and @x when x is in the
// standard's vocabulary; a bare word only when it is camelCase AND in the
// vocabulary ("para", "title" in running text are ordinary words).
export function schemaNameMentions(text, vocabulary) {
  const src = String(text ?? "");
  const out = [];
  const taken = [];
  const push = (index, length, hit) => {
    if (!hit) return;
    if (taken.some(([a, b]) => index < b && index + length > a)) return;
    taken.push([index, index + length]);
    out.push({ ...hit, index, length });
  };
  for (const m of src.matchAll(EMPHASIS_RE)) push(m.index, m[0].length, vocabName(m[2], vocabulary));
  for (const m of src.matchAll(TAG_RE)) push(m.index, m[0].length, { name: m[1], kind: "element" });
  for (const m of src.matchAll(AT_RE)) push(m.index, m[0].length, vocabName(m[0], vocabulary));
  for (const m of src.matchAll(WORD_RE)) {
    if (!CAMEL_CASE_RE.test(m[0])) continue;
    push(m.index, m[0].length, vocabName(m[0], vocabulary));
  }
  return out.sort((a, b) => a.index - b.index);
}

const display = ({ name, kind }) => (kind === "attribute" ? `@${name}` : `<${name}>`);

// Distinct names (the same name several times, in any form, counts once).
export function distinctSchemaNames(text, vocabulary) {
  const seen = new Map();
  for (const m of schemaNameMentions(text, vocabulary)) {
    const key = `${m.kind}:${m.name}`;
    if (!seen.has(key)) seen.set(key, display(m));
  }
  return [...seen.values()];
}

// ---- no_parent_as_child ---------------------------------------------------

// Mirrors backend/app/services/schema_cards.py's STANDARD_TO_SCHEMA_CARDS_FILE.
export const STANDARD_TO_SCHEMA_CARDS_FILE = {
  "DITA 1.3 Xpath2.0": "schema-cards-dita.json",
  "DITA 1.3 Xpath3.0": "schema-cards-dita.json",
  "S1000D 3.0.1": "schema-cards-3-0-1.json",
  "S1000D 4.1": "schema-cards-4-1.json",
  "S1000D 4.2": "schema-cards-4-2.json",
};

const _cardsCache = new Map();

export function loadSchemaCards(standard) {
  const file = STANDARD_TO_SCHEMA_CARDS_FILE[standard];
  if (!file) return null;
  if (!_cardsCache.has(file)) {
    const p = path.join(REPO_ROOT, "backend", "schema_cards", file);
    _cardsCache.set(file, fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null);
  }
  return _cardsCache.get(file);
}

// Children of `element` in ANY variant of its card, and its parents.
export function elementRelations(cards, element) {
  const variants = cards?.cards?.[element];
  if (!variants) return null;
  const children = new Set();
  for (const v of variants) for (const c of v.children || []) children.add(c);
  return { children, parents: new Set(cards.parents?.[element] || []) };
}

// Splits the answer into units: sentences within a line, and a line ending
// with ":" keeps the list lines under it (a "- <x>" bullet list of children
// stays with the sentence that introduces it) -- such a unit also carries its
// `header` (the line with ":") and its `items` (the bullet lines).
// Abbreviations ("ej.", "p. ej.", "e.g.", "i.e.", "etc.", "vs.") never end a
// sentence: a real answer wrote "(ej. *dmRef*, *acronym*). También admite …",
// and cutting at "ej." lost the subject of "También admite".
const ABBREVIATION_RE = /\b(p\.\s?ej|ej|e\.g|i\.e|etc|vs|cf|aprox|approx)\./giu;
const ABBREVIATION_DOT = "\u2024";
function answerUnits(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const units = [];
  let current = null;
  const unit = (t, header = null, items = null) => ({ text: t.replaceAll(ABBREVIATION_DOT, "."), header: header?.replaceAll(ABBREVIATION_DOT, ".") ?? null, items: items?.map((i) => i.replaceAll(ABBREVIATION_DOT, ".")) ?? null });
  const flush = () => {
    if (current !== null) units.push(unit([current.header, ...current.items].join("\n"), current.header, current.items.length ? current.items : null));
    current = null;
  };
  for (const raw of lines) {
    const line = raw.replace(ABBREVIATION_RE, (m) => m.replaceAll(".", ABBREVIATION_DOT));
    const isItem = /^\s*(?:[-*+•]|\d+[.)])\s+/.test(line);
    if (current !== null && isItem) {
      current.items.push(line);
      continue;
    }
    flush();
    if (!line.trim()) continue;
    const sentences = line.split(/(?<=[.;!?])\s+(?=[\p{Lu}¿¡*_`<(])/u);
    const last = sentences.pop();
    units.push(...sentences.map((t) => unit(t)));
    if (/:\s*(?:\*\*|__)?\s*$/.test(last) || /:\s*$/.test(last)) current = { header: last, items: [] };
    else units.push(unit(last));
  }
  flush();
  return units;
}

const FILLER = String.raw`(?:\s+(?:un|una|el|la|los|las|del|de|cada|todo|toda|a|an|the|each|any|every)\b)*`;
// Phrase BEFORE the element: "dentro de <para>", "inside a <para>",
// "children of <para>", "en el interior de <para>".
const BEFORE_RE = new RegExp(
  String.raw`(?:dentro\s+de(?:l)?|en\s+el\s+interior\s+de(?:l)?|hijos?\s+(?:directos?\s+)?de(?:l)?|elementos\s+hijos?\s+de(?:l)?|inside|within|into|children\s+of|child\s+elements?\s+of)` + FILLER + String.raw`\s*$`,
  "iu"
);
// A verb or noun that says "has inside it", in Spanish and English:
// contener/incluir/admitir/anidar/permitir incluir/sus hijos, contain/
// include/allow/nest/its children. Used AFTER the element ("<para> puede
// contener …", "<para> …, permitiendo anidar …") and, as the start of a
// sentence with no element named, for an implied subject ("Admite …",
// "Sus hijos incluyen …") that refers to the element of the sentence before.
const CONTAIN_SRC = String.raw`(?:puede[n]?\s+(?:contener|incluir|llevar|albergar|admitir|tener|anidar)|permit(?:e|en|ir|iendo)\s+(?:anidar|incluir|contener|usar|utilizar|insertar|meter)|admit(?:e|en|iendo)|contien(?:e|en)|conteniendo|inclu(?:ye|yen|yendo)|alberga[n]?|lleva[n]?|anid(?:a|an|ar|ando)|(?:tiene[n]?\s+(?:como\s+)?|sus\s+|cuyos\s+|con\s+)?(?:elementos\s+)?hijos(?:\s+(?:directos|posibles|permitidos))?|(?:can|may)\s+(?:contain|include|hold|have|nest)|contain(?:s|ing)?|includ(?:es|ing)|holds|allow(?:s|ing)?(?:\s+(?:you\s+)?to)?\s+(?:nest(?:ing)?|include|including|contain)|nest(?:s|ing)?|its\s+(?:child\s+elements|children)|children\s+(?:are|include))`;
const AFTER_RE = new RegExp(String.raw`^[^.;\n]{0,160}?\b` + CONTAIN_SRC + String.raw`\b`, "iu");
const IMPLIED_RE = new RegExp(
  String.raw`^\s*(?:[-*+•]\s+)?(?:(?:además|también|asimismo|also|in\s+addition|additionally)\s*,?\s*)?(?:(?:este\s+elemento|this\s+element|it)\s+)?(?:(?:además|también|asimismo|also)\s+)?` + CONTAIN_SRC + String.raw`\b`,
  "iu"
);
// A phrase that turns the relation the other way round ("se usa dentro de",
// "aparece en", "is used inside"): names after it are the element's
// containers, not its contents, so they are never judged as children.
const REVERSE_RE = /\b(?:dentro\s+de|en\s+el\s+interior\s+de|forma\s+parte\s+de|se\s+(?:usa|utiliza|emplea|coloca|sitúa|situa)\s+(?:en|dentro)|aparece\s+en|puede[n]?\s+ir\s+en|va[n]?\s+en|hijos?\s+de|contenid[oa]s?\s+en|padres?|inside|within|used\s+in|appears\s+in|goes\s+in|placed\s+in|part\s+of|child\s+of|contained\s+in|parents?)\b/iu;
const NEGATION_RE = /\b(?:no|not|never|nunca|cannot|can't|ni|sin|without)\b/iu;
// A list header that introduces what goes INSIDE the element: "Contenido
// permitido:", "Hijos:", "Children:", "Allowed content:" (markdown emphasis
// allowed around it). Its items are the element's contents -- when the
// element is what the answer is about (named in the header or earlier).
const CONTENT_HEADER_RE = /(?:^|[\s*_`>(-])(?:contenido(?:\s+(?:permitido|admitido|posible))?|hijos(?:\s+(?:permitidos|posibles|directos|comunes))?|elementos\s+hijos|puede\s+contener|children|child\s+elements|allowed\s+content|content(?:\s+model)?|can\s+contain)\s*(?:[*_`]+\s*)?:\s*(?:[*_`]+\s*)?$/iu;
// "<para> debe:" / "<para> must:" -- then only the items that start with a
// containment verb ("- Contener …", "- Contain …") are about its contents.
const MODAL_HEADER_RE = /^\s*(?:[*_`]+\s*)?(?:debe[n]?|deber[ií]a[n]?|puede[n]?|must|should|can|may)\s*(?:[*_`]+\s*)?:\s*(?:[*_`]+\s*)?$/iu;
const ITEM_CONTAIN_RE = new RegExp(
  String.raw`^\s*(?:[-*+•]|\d+[.)])\s+(?:[*_\x60]*[^:\n]{0,40}?[*_\x60]*:\s*)?(?:contener|incluir|admitir|llevar|albergar|anidar|contain|include|hold|nest|` + CONTAIN_SRC + String.raw`)\b`,
  "iu"
);
// The part of a list item after its "**Label**:" lead-in, if any.
function itemBody(item) {
  const label = /^\s*(?:[-*+•]|\d+[.)])\s+[*_`]*[^:\n]{0,40}?[*_`]*:\s*/u.exec(item);
  const bullet = /^\s*(?:[-*+•]|\d+[.)])\s+/u.exec(item);
  return { offset: (label || bullet)[0].length };
}

// Names the answer presents as CHILDREN of `element` ("dentro de <para> …",
// "<para> puede contener …", "<para> …, permitiendo anidar …", "children of
// <para>: …", or the next sentence "Admite …" / "Sus hijos incluyen …") that
// the schema only has as its PARENTS -- the answer turned the relation
// around. Not judged:
// - a name before the phrase;
// - a name after a phrase that turns the relation round ("y se usa dentro
//   de <levelledPara>");
// - a name with a negation between the phrase and it ("dentro de <para> no
//   puede ir <levelledPara>");
// - a name that is neither a child nor a parent (a descendant, something
//   unrelated), or both (`footnote` in 4.2).
// After the element, the verb must come before any other element name: in
// "<para> va dentro de <levelledPara>, que admite …" the verb belongs to
// <levelledPara>.
export function parentsPresentedAsChildren(answer, element, cards, vocabulary) {
  const rel = elementRelations(cards, element);
  if (!rel) return { available: false, offenders: [], units: [] };
  const offenders = new Map();
  const matchedUnits = [];
  let previousNamedElement = false;
  let elementNamedSoFar = false;
  // Names in `text` from `start` (up to a phrase that turns the relation
  // round), without a negation before them, that are only parents.
  const judge = (text, start, mentions) => {
    const reverse = REVERSE_RE.exec(text.slice(start));
    const stop = reverse ? start + reverse.index : text.length;
    for (const m of mentions) {
      if (m.index < start || m.index >= stop || m.kind !== "element" || m.name === element) continue;
      if (NEGATION_RE.test(text.slice(start, m.index))) continue;
      if (rel.parents.has(m.name) && !rel.children.has(m.name)) offenders.set(m.name, true);
    }
  };
  for (const { text: unit, header, items } of answerUnits(answer)) {
    const mentions = schemaNameMentions(unit, vocabulary);
    const namesElementHere = mentions.some((m) => m.kind === "element" && m.name === element);
    // A list: "<para> debe:" + "- Contener …", or "Contenido permitido:" +
    // items about the element the answer is discussing.
    if (items) {
      const headerMentions = schemaNameMentions(header, vocabulary);
      const own = headerMentions.find((m) => m.kind === "element" && m.name === element);
      const modal = own && MODAL_HEADER_RE.test(header.slice(own.index + own.length));
      const content = CONTENT_HEADER_RE.test(header) && (own || elementNamedSoFar || previousNamedElement);
      if (modal || content) {
        matchedUnits.push(unit);
        for (const item of items) {
          if (modal && !ITEM_CONTAIN_RE.test(item)) continue;
          judge(item, itemBody(item).offset, schemaNameMentions(item, vocabulary));
        }
        previousNamedElement = namesElementHere;
        elementNamedSoFar ||= namesElementHere;
        continue;
      }
    }
    const namesElement = namesElementHere;
    let start = null;
    for (const m of mentions) {
      if (m.kind !== "element" || m.name !== element) continue;
      const before = unit.slice(0, m.index);
      const after = unit.slice(m.index + m.length);
      if (BEFORE_RE.test(before)) {
        start = m.index + m.length;
        break;
      }
      const a = AFTER_RE.exec(after);
      if (a) {
        const verbEnd = m.index + m.length + a.index + a[0].length;
        const between = mentions.some((o) => o.kind === "element" && o.name !== element && o.index > m.index && o.index < verbEnd);
        if (!between) {
          start = verbEnd;
          break;
        }
      }
    }
    if (start === null && !namesElement && previousNamedElement) {
      const implied = IMPLIED_RE.exec(unit);
      if (implied) start = implied.index + implied[0].length;
    }
    previousNamedElement = namesElement;
    elementNamedSoFar ||= namesElement;
    if (start === null) continue;
    matchedUnits.push(unit);
    judge(unit, start, mentions);
  }
  return { available: true, offenders: [...offenders.keys()], units: matchedUnits };
}
