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
import { metadataXml } from '../utils/ruleTestSkeleton.js';

export const RULE_TEST_USER_MESSAGE = 'Write the test examples for this rule.';

// Elements that only reference or group other content: an LLM put text in
// a <dmRef> in the first real run, and the structural check cannot see text,
// so the rule is stated in the prompt.
const NO_TEXT_ELEMENTS = '<dmRef>, <dmRefIdent>, <dmCode>, <internalRef>, <pmRef>, <externalPubRef>';

function schemaInstructions(contextSchemas, placements, dita) {
  const rulePlacement = placements.find((p) => p.role === 'rule');
  const other = placements.find((p) => p.role === 'other');
  const groups = placements.filter((p) => p.role === 'rule' && p.group);
  if (groups.length > 1) {
    // One schema per part of the rule (chooseTestSchemas' groups): the parts
    // look at elements that live in different schemas (topic types in DITA).
    const kind = dita ? 'topic type' : 'schema';
    const lines = groups.map(
      (p) => `- "${p.schema}": for ${p.group.map((n) => `<${n}>`).join(', ')}`
    );
    return `The rule's parts look at elements that live in different ${kind}s, so the
examples are split by ${kind}. For EACH of these ${kind}s write at least one
example that follows the decision and one that goes against it, each with
its "schema", and write in each only about the elements of its ${kind}:
${lines.join('\n')}`;
  }
  if (dita) {
    return `Every example is a DITA ${rulePlacement.schema} ("schema": "${rulePlacement.schema}").`;
  }
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

// The minimal identification and status section, indented under a line.
function minimalSection(p) {
  return metadataXml(p.metadata.tree, 2).xml;
}

// Rule test on DM metadata: the rule looks at the data module's
// identification and status section, so the LLM writes that whole section
// for every example (its "metadata"), starting from the minimal one.
// `alsoContent`: the rule looks at the content too, so a reject example may
// break the decision in either place.
function metadataLine(p, alsoContent = false) {
  const element = p.metadata.element;
  const where = alsoContent
    ? `; a reject example may go against the decision here, in the content, or
  both:`
    : ` — the values of the reject example go
  HERE, never in a reference (<dmRef>) of the content:`;
  return `  The rule ${alsoContent ? 'also ' : ''}looks at the data module's identification and status section:
  your "metadata" is the WHOLE <${element}> of the example, written
  directly inside <${p.root}>. Start from this minimal, valid one and change
  only what the decision is about${where}
${minimalSection(p)}`;
}

function placementLine(p, dita) {
  const allowed = p.allowedChildren.length > 0 ? p.allowedChildren.join(', ') : 'text only';
  const kind = dita ? 'topic type' : 'schema';
  const titled = p.titled || [];
  if (!p.insertion) {
    // T4: the rule checks the document's root element. T4b: a topic's
    // <title> is mandatory, so the LLM writes it here.
    return `- ${kind} "${p.schema}": your content is the WHOLE document — the complete
  <${p.root}> root element with everything inside it.${
      titled.includes(p.root) ? `
  <${p.root}> starts with its required <title>.` : ''
    }${
      p.metadata ? `
  <${p.root}> starts with its identification and status section; start from
  this minimal, valid one:
${minimalSection(p)}` : ''
    }
  Allowed directly inside <${p.root}>: ${allowed}.`;
  }
  if (p.metadata?.insertion && p.contentInsertion === false) {
    return `- ${kind} "${p.schema}": the application builds the rest of the document
  (${p.path.join('/')}); write no "content".
${metadataLine(p)}`;
  }
  // T4b: the skeleton's own <title> (a DITA topic's, mandatory).
  const titleLine =
    titled.length > 0
      ? `
  The application already writes the <title> of ${titled.map((n) => `<${n}>`).join(', ')}; never write another one there.`
      : '';
  return `- ${kind} "${p.schema}": your content goes directly inside <${p.insertion}>, at
  ${p.path.join('/')}.${titleLine}
  Allowed directly inside <${p.insertion}> in this ${kind}: ${allowed}.${
    p.metadata?.insertion ? `
${metadataLine(p, true)}` : ''
  }`;
}

// T4b: a rule whose context depends on the title of an element (for example
// *[title = ('A', 'B')]//table) only runs on content under an element with
// that title. In a real run the LLM put the title on the table itself
// (table/title), so nothing matched and the test was inconclusive. The
// example here is generic on purpose (never a real project's titles).
const TITLE_DEPENDENT_RE = /\[[^\]]*(?<![@\w:$-])title\b/;

export function ruleDependsOnTitle(matchExpressions = []) {
  return matchExpressions.some((e) => TITLE_DEPENDENT_RE.test(e));
}

function titleDependentInstructions() {
  return `

THE RULE DEPENDS ON A TITLE: it only runs on content under an element whose
<title> has a given value. In every example that must be checked, create
inside your content an element that takes a title — for example a
<section> — give it that <title>, and put the checked content inside it:
  <section><title>Parts list</title><table>…</table></section>
Never put that title on the checked element itself (never <table><title>…),
and never rely on the topic's own title.`;
}

// T4: how each example is built, for the placements offered.
function buildingInstructions(standard, placements, dita) {
  const kind = dita ? 'topic type' : 'schema';
  if (placements.every((p) => !p.insertion)) {
    return `HOW EACH EXAMPLE IS BUILT: the rule checks the document's root element, so
your "content" is the whole ${standard} document of the example's ${kind}:
write the complete root element.
${placements.map((p) => placementLine(p, dita)).join('\n')}`;
  }
  return `HOW EACH EXAMPLE IS BUILT: the application builds a real ${standard} document
of the example's ${kind} and puts your "content" at one fixed point. Write
ONLY that content — never the element it goes into, never the elements
around it, never the document root.
${placements.map((p) => placementLine(p, dita)).join('\n')}`;
}

// `input`: { brdp, standard, format, ruleXml, contextSchemas, placements,
// schemaFacts, previousReview, matchExpressions } -- matchExpressions (T4b)
// are the rule's match expressions (ruleMatchExpressions), used to tell a
// title-dependent context; contextSchemas are the schemas of the
// rule's context blocks ([] for a general rule); placements (T2b) say where
// each offered schema takes the LLM's content: [{ schema, role: 'rule' |
// 'other', path, insertion, allowedChildren }]; schemaFacts the cards of the
// rule's element names (as for Ask / Suggest Rule); previousReview (T3b,
// "Review with the assistant" found the examples at fault): { explanation,
// mismatches: [{ label, expected, got, content }] } -- the regeneration must
// not repeat that mistake.
export function buildRuleTestExamplesPrompt({
  brdp,
  standard,
  format,
  ruleXml,
  contextSchemas = [],
  placements = [],
  schemaFacts = [],
  previousReview = null,
  matchExpressions = [],
}) {
  // T4: a DITA Schematron rule -- topic types instead of schemas, naval or
  // aircraft content, and no S1000D reference elements.
  const dita = format === 'SCH-DITA';
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
${schemaInstructions(contextSchemas, placements, dita)}

${buildingInstructions(standard, placements, dita)}

EACH EXAMPLE:
- A short piece of ${dita ? 'a ship or aircraft maintenance manual' : 'an aircraft maintenance manual'}: maintenance steps,
  removal of components, torque values and the like. In English, at most 10
  lines of content.
- Real ${standard} markup: ${namesLine}. Every
  element only inside a parent that allows it, every attribute only on an
  element that has it.${
    dita
      ? ''
      : `
- Never put text directly inside an element that only references or groups
  other content (${NO_TEXT_ELEMENTS}): give it its child
  elements and attributes instead.`
  }
- The reject example goes against the decision in one clear way; the
  accept example is otherwise similar, so the difference is easy to see.
- No customer data, no real manufacturer names, part numbers or CAGE codes.
- "label": a few words saying what the example shows.`;

  if (ruleDependsOnTitle(matchExpressions)) prompt += titleDependentInstructions();

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
  // Rule test on DM metadata: "metadata" (the whole section) when the rule
  // looks at it; no "content" when it looks at nothing else.
  const withMetadata = placements.some((p) => p.insertion && p.metadata?.insertion);
  const withContent = placements.some((p) => !p.insertion || p.contentInsertion !== false);
  const fields = [
    withMetadata ? `"metadata": "<${placements.find((p) => p.metadata?.insertion).metadata.element}>…"` : null,
    withContent ? '"content": "…"' : null,
  ].filter(Boolean);
  prompt += `

OUTPUT: strict JSON, no comments:
{"proposalMismatch": null, "examples": [{"label": "…", "expected": "accept", "schema": "${firstSchema}", ${fields.join(', ')}}]}`;
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
"content" (and "metadata", if it has one) of the examples listed.

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
    // answer that still uses the old field name). Rule test on DM
    // metadata: "metadata", the whole identification and status section;
    // an example may then have no content at all.
    const content = typeof ex.content === 'string' ? ex.content : typeof ex.xml === 'string' ? ex.xml : '';
    const metadata = typeof ex.metadata === 'string' ? ex.metadata.trim() : '';
    if (!content.trim() && !metadata) return { ok: false, error: `${where} has no "content".` };
    if (ex.schema !== undefined && ex.schema !== null && typeof ex.schema !== 'string') {
      return { ok: false, error: `${where} has a "schema" that is not text or null.` };
    }
    examples.push({
      label: typeof ex.label === 'string' && ex.label.trim() ? ex.label.trim() : where,
      expected: ex.expected,
      schema: ex.schema && ex.schema !== 'null' ? ex.schema : null,
      content: content.trim(),
      ...(metadata ? { metadata } : {}),
    });
  }
  return { ok: true, proposalMismatch, examples };
}
