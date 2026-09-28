// Suggest Rule's system prompt (docs request, Suggest Rule round) -- pure
// function, same architecture as the other Suggest prompts: built ENTIRELY
// from /similar?kind=rule's structured groups and GET /api/schema-cards,
// so the reference list the UI shows is exactly what the LLM saw.
//
// A rule IMPLEMENTS a decision already taken: Suggest Rule is only offered
// once the Proposal is Validated and has no unfilled [PLACEHOLDER] left.
// Schema context (Suggest Rule part 2): S1000D rules can be limited to some
// schemas. The LLM still writes only the inner rule (format rule 1); the app
// wraps it in one context block per chosen schema
// (utils/ruleSchemaContext.js). Precedents keep their context blocks and
// say which schemas they apply to.
import { buildSchemaFactsBlock } from './shared.js';
import { ruleFormatRules } from './ruleFormatRules.js';
import { contextSchemasOfRule } from '../utils/ruleSchemaContext.js';

export const SUGGEST_RULE_USER_MESSAGE = 'Write the rule for this BRDP.';

// The exact prefix the model must answer with when the decision can't be
// verified on the XML -- parsed by parseSuggestRuleResponse below.
export const NOT_CHECKABLE_PREFIX = 'NOT_CHECKABLE:';

// "Applies to" line of a precedent that has context blocks; '' for a plain
// general rule (unchanged precedent layout).
function appliesToLine(ruleXml) {
  const { schemas, general } = contextSchemasOfRule(ruleXml);
  if (schemas.length === 0) return '';
  const scoped = `only the ${schemas.join(', ')} schema${schemas.length > 1 ? 's' : ''}`;
  return general
    ? `\nApplies to: every schema for the rule outside the context blocks; ${scoped} for the rules inside them`
    : `\nApplies to: ${scoped}`;
}

function precedentLines(candidates, withSource) {
  return candidates
    .map((c) => {
      const head = withSource && c.source ? `[${c.identifier} | ${c.source}]` : `[${c.identifier}]`;
      return `${head}${appliesToLine(c.text)}\nProposal: ${c.proposal}\nRule:\n${c.text}`;
    })
    .join('\n\n');
}

function scopeText(schemaContext, format) {
  const schemas = schemaContext?.schemas || [];
  if (schemas.length === 0) {
    return `The rule applies to every schema (it is a general rule,
not tied to one document type).`;
  }
  const list = schemas.join(', ');
  const path = format === 'BREX-3.0.1' ? 'objpath' : 'objectPath';
  const use = format === 'BREX-3.0.1' ? 'objuse' : 'objectUse';
  // A real Mistral run (3.0.1, descript chosen) wrote
  // //emphasis[ancestor-or-self::descript] -- filtering by schema inside the
  // path although the app already wraps the rule in the schema's block. The
  // example uses invented names so it can't be copied into a real rule.
  return `The rule applies ONLY to documents written against the
schema${schemas.length > 1 ? 's' : ''} ${list}. The application places your rule inside one context block per
schema itself — write only the rule element described below, never a
context block. <${use}> may name the schema${schemas.length > 1 ? 's' : ''} it applies to.
Because the application adds the schema context, write <${path}> exactly as
you would for any document: no predicate or step that filters by schema or
document type. Example (invented names, not from this BRDP):
   Correct: //acmeElement
   Wrong:   //acmeElement[ancestor::acmeSchema]
   Wrong:   //acmeSchema//acmeElement`;
}

// `references` is { sameBrdp, similar, formatExamples } -- formatExamples
// being /similar's standard_fallback followed by template_fallback.
// `schemaContext` (optional): { schemas: [...] } -- the schemas the user
// limited the rule to; absent or empty = a general rule.
// `failedTest` (Test de reglas T3b, "Suggest a corrected rule"): { ruleXml,
// mismatches: [{ label, expected, got, xml }], diagnosis } -- the previous
// rule, the test examples it got wrong and the review's diagnosis, so the
// new rule fixes exactly that.
export function buildSuggestRulePrompt(brdp, standard, format, references, schemaFacts, schemaContext = null, failedTest = null) {
  const { sameBrdp = [], similar = [], formatExamples = [] } = references;

  let prompt = `You are an expert in ${standard} business rules (BRDPs — Business Rule
Decision Points), assisting in BRDP Manager.

TASK: implement, as ONE ${schemaContext?.schemas?.length ? '' : 'general '}rule in the ${standard} rule format below,
the decision already taken in the BRDP's Proposal. Do not change the
decision, do not widen or narrow it, and do not add checks the Proposal
does not ask for. ${scopeText(schemaContext, format)}

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

  const allPrecedents = [...sameBrdp, ...similar, ...formatExamples];
  if (allPrecedents.some((c) => contextSchemasOfRule(c.text).schemas.length > 0)) {
    prompt += `

CONTEXT BLOCKS: some rules below sit inside a context block
(<contextRules rulesContext="…"> / <contextrules context="…">). The block only
limits them to the schema named in its URL — see each rule's "Applies to"
line. Never output a context block yourself.`;
  }

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

  if (failedTest) {
    const lines = failedTest.mismatches.map(
      (m) => `- "${m.label}" (expected ${m.expected === 'reject' ? 'rejected' : 'accepted'}, the rule ${m.got} it):\n${m.xml}`
    );
    prompt += `

PREVIOUS RULE FAILED ITS TEST: this rule was written for this BRDP before,
and a review of its test found the RULE at fault:
${failedTest.ruleXml}
Test examples it got wrong:
${lines.join('\n')}
Diagnosis: ${failedTest.diagnosis}
Write a corrected rule that implements the Proposal's decision and gets these
examples right. Do not copy the previous rule's mistake.`;
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
