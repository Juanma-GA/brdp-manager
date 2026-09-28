// "Ask: comprobar los nombres de la respuesta" round, Part 1: after Ask's
// answer arrives, the element/attribute names it mentions are checked
// deterministically against the project standard's vocabulary -- the same
// vocabulary and the same checkAgainstVocabulary the BRDP's own red notice
// uses. Only warns (the caller shows a red line under the answer); never
// edits or hides the answer. Pure and framework-free, so the Node test
// scripts import it directly.
//
// Real case behind it (S1000D 3.0.1): the BRDP says `@ncage` (correctly
// flagged: no such attribute in 3.0.1), and "¿Cuál es el elemento usado
// para Ncage?" got "ncage es un atributo del elemento
// `<identAndStatusSection>`" -- `<identAndStatusSection>` is 4.x only
// (3.0.1 uses `<idstatus>`).
//
// "Aviso de nombres sin heurísticas" round: the check no longer tries to
// read sentences. The first version skipped names the answer denied ("no
// existe", "instead of", ...) and matched the BRDP's own nonexistent names
// even when written bare; against real Mistral answers that guessed wrong
// in both directions ("The attribute **@ncage** does not exist" and "does
// not contain ... including @ncage" were read as claims that it exists).
// Now:
//   - the names the BRDP's own notice already reports (its notFound /
//     wrongType, the list the prompt receives) are never checked in the
//     answer -- the user has already been warned about them, and an
//     answer that repeats them is usually saying they do not exist;
//   - every other name the answer mentions is checked as written, with no
//     interpretation of the sentence around it; the warning text is
//     neutral ("names mentioned in the answer that do not exist ...").
//
// What counts as a name in the answer:
//   - the existing extractor (extractContextCandidates): `<x>` tags,
//     half-typed `<x`/`x>`, `@x`, and camelCase words;
//   - a name inside inline code (`x`) that sits next to an element/
//     attribute word ("el atributo `ncage`", "the `ncage` attribute"),
//     which gives its kind. A bare code token with no such word is
//     ignored: in an answer it is as often an attribute VALUE (`em01`) or
//     a keyword as a name, and guessing would produce false warnings.
// Names with a namespace prefix (`<xsl:template>`, `@xlink:href`) are
// never schema vocabulary and are skipped.
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

const bareName = (display) => display.replace(/^[<@]|>$/g, '');

// Returns { available, notFound: ["<x>", "@y", ...], wrongType: [{ name,
// usedAs, actualAs }] } -- the same shapes as checkAgainstVocabulary, so
// the UI formats them the same way. `brdpVocabCheck` is the BRDP's own
// vocabulary result ({ notFound, wrongType }, what the prompt receives);
// its names are left out of the answer check.
export function checkAnswerNames(answerText, vocabulary, brdpVocabCheck = null) {
  if (!vocabulary) return { available: false, notFound: [], wrongType: [] };
  const alreadyWarned = new Set([
    ...(brdpVocabCheck?.notFound || []).map(bareName),
    ...(brdpVocabCheck?.wrongType || []).map((w) => w.name),
  ]);
  const checked = checkAgainstVocabulary(extractAnswerNames(answerText || ''), vocabulary);
  return {
    available: true,
    notFound: checked.notFound.filter((display) => !alreadyWarned.has(bareName(display))),
    wrongType: checked.wrongType.filter((w) => !alreadyWarned.has(w.name)),
  };
}

// Whether the check found anything to warn about.
export function answerNameCheckHasWarnings(result) {
  return Boolean(result && result.available && (result.notFound.length > 0 || result.wrongType.length > 0));
}
