// Which BRDPs' rules go into a generated BREX / Schematron, and why the
// others do not. One function for the Generate page's counter and report
// AND the four generators (generateBREX.js, generateBREX41.js,
// generateBREX301.js, generateSchematronDITA.js; the S1000D Schematron output
// goes through one of the first three), so "N BRDPs will be included" is
// always what enters the document.
//
// - onlyValidated: only BRDPs whose Proposal is Validated are considered.
// - includeDrafts: rules in Draft (status "pending_review") go in too, not
//   only Verified ones ("approved") -- the "Only include Verified XML rules"
//   box unchecked.
// A BRDP with no rule (or an empty one) never enters as a rule.
//
// Omitted, with their reason: "draft" (Draft rule, box checked),
// "not_validated" (Proposal not Validated, box checked), "no_rule".

export function ruleEnters(approval, includeDrafts) {
  if (!approval) return false;
  if (approval.status === 'approved') return true;
  return !!includeDrafts && approval.status === 'pending_review' && !!(approval.rule_xml ?? '').trim();
}

function isValidated(brdp) {
  return brdp.validation?.toLowerCase().trim() === 'validated';
}

// approvalById: Map brdp_id -> rule_approvals row (with status and rule_xml).
export function planGeneration(brdps, approvalById, { onlyValidated = true, includeDrafts = false } = {}) {
  const target = [];
  const included = [];
  const drafts = [];
  const omitted = [];
  for (const brdp of brdps) {
    const approval = approvalById?.get(brdp.id) ?? null;
    if (onlyValidated && !isValidated(brdp)) {
      omitted.push({ brdp, reason: 'not_validated' });
      continue;
    }
    target.push(brdp);
    if (ruleEnters(approval, includeDrafts)) {
      included.push(brdp);
      if (approval.status !== 'approved') drafts.push(brdp);
    } else if (approval && approval.status === 'pending_review' && (approval.rule_xml ?? '').trim()) {
      omitted.push({ brdp, reason: 'draft' });
    } else {
      omitted.push({ brdp, reason: 'no_rule' });
    }
  }
  return { target, included, drafts, omitted };
}

// Omitted counts by reason, in a fixed order: { draft, not_validated, no_rule }.
export function omittedByReason(plan) {
  const out = { draft: [], not_validated: [], no_rule: [] };
  for (const o of plan.omitted) out[o.reason].push(o.brdp);
  return out;
}
