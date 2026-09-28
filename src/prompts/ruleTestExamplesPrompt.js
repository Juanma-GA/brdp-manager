// Test rule (T2 of 4, T2b): the system prompt that asks the LLM for short
// aeronautical examples -- one that follows the Proposal's DECISION and one
// that goes against it (plus one of another schema for a context-scoped
// rule). T3b: the examples follow the decision, not the rule -- examples
// written from the rule followed a wrong rule too, so the test never caught
// it -- and the LLM no longer explains the rule (describeRule does,
// deterministically); it only flags a rule that does not seem to implement
// the Proposal.
// Pure function, same architecture as the other prompts: the application,
// not the LLM, builds each example on a real skeleton of its schema
// (utils/ruleTestSkeleton.js; T2b: the LLM only writes the content of the
// insertion point), checks it, runs the rule on it (utils/ruleTestEngine.js)
// and gives the verdict.
import { buildSchemaFactsBlock } from './shared.js';

export const RULE_TEST_USER_MESSAGE = 'Write the test examples for this rule.';

// Elements that only reference or group other content: an LLM put text in
// a <dmRef> in the first real run, and the structural check cannot see text,
// so the rule is stated in the prompt.
const NO_TEXT_ELEMENTS = '<dmRef>, <dmRefIdent>, <dmCode>, <internalRef>, <pmRef>, <externalPubRef>';

function schemaInstructions(contextSchemas, placements) {
  const rulePlacement = placements.find((p) => p.role === 'rule');
  const other = placements.find((p) => p.role === 'other');
  if (!contextSchemas || contextSchemas.length === 0) {
    return `The rule is general: every example uses the "${rulePlacement.schema}" schema
("schema": "${rulePlacement.schema}").`;
  }
  const list = contextSchemas.join(', ');
  let text = `The rule applies ONLY to documents of the ${list} schema${contextSchemas.length > 1 ? 's' : ''}. Every
example that tests the rule uses "schema": "${rulePlacement.schema}".`;
  if (other) {
    text += `
Add a third example of the ${other.schema} schema ("schema": "${other.schema}",
"expected": "accept") whose content has what the rule checks, to show that
the rule does not apply there.`;
  }
  return text;
}

function placementLine(p) {
  const allowed = p.allowedChildren.length > 0 ? p.allowedChildren.join(', ') : 'text only';
  return `- schema "${p.schema}": your content goes directly inside <${p.insertion}>, at
  ${p.path.join('/')}.
  Allowed directly inside <${p.insertion}> in this schema: ${allowed}.`;
}

// `input`: { brdp, standard, format, ruleXml, contextSchemas, placements,
// schemaFacts, previousReview } -- contextSchemas are the schemas of the
// rule's context blocks ([] for a general rule); placements (T2b) say where
// each offered schema takes the LLM's content: [{ schema, role: 'rule' |
// 'other', path, insertion, allowedChildren }]; schemaFacts the cards of the
// rule's element names (as for Ask / Suggest Rule); previousReview (T3b,
// "Review with the assistant" found the examples at fault): { explanation,
// mismatches: [{ label, expected, got, content }] } -- the regeneration must
// not repeat that mistake.
export function buildRuleTestExamplesPrompt({ brdp, standard, format, ruleXml, contextSchemas = [], placements = [], schemaFacts = [], previousReview = null }) {
  const hasFacts = schemaFacts && schemaFacts.length > 0;
  const namesLine = hasFacts
    ? `use only element and attribute names that appear in
  the rule, in the lists above or in the SCHEMA FACTS below`
    : `use only real ${standard} element and attribute names —
  the rule's own names and the lists above; never invent a name`;

  let prompt = `You write test examples for one ${standard} business rule, in BRDP Manager's
"Test rule". The application runs the rule itself on each example and
decides whether the example is accepted or rejected. You never judge the
rule: you only write the examples.

The decision (BRDP ${brdp.identifier}) — the examples test THIS:
Title: ${brdp.title}
Definition: ${brdp.definition}
Proposal: ${brdp.proposal}

The rule under test (${format}) — use it only to know which elements,
attributes and schemas are involved:
${ruleXml}

WHAT TO WRITE:
- "proposalMismatch": null when the rule implements the Proposal's decision.
  When it does not seem to, one short sentence in the same language as the
  Proposal saying why — for example: "This rule does not seem to implement
  the Proposal (the Proposal is about CAGE codes; the rule checks
  <emphasis>)." It is only an indication, so keep it short.
- "examples": at least two examples, written from the Proposal's DECISION,
  never from the rule: one that follows the decision ("expected": "accept")
  and one that goes against it ("expected": "reject"). If the rule does not
  implement the decision, the examples still follow the decision — finding
  that out is what the test is for.
- A restriction on values does not make an attribute or element mandatory:
  an example without the attribute or element follows the decision unless
  the Proposal says it is required. The reject example goes against exactly
  what the Proposal decides (for example a value the Proposal does not
  allow), never against something the Proposal does not mention.
${schemaInstructions(contextSchemas, placements)}

HOW EACH EXAMPLE IS BUILT: the application builds a real ${standard} document
of the example's schema and puts your "content" at one fixed point. Write
ONLY that content — never the element it goes into, never the elements
around it, never the document root.
${placements.map(placementLine).join('\n')}

EACH EXAMPLE:
- A short piece of an aircraft maintenance manual: maintenance steps,
  removal of components, torque values and the like. In English, at most 10
  lines of content.
- Real ${standard} markup: ${namesLine}. Every
  element only inside a parent that allows it, every attribute only on an
  element that has it.
- Never put text directly inside an element that only references or groups
  other content (${NO_TEXT_ELEMENTS}): give it its child
  elements and attributes instead.
- The reject example goes against the decision in one clear way; the
  accept example is otherwise similar, so the difference is easy to see.
- No customer data, no real manufacturer names, part numbers or CAGE codes.
- "label": a few words saying what the example shows.`;

  prompt += buildSchemaFactsBlock(standard, schemaFacts);

  if (previousReview) {
    const lines = previousReview.mismatches.map(
      (m) => `- "${m.label}" (expected ${m.expected}, the rule ${m.got} it):\n  ${m.content}`
    );
    prompt += `

PREVIOUS EXAMPLES WERE WRONG: a review of the last test found that these
examples, not the rule, caused its failure:
${lines.join('\n')}
Diagnosis: ${previousReview.explanation}
Write new examples that do not repeat this mistake.`;
  }

  const firstSchema = placements[0]?.schema || 'descript';
  prompt += `

OUTPUT: strict JSON only — no markdown, no comments, nothing before or after:
{"proposalMismatch": null, "examples": [{"label": "…", "expected": "accept", "schema": "${firstSchema}", "content": "…"}]}`;
  return prompt;
}

