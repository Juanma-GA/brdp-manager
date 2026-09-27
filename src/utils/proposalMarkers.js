// Suggest Rule prerequisite (docs request, Suggest Rule round): a Proposal
// that still contains a Suggest Proposal placeholder the user hasn't filled
// in is not a decision yet, so there is nothing for a rule to implement.
// "[" + an uppercase name (letters, spaces, "/", "_", "-"; at least 2
// chars) + optional ":" and free text + "]" -- [LIST: …], [VALUE: …],
// [SHALL/SHALL NOT], [UNIT: …], [CONVENTION: …]. Digits are not allowed in
// the name, so a legitimate "[ISO 8601]" or an XPath predicate "[1]" never
// counts as a placeholder.
//
// Mirrors backend/app/api/routes/similar.py's UNFILLED_MARKER_RE -- keep
// both in sync (the backend repeats the check as a defense).
export const UNFILLED_MARKER_RE = /\[[A-Z][A-Z_/ -]*[A-Z]\s*(?::[^\]]*)?\]/;

export function hasUnfilledMarkers(text) {
  return UNFILLED_MARKER_RE.test(text || '');
}
