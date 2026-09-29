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
// stays with the sentence that introduces it).
function answerUnits(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const units = [];
  let current = null;
  for (const line of lines) {
    const isItem = /^\s*(?:[-*+•]|\d+[.)])\s+/.test(line);
    if (current !== null && isItem) {
      current += "\n" + line;
      continue;
    }
    if (current !== null) units.push(current);
    current = null;
    if (!line.trim()) continue;
    const sentences = line.split(/(?<=[.;!?])\s+(?=[\p{Lu}¿¡*_`<(])/u);
    const last = sentences.pop();
    units.push(...sentences);
    if (/:\s*$/.test(last)) current = last;
    else units.push(last);
  }
  if (current !== null) units.push(current);
  return units;
}

const FILLER = String.raw`(?:\s+(?:un|una|el|la|los|las|del|de|cada|todo|toda|a|an|the|each|any|every)\b)*`;
// Phrase BEFORE the element: "dentro de <para>", "inside a <para>",
// "children of <para>", "en el interior de <para>".
const BEFORE_RE = new RegExp(
  String.raw`(?:dentro\s+de(?:l)?|en\s+el\s+interior\s+de(?:l)?|hijos?\s+(?:directos?\s+)?de(?:l)?|elementos\s+hijos?\s+de(?:l)?|inside|within|into|children\s+of|child\s+elements?\s+of)` + FILLER + String.raw`\s*$`,
  "iu"
);
// Verb AFTER the element: "<para> puede contener …", "<para> can contain …".
const AFTER_RE = /^[^.;:\n]{0,40}?\b(?:puede[n]?\s+(?:contener|incluir|llevar|albergar|admitir|tener)|contiene[n]?|incluye[n]?|admite[n]?|alberga[n]?|lleva[n]?|(?:can|may)\s+(?:contain|include|hold|have|nest)|contains|includes|holds)\b/iu;
const NEGATION_RE = /\b(?:no|not|never|nunca|cannot|can't|ni|sin|without)\b/iu;

// Names the answer presents as CHILDREN of `element` ("dentro de <para> …",
// "<para> puede contener …", "children of <para>: …") that the schema only
// has as its PARENTS -- the answer turned the relation around. A name that
// is neither a child nor a parent (a descendant, something unrelated) is
// not judged; nor is one with a negation between the phrase and it
// ("dentro de <para> no puede ir <levelledPara>").
export function parentsPresentedAsChildren(answer, element, cards, vocabulary) {
  const rel = elementRelations(cards, element);
  if (!rel) return { available: false, offenders: [], units: [] };
  const offenders = new Map();
  const matchedUnits = [];
  for (const unit of answerUnits(answer)) {
    const mentions = schemaNameMentions(unit, vocabulary);
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
        start = m.index + m.length + a.index + a[0].length;
        break;
      }
    }
    if (start === null) continue;
    matchedUnits.push(unit);
    for (const m of mentions) {
      if (m.index < start || m.kind !== "element" || m.name === element) continue;
      if (NEGATION_RE.test(unit.slice(start, m.index))) continue;
      if (rel.parents.has(m.name) && !rel.children.has(m.name)) offenders.set(m.name, true);
    }
  }
  return { available: true, offenders: [...offenders.keys()], units: matchedUnits };
}
