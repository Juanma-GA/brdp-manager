// Suggest Rule prerequisite (docs request, Suggest Rule round): a Proposal
// that still contains a placeholder the user hasn't filled in is not a
// decision yet, so there is nothing for a rule to implement.
//
// A placeholder is ANY "[...]" that
//   - starts a word: preceded by the start of the text, whitespace or
//     sentence punctuation ( , ; : ! ? ¿ ¡ quotes, dashes) -- never by a
//     letter, digit, ")", "]", "*", "/", "@", "." etc., so an XPath
//     predicate glued to a step (para[@x], //a[1], x[.='y'], (//p)[2]) is
//     never one;
//   - and whose content doesn't start with "@" or a digit ([@type='x'],
//     [1..n] are predicates/ranges, not placeholders).
// Covers Suggest Proposal's own markers ([LIST: …], [SHALL/SHALL NOT],
// [VALUE: …]) and hand-typed ones ([e C1008, C1234], [tbd]) alike.
//
// Mirrors backend/app/api/routes/similar.py's UNFILLED_MARKER_RE -- keep
// both in sync (the backend repeats the check as a defense).
export const UNFILLED_MARKER_RE = /(?:^|(?<=[\s(,;:!?¿¡"'«“‘—–]))\[(?![@\d\s\]])[^[\]]+\]/u;

export function hasUnfilledMarkers(text) {
  return UNFILLED_MARKER_RE.test(text || '');
}
