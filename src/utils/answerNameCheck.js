// "Ask: comprobar los nombres de la respuesta" round, Part 1: after Ask's
// answer arrives, the element/attribute names it PRESENTS AS REAL are
// checked deterministically against the project standard's vocabulary --
// the same vocabulary and the same checkAgainstVocabulary the BRDP's own
// red notice uses. Only warns (the caller shows a red line under the
// answer); never edits or hides the answer. Pure and framework-free, so
// the Node test scripts import it directly.
//
// Real case behind it (S1000D 3.0.1): the BRDP says `@ncage` (correctly
// flagged: no such attribute in 3.0.1), and "¿Cuál es el elemento usado
// para Ncage?" got "ncage es un atributo del elemento
// `<identAndStatusSection>`" -- `<identAndStatusSection>` is 4.x only
// (3.0.1 uses `<idstatus>`), and the prompt had already said `@ncage` does
// not exist.
//
// What counts as a name in the answer:
//   - the existing extractor (extractContextCandidates): `<x>` tags,
//     half-typed `<x`/`x>`, `@x`, and camelCase words;
//   - a name inside inline code (`x`) that sits next to an element/
//     attribute word ("el atributo `ncage`", "the `ncage` attribute"),
//     which gives its kind. A bare code token with no such word is
//     ignored: in an answer it is as often an attribute VALUE (`em01`) or
//     a keyword as a name, and guessing would produce false warnings;
//   - the names the prompt already listed as nonexistent (the BRDP's
//     own), also when written bare with the same spelling ("ncage es un
//     atributo"): they are specific known-bad tokens, so matching them
//     bare is safe. A different capitalisation ("NCAGE", the concept the
//     user asked about) is NOT matched -- it is usually the concept, not
//     the name.
// Names with a namespace prefix (`<xsl:template>`, `@xlink:href`) are
// never schema vocabulary and are skipped.
//
// "Presents as real": a mention whose own clause denies it ("`@ncage` no
// existe en 3.0.1", "use `<idstatus>` instead of
// `<identAndStatusSection>`") is not a claim that the name exists, so it
// does not warn. A name warns when at least one of its mentions is not
// denied.
import { checkAgainstVocabulary, extractContextCandidates } from './vocabularyCheck.js';

