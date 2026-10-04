// Barrido final 1/2, Part 2: does the rule implement the Proposal?
// Until now the examples call (temperature 0.5) also filled a
// "proposalMismatch" field, and that judgement was unstable (the real
// "at most three substeps" case against count(proceduralStep) = 1: 1 of 3
// runs). It is now its own short call at RULE_PROPOSAL_CHECK_TEMPERATURE,
// given only the decision and the rule's deterministic description
// (describeRule, English) -- never the LLM's own reading of the XML. Pure
// function, same architecture as the other prompts. The "Review" verdict
// comes from its answer; a failed call never counts as "implements".

export const RULE_PROPOSAL_CHECK_USER_MESSAGE = 'Check whether the rule implements the Proposal.';

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
${ruleXml}

HOW TO DECIDE:
- "implements": true when what the rule rejects is what the Proposal
  decides: everything the Proposal forbids is rejected, and nothing the
  Proposal allows is.
- "implements": false when the rule rejects only part of what the Proposal
  forbids (for example a maximum checked only at one exact value), rejects
  something the Proposal allows, or checks something else.
- Judge only what is rejected; the wording of the rule's messages and of
  the Proposal does not matter.

OUTPUT: strict JSON:
{"implements": true, "missing": ""}
"missing": when "implements" is false, one short sentence in the same
language as the Proposal saying what the rule does not check or checks
differently; "" otherwise.`;
}

// { ok: true, implements, missing } | { ok: false, error } -- tolerant of a
// markdown fence and of text around the JSON object, strict about its shape.
export function parseRuleProposalCheckResponse(raw) {
  let text = (raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1) return { ok: false, error: 'The answer contains no JSON object.' };
  text = end > start ? text.slice(start, end + 1) : text.slice(start);
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `The answer is not valid JSON (${err.message}).` };
  }
  if (typeof data.implements !== 'boolean') {
    return { ok: false, error: `The answer has "implements" = ${JSON.stringify(data.implements)} (must be true or false).` };
  }
  const missing = typeof data.missing === 'string' ? data.missing.trim() : '';
  return { ok: true, implements: data.implements, missing };
}
