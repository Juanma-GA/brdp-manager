// Suggest Rule's system prompt (docs request, Suggest Rule round) -- pure
// function, same architecture as the other Suggest prompts: built ENTIRELY
// from /similar?kind=rule's structured groups and GET /api/schema-cards,
// so the reference list the UI shows is exactly what the LLM saw.
//
// A rule IMPLEMENTS a decision already taken: Suggest Rule is only offered
// once the Proposal is Validated and has no unfilled [PLACEHOLDER] left.
// Rules are always generated as GENERAL rules (no schema context) in this
// round.
import { buildSchemaFactsBlock } from './shared.js';
import { ruleFormatRules } from './ruleFormatRules.js';

export const SUGGEST_RULE_USER_MESSAGE = 'Write the rule for this BRDP.';

// The exact prefix the model must answer with when the decision can't be
// verified on the XML -- parsed by parseSuggestRuleResponse below.
export const NOT_CHECKABLE_PREFIX = 'NOT_CHECKABLE:';

function precedentLines(candidates, withSource) {
  return candidates
    .map((c) => {
      const head = withSource && c.source ? `[${c.identifier} | ${c.source}]` : `[${c.identifier}]`;
      return `${head}\nProposal: ${c.proposal}\nRule:\n${c.text}`;
    })
    .join('\n\n');
}

// `references` is { sameBrdp, similar, formatExamples } -- formatExamples
// being /similar's standard_fallback followed by template_fallback.
export function buildSuggestRulePrompt(brdp, standard, format, references, schemaFacts) {
  const { sameBrdp = [], similar = [], formatExamples = [] } = references;

  let prompt = `You are an expert in ${standard} business rules (BRDPs — Business Rule
Decision Points), assisting in BRDP Manager.

TASK: implement, as ONE general rule in the ${standard} rule format below,
the decision already taken in the BRDP's Proposal. Do not change the
decision, do not widen or narrow it, and do not add checks the Proposal
does not ask for. The rule applies to every schema (it is a general rule,
not tied to one document type).

${ruleFormatRules(format, standard)}`;

  prompt += buildSchemaFactsBlock(standard, schemaFacts);
  // Format examples are deliberately NOT a name source -- their own block
  // says never to copy their names, so citing them here would contradict it.
  const hasFacts = schemaFacts && schemaFacts.length > 0;
  const hasRelatedPrecedents = sameBrdp.length + similar.length > 0;
  const nameSources = [
    'the BRDP itself (Title, Definition, Proposal)',
    hasFacts && 'the SCHEMA FACTS above',
    hasRelatedPrecedents && 'the "Same BRDP" / "Similar decisions" rules below',
  ].filter(Boolean);
  const nameSourceText =
    nameSources.length === 1 ? nameSources[0] : `${nameSources.slice(0, -1).join(', ')} or ${nameSources.at(-1)}`;
  prompt += `

NAMES: use only element and attribute names that appear in ${nameSourceText}.
Never take names from the format examples, and never invent a
plausible-sounding name.`;

  if (sameBrdp.length > 0) {
    prompt += `

Same BRDP in other projects — how other projects implemented this exact
decision point. Follow their structure; keep this project's own decision:
${precedentLines(sameBrdp, true)}`;
  }

  if (similar.length > 0) {
    prompt += `

Similar decisions — related decision points and the rule each one got:
${precedentLines(similar, true)}`;
  }

  if (formatExamples.length > 0) {
    prompt += `

Format examples — unrelated to this BRDP; they show what the format can
express, never copy their element or attribute names:
${precedentLines(formatExamples, false)}`;
  }

  prompt += `

NOT CHECKABLE: if the decision cannot be verified on the XML document
itself (deadlines, work processes, tool calibration, anything outside the
document), answer exactly "${NOT_CHECKABLE_PREFIX} <brief reason>" and
nothing else.

OUTPUT: only the XML fragment — no markdown, no explanation, no XML
declaration. Write any human-readable text inside the rule in the same
language as the Proposal.

BRDP:
ID: ${brdp.identifier}
Title: ${brdp.title}
Definition: ${brdp.definition}
Proposal: ${brdp.proposal}`;

  return prompt;
}

// Everything Copy prompt puts on the clipboard: one block, ready to paste
// into another LLM (system prompt, then the fixed user message).
export function buildCopyablePrompt(systemPrompt) {
  return `${systemPrompt}\n\n${SUGGEST_RULE_USER_MESSAGE}`;
}

// { notCheckable: string } | { xml: string } -- strips a markdown fence and
// an XML declaration if the model added them anyway.
export function parseSuggestRuleResponse(raw) {
  let text = (raw || '').trim();
  text = text.replace(/^```(?:xml)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  if (text.startsWith(NOT_CHECKABLE_PREFIX)) {
    return { notCheckable: text.slice(NOT_CHECKABLE_PREFIX.length).trim() };
  }
  text = text.replace(/^<\?xml[^>]*\?>\s*/, '');
  return { xml: text };
}
