// Shared between RecordsPage (live Rule Status stepper/sort) and
// ProjectConfigPage's Export to Excel (Rule Status column) -- both need to
// turn a rule_approvals row (or its absence) into the same 3-state
// vocabulary. The engine's inclusion gate hardcodes the literal DB values
// "pending_review"/"approved" in 4 generator files (never touch those) --
// this is only ever a relabeling of them as Draft/Verified. "todo" is not
// a DB value at all, it is the absence of a rule_approvals row.
export const RULE_STATES = ['todo', 'draft', 'verified'];

export function ruleStateOf(approval) {
  if (approval === null || approval === undefined) return 'todo';
  return approval.status === 'approved' ? 'verified' : 'draft';
}
