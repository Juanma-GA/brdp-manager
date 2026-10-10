// Barrido final 1/2, Part 2: does the rule implement the Proposal?
// Until now the examples call (temperature 0.5) also filled a
// "proposalMismatch" field, and that judgement was unstable (the real
// "at most three substeps" case against count(proceduralStep) = 1: 1 of 3
// runs). It is now its own short call at RULE_PROPOSAL_CHECK_TEMPERATURE,
// given only the decision and the rule's deterministic description
// (describeRule, English) -- never the LLM's own reading of the XML. Pure
// function, same architecture as the other prompts. The "Review" verdict
// comes from its answer; a failed call never counts as "implements".

import { readLlmJson } from './llmJson.js';
import { ruleValueLegend } from './shared.js';

export const RULE_PROPOSAL_CHECK_USER_MESSAGE = 'Check whether the rule implements the Proposal.';

// Barrido final 3: three levels with their reason instead of true/false.
// The first real run of this call (0758381) was right on the "at most three
// substeps" rule but said "Review" on three correct rules: a Proposal part
// no XML rule can check (marking torque values up with <quantity>), "only
// toolSpec, … can be used" implemented as a prohibition of the other
// elements (read backwards), and "use <applic>" implemented as a prohibition
// of <applicRef>. "partly" keeps the examples' verdict with an informative
// note; only "no" gives "Review" (ruleTest.js's ruleTestVerdict).
const PROPOSAL_CHECK_LEVELS = ['yes', 'partly', 'no'];

// `input`: { brdp, standard, format, ruleXml, ruleDescription (English
// text, one "- " line per statement) }.
export function buildRuleProposalCheckPrompt({ brdp, standard, format, ruleXml, ruleDescription }) {
  return `You check whether one ${standard} business rule implements the decision of
its BRDP. You never write or fix anything.

The decision (BRDP ${brdp.identifier}):
Title: ${brdp.title}
Definition: ${brdp.definition}
Proposal: ${brdp.proposal}

What the rule checks (computed by the application from its XML — exact):
${ruleDescription}

The rule (${format}):
${ruleXml}${ruleValueLegend(ruleXml)}

HOW TO DECIDE — answer one of three levels:
- "yes": what the rule rejects is what the Proposal decides: what the
  Proposal forbids is rejected, and what it allows is not.
- "partly": the rule implements the Proposal's main restriction that can
  be checked in XML; what it lacks is a nuance, or something no XML rule
  can check.
- "no": the rule does not implement the Proposal's main restriction (for
  example it checks a maximum only at one exact value), rejects something
  the Proposal allows, or contradicts the Proposal.
Judge only what is rejected; the wording of the rule's messages and of the
Proposal does not matter.

These are NOT reasons for "no":
- A part of the Proposal that no XML rule can check (that a value written
  in the text "shall be marked up" with some element, a style or wording
  choice) while the rule checks the rest: "partly".
- The Proposal requires one way and the rule forbids the alternative (the
  Proposal says "use <x>" and the rule rejects <y> where <x> belongs): this
  is how a business rule implements "use <x>": "yes".
- The rule does not reject a missing attribute or element (the description
  says "if it does not appear, it is not rejected"): "yes" when the
  Proposal only restricts its value; "partly" when the Proposal also makes
  it mandatory.
- The Proposal says "only A, B and C are allowed" and the rule rejects the
  other elements by name: "yes". A, B and C are the allowed ones: the rule
  must NOT reject them.

Examples:
- Proposal "A step shall have at most three substeps."; the rule rejects a
  step with exactly one substep → "no": four or more substeps are not
  rejected, and a single substep is allowed by the Proposal.
- Proposal "Torque values shall be marked up with <quantity> and their unit
  of measure shall be N.m."; the rule lets @quantityUnitOfMeasure take only
  N.m → "partly": that torque values are marked up with <quantity> cannot
  be checked by a rule.
- Proposal "Only toolSpec, toolIdent, figure, … elements can be used in the
  data update file representing the tool CIR."; the rule rejects a tool CIR
  that contains <zoneSpec>, <partSpec>, … → "yes".
- Proposal "Use <applic> element" (in the status section); the rule rejects
  <applicRef> in <dmStatus> and <pmStatus> → "yes".

OUTPUT: strict JSON:
{"implements": "yes", "reason": ""}
"reason": for "partly" and "no", one short sentence in the same language as
the Proposal saying what the rule does not check or checks differently;
"" for "yes".`;
}

// { ok: true, level: 'yes'|'partly'|'no', reason } | { ok: false, error }
// -- read by readLlmJson (a fence, text around the object and raw control
// characters inside strings are tolerated), strict about the level. The
// boolean form of Barrido final 1/2 ({"implements": true|false, "missing"})
// is still read: true → "yes", false → "no".
export function parseRuleProposalCheckResponse(raw) {
  const read = readLlmJson(raw);
  if (!read.ok && read.reason === 'no_object') return { ok: false, error: 'The answer contains no JSON object.' };
  if (!read.ok) return { ok: false, error: `The answer is not valid JSON (${read.message}).` };
  const { data } = read;
  let level = data.implements;
  if (level === true) level = 'yes';
  else if (level === false) level = 'no';
  else if (typeof level === 'string') {
    level = level.trim().toLowerCase();
    if (level === 'partial' || level === 'partially') level = 'partly';
  }
  if (!PROPOSAL_CHECK_LEVELS.includes(level)) {
    return { ok: false, error: `The answer has "implements" = ${JSON.stringify(data.implements)} (must be "yes", "partly" or "no").` };
  }
  const text = (v) => (typeof v === 'string' ? v.trim() : '');
  const reason = text(data.reason) || text(data.missing);
  return { ok: true, level, reason };
}