const CODE_SPAN_RE = /`([^`\n]+)`/g;
const CODE_NAME_RE = /^(@)?<?\/?([A-Za-z][\w.-]*)>?$/;
const KIND_WORDS = {
  element: ['elemento', 'elementos', 'element', 'elements', 'etiqueta', 'etiquetas', 'tag', 'tags'],
  attribute: ['atributo', 'atributos', 'attribute', 'attributes'],
};
const CONNECTORS = new Set(['el', 'la', 'los', 'las', 'del', 'de', 'un', 'una', 'the', 'of', 'a', 'an']);

function kindOfWord(word) {
  const w = (word || '').toLowerCase();
  if (KIND_WORDS.element.includes(w)) return 'element';
  if (KIND_WORDS.attribute.includes(w)) return 'attribute';
  return null;
}

// The element/attribute word right before a code span (skipping
// articles/prepositions) or right after it.
function kindAround(text, start, end) {
  const before = text.slice(Math.max(0, start - 40), start).match(/[\p{L}]+/gu) || [];
  for (let i = before.length - 1; i >= 0 && i >= before.length - 3; i--) {
    const kind = kindOfWord(before[i]);
    if (kind) return kind;
    if (!CONNECTORS.has(before[i].toLowerCase())) break;
  }
  const after = text.slice(end, end + 20).match(/^\s*([\p{L}]+)/u);
  return after ? kindOfWord(after[1]) : null;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Deterministic candidates in the answer text: { elements, attributes,
// camelCase } in the shape checkAgainstVocabulary takes.
export function extractAnswerNames(text) {
  const source = text || '';
  const base = extractContextCandidates(source);
  const elements = new Set(base.elements);
  const attributes = new Set(base.attributes);
  let m;
  CODE_SPAN_RE.lastIndex = 0;
  while ((m = CODE_SPAN_RE.exec(source))) {
    const code = m[1].trim();
    const nm = code.match(CODE_NAME_RE);
    if (!nm) continue;
    const name = nm[2];
    // `<x>` and `@x` inside code are already taken by the extractor above.
    if (nm[1] || code.startsWith('<')) continue;
    const kind = kindAround(source, m.index, m.index + m[0].length);
    if (kind === 'element') elements.add(name);
    else if (kind === 'attribute') attributes.add(name);
  }
  // The prefix of `<xsl:template>` / `@xlink:href`, or the local part of
  // `<xsl:template>` (which the half-typed-tag reader sees as `template>`).
  const prefixed = (name, marker) =>
    new RegExp(`${marker}${escapeRegExp(name)}:|[\\w-]:${escapeRegExp(name)}(?![\\w-])`).test(source);
  return {
    elements: [...elements].filter((n) => !prefixed(n, '</?')),
    attributes: [...attributes].filter((n) => !prefixed(n, '@')),
    camelCase: base.camelCase,
  };
}

// A clause denies a name when a denial phrase follows the name in the
// same clause, or precedes it closely ("no existe el atributo @x",
// "instead of <x>").
const DENIAL_AFTER_RE =
  /^[^.;!?\n]{0,40}?(?:no existen?|does not exist|doesn't exist|do not exist|don't exist|is not (?:a |an )?(?:valid|real|defined|recogni[sz]ed)|isn't (?:a |an )?(?:valid|real)|is not part of|isn't part of|no forma parte|no es (?:un |una )?(?:elemento |atributo )?v[áa]lid|not (?:a |an )?valid|is not defined|isn't defined|no est[áa] definid|is invalid|es inv[áa]lid|inexistente|does not appear|no aparece|is not an? (?:element|attribute)|isn't an? (?:element|attribute)|no es (?:un |una )?(?:elemento|atributo))/i;
const DENIAL_BEFORE_RE =
  /(?:no existen?|there is no|there's no|no hay|does not exist|doesn't exist|not exist|never use|do not use|don't use|no uses?|nunca uses?|instead of|en lugar de|en vez de|rather than)[^.;!?\n]{0,25}$/i;

function isDenied(text, index, length) {
  const after = text.slice(index + length, index + length + 80);
  const before = text.slice(Math.max(0, index - 50), index);
  return DENIAL_AFTER_RE.test(after) || DENIAL_BEFORE_RE.test(before);
}

// Every place the answer mentions `name` in a form that could present it:
// `<name`, `</name`, `@name`, `name` in code, and the bare word (only
// requested for the prompt's own nonexistent names, see the header).
function mentions(text, name, { bare }) {
  const n = escapeRegExp(name);
  const forms = [`</?${n}(?![\\p{L}\\p{N}_:-])`, `@${n}(?![\\p{L}\\p{N}_:-])`, `\`${n}\``];
  if (bare) forms.push(`(?<![\\p{L}\\p{N}_<@-])${n}(?![\\p{L}\\p{N}_-])`);
  const re = new RegExp(forms.join('|'), 'gu');
  const out = [];
  let m;
  while ((m = re.exec(text))) out.push({ index: m.index, length: m[0].length });
  return out;
}

function presentedAsReal(text, name, bare) {
  const found = mentions(text, name, { bare });
  // No locatable mention (a name reached only through the extractor's own
  // forms, e.g. camelCase): treat it as presented.
  if (found.length === 0) return true;
  return found.some((o) => !isDenied(text, o.index, o.length));
}

const bareName = (display) => display.replace(/^[<@]|>$/g, '');

// Returns { available, notFound: ["<x>", "@y", ...], wrongType: [{ name,
// usedAs, actualAs }] } -- the same shapes as checkAgainstVocabulary, so
// the UI formats them the same way. `promptUnknown` is the display list
// the prompt called nonexistent (vocabCheck.notFound of the BRDP).
export function checkAnswerNames(answerText, vocabulary, promptUnknown = []) {
  if (!vocabulary) return { available: false, notFound: [], wrongType: [] };
  const text = answerText || '';
  const checked = checkAgainstVocabulary(extractAnswerNames(text), vocabulary);
  const notFound = new Map();
  for (const display of checked.notFound) {
    const name = bareName(display);
    if (presentedAsReal(text, name, false)) notFound.set(name, display);
  }
  for (const display of promptUnknown || []) {
    const name = bareName(display);
    if (!name || notFound.has(name)) continue;
    if (mentions(text, name, { bare: true }).length > 0 && presentedAsReal(text, name, true)) {
      notFound.set(name, display);
    }
  }
  const wrongType = checked.wrongType.filter((w) => presentedAsReal(text, w.name, false));
  return {
    available: true,
    notFound: [...notFound.values()].sort(),
    wrongType,
  };
}

// Whether the check found anything to warn about.
export function answerNameCheckHasWarnings(result) {
  return Boolean(result && result.available && (result.notFound.length > 0 || result.wrongType.length > 0));
}
