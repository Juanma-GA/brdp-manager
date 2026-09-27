// Test rule (T2 of 4): the system prompt that asks the LLM for short
// aeronautical example fragments -- one that complies with the rule and one
// that breaks it (plus one of another schema for a context-scoped rule).
// Pure function, same architecture as the other prompts: the application,
// not the LLM, then runs the rule on each example (utils/ruleTestEngine.js)
// and gives the verdict.
import { buildSchemaFactsBlock } from './shared.js';
import { extractRuleXPaths } from '../utils/ruleNameCheck.js';

export const RULE_TEST_USER_MESSAGE = 'Write the test examples for this rule.';

// Mandatory-node rules can only be judged on a whole document (engine), so
// the examples must be whole documents too.
function hasMandatoryFlag(ruleXml) {
  return /\b(allowedObjectFlag|objappl)\s*=\s*["']1["']/.test(ruleXml || '');
}

// The root names of the rule's absolute paths ("/dmodule/content/…" →
// "dmodule"), for the "start the fragment at that element" instruction.
function absoluteRoots(ruleXml) {
  const roots = new Set();
  for (const expression of extractRuleXPaths(ruleXml || '')) {
    for (const m of expression.matchAll(/(?:^|[\s([|,=])\/(?!\/)\s*([A-Za-z_][\w.-]*)/g)) roots.add(m[1]);
  }
  return [...roots];
}

function schemaInstructions(contextSchemas, otherSchema) {
  if (!contextSchemas || contextSchemas.length === 0) {
    return `The rule is general (it applies to every schema): set "schema" to null in
every example.`;
  }
  const list = contextSchemas.join(', ');
  const first = contextSchemas[0];
  let text = `The rule applies ONLY to documents of the ${list} schema${contextSchemas.length > 1 ? 's' : ''}. Every
example that tests the rule is a fragment of that schema: set "schema" to
"${first}"${contextSchemas.length > 1 ? ` (or another of: ${list})` : ''}.`;
  if (otherSchema) {
    text += `
Add a third example from the ${otherSchema} schema ("schema": "${otherSchema}",
"expected": "accept") that contains what the rule checks, to show that the
rule does not apply there.`;
  }
  return text;
}

// `input`: { brdp, standard, format, ruleXml, contextSchemas, otherSchema,
// schemaFacts } -- contextSchemas are the schemas of the rule's context
// blocks ([] for a general rule), otherSchema the schema the third example
// uses (null when there is none), schemaFacts the cards of the rule's
// element names (as for Ask / Suggest Rule).
export function buildRuleTestExamplesPrompt({ brdp, standard, format, ruleXml, contextSchemas = [], otherSchema = null, schemaFacts = [] }) {
  const roots = absoluteRoots(ruleXml);
  const ancestorLine =
    roots.length > 0
      ? `The rule's path is absolute: each example starts with the element the path
  starts with (<${roots.join('>, <')}>) and keeps every element on the way down.`
      : 'Include every ancestor element the rule\'s path needs to reach the checked node.';
  const mandatoryLine = hasMandatoryFlag(ruleXml)
    ? `
- The rule makes a node mandatory: each example is a complete document
  starting at its root element (for example <dmodule>).`
    : '';

  const hasFacts = schemaFacts && schemaFacts.length > 0;
  const namesLine = hasFacts
    ? `use only element and attribute names that appear in
  the rule or in the SCHEMA FACTS below, with correct parents and children.`
    : `use only real ${standard} element and attribute names —
  the rule's own names and the elements that really contain them — with
  correct parents and children. Never invent a name.`;

  let prompt = `You write test examples for one ${standard} business rule, in BRDP Manager's
"Test rule". The application runs the rule itself on each example and
decides whether the example is accepted or rejected. You never judge the
rule: you only write the examples.

The rule (${format}):
${ruleXml}

The decision it implements (BRDP ${brdp.identifier}):
Title: ${brdp.title}
Definition: ${brdp.definition}
Proposal: ${brdp.proposal}

WHAT TO WRITE:
- "explanation": one or two sentences, in the same language as the Proposal,
  saying what the rule checks, for a technical publications author.
- "examples": at least two examples: one that complies with the decision
  ("expected": "accept") and one that breaks it ("expected": "reject").
${schemaInstructions(contextSchemas, otherSchema)}

EACH EXAMPLE:
- A short fragment of an aircraft maintenance manual: maintenance steps,
  warnings and cautions, removal of components, torque values and the like.
  In English, at most 10 lines.
- Real ${standard} markup: ${namesLine}
- ${ancestorLine}${mandatoryLine}
- The reject example breaks the decision in one clear way; the accept example
  is otherwise similar, so the difference is easy to see.
- No customer data, no real manufacturer names, part numbers or CAGE codes.
- "label": a few words saying what the example shows.`;

  prompt += buildSchemaFactsBlock(standard, schemaFacts);

  prompt += `

OUTPUT: strict JSON only — no markdown, no comments, nothing before or after:
{"explanation": "…", "examples": [{"label": "…", "expected": "accept", "schema": null, "xml": "…"}]}`;
  return prompt;
}

// Everything "Copy test prompt" puts on the clipboard.
export function buildCopyableTestPrompt(systemPrompt) {
  return `${systemPrompt}\n\n${RULE_TEST_USER_MESSAGE}`;
}

// { ok: true, explanation, examples } | { ok: false, error } -- tolerant of a
// markdown fence and of text around the JSON object, strict about its shape.
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
  if (typeof data.explanation !== 'string') return { ok: false, error: 'The answer has no "explanation" text.' };
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
    if (typeof ex.xml !== 'string' || !ex.xml.trim()) return { ok: false, error: `${where} has no "xml".` };
    if (ex.schema !== undefined && ex.schema !== null && typeof ex.schema !== 'string') {
      return { ok: false, error: `${where} has a "schema" that is not text or null.` };
    }
    examples.push({
      label: typeof ex.label === 'string' && ex.label.trim() ? ex.label.trim() : where,
      expected: ex.expected,
      schema: ex.schema && ex.schema !== 'null' ? ex.schema : null,
      xml: ex.xml.trim(),
    });
  }
  return { ok: true, explanation: data.explanation.trim(), examples };
}
