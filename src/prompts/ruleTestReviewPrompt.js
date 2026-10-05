// Test de reglas T3b, Part 3: "Review with the assistant". When the test
// verdict is incorrect, the LLM is asked whether the fault is in the RULE
// or in the EXAMPLES -- given the Proposal, the rule, what the rule checks
// (describeRule's deterministic description, never the LLM's reading of
// the XML) and each example whose result did not match. Pure function, same
// architecture as the other prompts. The answer is shown as indicative and
// never changes the recorded test result.

import { readLlmJson } from './llmJson.js';

export const RULE_TEST_REVIEW_USER_MESSAGE = 'Review this failed rule test.';
const REVIEW_CAUSES = ['example', 'rule', 'unclear'];

// `input`: { brdp, standard, format, ruleXml, ruleDescription (English
// text, one "- " line per statement), mismatches: [{ label, expected,
// got ('accepted' | 'rejected'), xml }] }.
export function buildRuleTestReviewPrompt({ brdp, standard, format, ruleXml, ruleDescription, mismatches }) {
  const blocks = mismatches.map(
    (m, i) => `Example ${i + 1} ("${m.label}"): expected ${m.expected === 'reject' ? 'rejected' : 'accepted'}, the rule ${m.got} it.
${m.xml}`
  );
  return `You review a failed test of one ${standard} business rule in BRDP Manager's
"Test rule". The application wrote examples from the decision below, ran
the rule on them, and some results did not match what the example
expected. Decide whether the fault is in the RULE or in the EXAMPLES.

The decision (BRDP ${brdp.identifier}):
Title: ${brdp.title}
Definition: ${brdp.definition}
Proposal: ${brdp.proposal}

The rule (${format}):
${ruleXml}

What the rule checks (computed by the application from its XML — exact):
${ruleDescription}

The examples whose result did not match:
${blocks.join('\n\n')}

HOW TO DECIDE:
- "rule": the rule does not implement the Proposal's decision — it lets
  through what the decision forbids, or rejects what the decision allows.
- "example": the rule implements the decision and the example is wrong —
  for example, it expects a rejection for something the Proposal does not
  decide (a missing attribute when the Proposal only restricts its values),
  or it does not really follow or break the decision.
- "unclear": you cannot tell from the Proposal.
Judge against the Proposal, not against the example's label.

OUTPUT: strict JSON:
{"cause": "example" | "rule" | "unclear", "explanation": "…"}
"explanation": two or three sentences in the same language as the Proposal,
for a technical publications author.`;
}

// { ok: true, cause, explanation } | { ok: false, error } -- tolerant of a
// markdown fence and of text around the JSON object, strict about its shape.
export function parseRuleTestReviewResponse(raw) {
  const read = readLlmJson(raw);
  if (!read.ok && read.reason === 'no_object') return { ok: false, error: 'The answer contains no JSON object.' };
  if (!read.ok) return { ok: false, error: `The answer is not valid JSON (${read.message}).` };
  const { data } = read;
  if (!REVIEW_CAUSES.includes(data.cause)) {
    return { ok: false, error: `The answer has "cause" = ${JSON.stringify(data.cause)} (must be "example", "rule" or "unclear").` };
  }
  if (typeof data.explanation !== 'string' || !data.explanation.trim()) {
    return { ok: false, error: 'The answer has no "explanation" text.' };
  }
  return { ok: true, cause: data.cause, explanation: data.explanation.trim() };
}

// The mismatched examples of a test run, in the shape the review prompt and
// the "PREVIOUS …" blocks of the other prompts take.
export function mismatchedExamples(examples, runs) {
  return examples
    .map((ex, i) => ({ ex, run: runs[i] }))
    .filter(({ run }) => run?.matches === false)
    .map(({ ex, run }) => ({
      label: ex.label,
      expected: ex.expected,
      got: run.result.status,
      content: ex.content,
      xml: ex.xml || ex.content,
    }));
}