// T2b, the one automatic correction round: the exact problems of each
// failing example, sent as the next user message after the LLM's first
// answer. `failures`: [{ index (0-based), label, problems: [English] }].
export function buildRuleTestCorrectionMessage(failures) {
  const blocks = failures.map(
    (f) => `Example ${f.index + 1} ("${f.label}"):\n${f.problems.map((p) => `- ${p}`).join('\n')}`
  );
  return `Some examples are not valid. Fix exactly these problems and
return the complete JSON again: the same examples in the same order with the same "expected" and "schema" — change only the
"content" of the examples listed.

${blocks.join('\n\n')}`;
}

// Everything "Copy test prompt" puts on the clipboard.
export function buildCopyableTestPrompt(systemPrompt) {
  return `${systemPrompt}\n\n${RULE_TEST_USER_MESSAGE}`;
}

// { ok: true, proposalMismatch, examples } | { ok: false, error } -- tolerant of a
// markdown fence and of text around the JSON object, strict about its shape.
// An "explanation" (asked for until T3b) is ignored: the panel shows
// describeRule's instead.
export function parseRuleTestResponse(raw) {
  let text = (raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1) return { ok: false, error: 'The answer contains no JSON object.' };
  // No closing brace (a truncated answer) still reaches JSON.parse, which
  // says what is wrong.
  text = end > start ? text.slice(start, end + 1) : text.slice(start);
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `The answer is not valid JSON (${err.message}).` };
  }
  const proposalMismatch =
    typeof data.proposalMismatch === 'string' && data.proposalMismatch.trim() ? data.proposalMismatch.trim() : null;
  if (!Array.isArray(data.examples) || data.examples.length === 0) {
    return { ok: false, error: 'The answer has no "examples" list.' };
  }
  const examples = [];
  for (const [i, ex] of data.examples.entries()) {
    const where = `Example ${i + 1}`;
    if (!ex || typeof ex !== 'object') return { ok: false, error: `${where} is not an object.` };
    if (ex.expected !== 'accept' && ex.expected !== 'reject') {
      return { ok: false, error: `${where} has "expected" = ${JSON.stringify(ex.expected)} (must be "accept" or "reject").` };
    }
    // T2b: the content of the insertion point ("xml" accepted from an
    // answer that still uses the old field name).
    const content = typeof ex.content === 'string' ? ex.content : ex.xml;
    if (typeof content !== 'string' || !content.trim()) return { ok: false, error: `${where} has no "content".` };
    if (ex.schema !== undefined && ex.schema !== null && typeof ex.schema !== 'string') {
      return { ok: false, error: `${where} has a "schema" that is not text or null.` };
    }
    examples.push({
      label: typeof ex.label === 'string' && ex.label.trim() ? ex.label.trim() : where,
      expected: ex.expected,
      schema: ex.schema && ex.schema !== 'null' ? ex.schema : null,
      content: content.trim(),
    });
  }
  return { ok: true, proposalMismatch, examples };
}
