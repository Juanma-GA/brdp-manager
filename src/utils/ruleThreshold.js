// Mejoras B, Part 2: does the rule's threshold match the numbers of the
// Proposal? Deterministic, never an LLM. Real case: Proposal "a maximum of
// five levels of procedural steps", rule
// //proceduralStep[count(ancestor::proceduralStep)>5] -- it allows six
// levels and rejects from the seventh; the examples written from the rule
// passed and the Proposal judge said "yes" three times.
//
// The border numbers of a threshold are the last value the rule allows and
// the first one it rejects (with "=" the exact value, and the next allowed
// one when the exact value is the forbidden one). When the Proposal has
// numbers and none of them is a border number, the test verdict is "review"
// (test_threshold_mismatch) and Suggest Rule / Paste rule show the same
// warning in amber. A Proposal without numbers says nothing.
// Pure module (Node and browser).
import { parseXmlDocument, ruleThresholds } from './ruleTestEngine.js';

const EN_NUMBERS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
const EN_ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
const ES_NUMBERS = ['uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve', 'veinte'];
const ES_ORDINALS = [
  ['primero', 'primera', 'primer'], ['segundo', 'segunda'], ['tercero', 'tercera', 'tercer'], ['cuarto', 'cuarta'],
  ['quinto', 'quinta'], ['sexto', 'sexta'], ['séptimo', 'séptima'], ['octavo', 'octava'], ['noveno', 'novena'], ['décimo', 'décima'],
];
const WORDS = new Map();
EN_NUMBERS.forEach((w, i) => WORDS.set(w, i + 1));
EN_ORDINALS.forEach((w, i) => WORDS.set(w, i + 1));
ES_NUMBERS.forEach((w, i) => WORDS.set(w, i + 1));
WORDS.set('dieciseis', 16);
ES_ORDINALS.forEach((forms, i) => forms.forEach((w) => {
  WORDS.set(w, i + 1);
  WORDS.set(w.normalize('NFD').replace(/[̀-ͯ]/g, ''), i + 1);
}));

// The integers of a Proposal, in digits or in words (EN/ES), leaving out
// those in identifiers (BRDP-S1-00186, S1000D), versions (4.2), chapters
// (3.9.5.2.1), dates and names/codes (em02, brsl01, cv01).
export function proposalNumbers(text) {
  let s = String(text || '');
  s = s
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
    .replace(/\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b/g, ' ')
    .replace(/\d+(?:\.\d+)+/g, ' ')
    .replace(/[\p{L}_][\p{L}\p{N}_]*(?:-[\p{L}\p{N}_]+)*\d[\p{L}\p{N}_-]*/gu, (m) => (/^\p{L}+-\d+$/u.test(m) ? m.replace(/^\p{L}+-/u, ' ') : ' '));
  const out = new Set();
  for (const m of s.matchAll(/(?<![\p{L}\p{N}_])(\d+)(?:st|nd|rd|th|º|ª|o|a)?(?![\p{L}\p{N}_])/gu)) out.add(Number(m[1]));
  for (const m of s.toLowerCase().matchAll(/\p{L}+/gu)) {
    const n = WORDS.get(m[0]);
    if (n) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

// { allowed, rejected, borders } of one threshold, as numbers the
// Proposal would use: nesting levels (1 = outermost) or amounts.
export function thresholdBorders(th) {
  if (th.kind === 'nesting') {
    const L = th.level;
    if (th.mode === 'from') return { borders: [L - 1, L], allowedUpTo: L - 1, rejectedFrom: L };
    if (th.mode === 'exactly') return { borders: [L, L + 1] };
    if (th.mode === 'upto') return { borders: [L, L + 1] };
    return { borders: [L] };
  }
  const n = th.n;
  switch (th.op) {
    case 'gt': return { borders: [n, n + 1], allowedUpTo: n, rejectedFrom: n + 1 };
    case 'ge': return { borders: [n - 1, n], allowedUpTo: n - 1, rejectedFrom: n };
    case 'lt': return { borders: [n - 1, n] };
    case 'le': return { borders: [n, n + 1] };
    case 'eq': return { borders: [n, n + 1] };
    default: return { borders: [n] };
  }
}

// → null (no threshold, no numbers, or a number matches a border) or
//   { numbers, thresholds: [{ …threshold, borders, allowedUpTo?, rejectedFrom? }] }
export function thresholdMismatch(ruleXml, format, proposal, { parseXml = parseXmlDocument } = {}) {
  const thresholds = ruleThresholds(ruleXml, format, { parseXml });
  if (!thresholds.length) return null;
  const numbers = proposalNumbers(proposal);
  if (!numbers.length) return null;
  const withBorders = thresholds.map((th) => ({ ...th, ...thresholdBorders(th) }));
  const borders = new Set(withBorders.flatMap((th) => th.borders));
  if (numbers.some((n) => borders.has(n))) return null;
  return { numbers, thresholds: withBorders };
}
