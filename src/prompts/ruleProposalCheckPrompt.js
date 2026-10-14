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
// of <applicRef>. Default BREX pass, Part 1.2: the default S1000D 4.2 BREX
// rules on the data update file (BRDP-EXT-00014 … 00025: "Only X, Y, Z
// elements can be used …", implemented by forbidding every other CIR
// element) were still judged "no": the "only these" bullet now says that
// forbidding what is not in the list implements it, and an incomplete
// forbidden list is "partly". "partly" keeps the examples' verdict with an informative
// note; only "no" gives "Review" (ruleTest.js's ruleTestVerdict).
const PROPOSAL_CHECK_LEVELS = ['yes', 'partly', 'no'];

// `input`: { brdp, standard, format, ruleXml, ruleDescription (English
// text, one "- " line per statement), requiredAttributes }.
// requiredAttributes (Test de reglas: atributos obligatorios): [{ element,
// attributes }] -- the attributes the schema makes required on the
// elements the rule names, taken from the schema structure (never typed
// here). GMC 4.2 BRDP-EXT-00160: the Proposal asks for @verificationType,
// the rule requires <firstVerification>, which cannot exist without it.
function requiredAttributesBlock(requiredAttributes) {
  const lines = (requiredAttributes || [])
    .filter((r) => r.attributes?.length)
    .map((r) => `- <${r.element}>: ${r.attributes.map((a) => `@${a}`).join(', ')}`);
  return lines.length
    ? `\n\nREQUIRED ATTRIBUTES (from the schema: every valid document has them on these elements of the rule):\n${lines.join('\n')}`
    : '';
}

// El juez de la Propuesta y las listas cerradas, Part 2: the real BRDP-EXT-00019
// (zone CIR, "Only zoneSpec, zoneIdent, figure, … elements can be used")
// was judged "no": the judge read the rule's list of 26 forbidden elements
// as the allowed ones. `proposalVsRule` (ruleTestEngine.js's
// proposalVsRuleLists, computed from the rule and the vocabulary) gives the
// two lists already compared; null when the rule has no element list or
// the Proposal names no element -- then the prompt does not change.
const names = (list) => (list.length ? list.map((n) => `<${n}>`).join(', ') : '(none)');
function proposalVsRuleBlock(lists) {
  if (!lists) return '';
  const others = lists.othersAll ? 'every element outside the rule\'s list' : `${lists.othersForbidden} element${lists.othersForbidden === 1 ? '' : 's'}`;
  return `\n\nPROPOSAL vs RULE (computed by the application, do not recompute):
- named in the Proposal and NOT forbidden by the rule: ${names(lists.notForbidden)}
- named in the Proposal and forbidden by the rule: ${names(lists.forbidden)}
- forbidden by the rule and not named in the Proposal: ${others}
If no element named as allowed by the Proposal is forbidden by the rule, the rule implements an "only these" decision: answer "yes" (or "partly" if the list looks incomplete), never "no".`;
}

// Reglas que solo avisan: a Schematron rule whose checks are all
// role="warning"/"info" never rejects -- its warnings are what to judge. Only
// these rules get the block; every other prompt is unchanged.
function warningRuleBlock(warningRule) {
  if (!warningRule) return '';
  return `

THE RULE ONLY WARNS: its checks have role="warning" (or "info"): it never
rejects a document, it gives a warning. Judge what it warns about as if it
were what it rejects. When the Proposal says the case gives a warning (a
"warning", an "aviso", "avisar"…) or only asks to flag it, a rule that warns
on that case implements it: "yes". That the rule does not reject the
document is never a reason for "partly" or "no".`;
}

export function buildRuleProposalCheckPrompt({ brdp, standard, format, ruleXml, ruleDescription, requiredAttributes = [], proposalVsRule = null, warningRule = false }) {
  return `You check whether one ${standard} business rule implements the decision of
its BRDP. You never write or fix anything.

The decision (BRDP ${brdp.identifier}):
Title: ${brdp.title}
Definition: ${brdp.definition}
Proposal: ${brdp.proposal}

What the rule checks (computed by the application from its XML — exact):
${ruleDescription}

The rule (${format}):
${ruleXml}${ruleValueLegend(ruleXml)}${requiredAttributesBlock(requiredAttributes)}${proposalVsRuleBlock(proposalVsRule)}${warningRuleBlock(warningRule)}

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
  must NOT reject them. Forbidding every element that is not in the
  Proposal's list implements "only these". If the list of forbidden
  elements looks incomplete (an element that is neither allowed by the
  Proposal nor forbidden by the rule), the answer is "partly", never "no".
- The Proposal requires an attribute that the schema makes required on an
  element (see REQUIRED ATTRIBUTES, when given): requiring that element
  implements the Proposal, because the element cannot appear without the
  attribute: "yes".

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
