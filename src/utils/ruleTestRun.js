// Test rule: one generation of examples, from the rule to the engine runs --
// shared by the panel (hooks/useRuleTest.js) and the prompt eval harness
// (scripts/run-prompt-eval.mjs, type "rule-test"), so the eval measures
// exactly what the application does. Pure apart from the injected I/O:
//   ask(messages) → the LLM's text (the panel: sendMessage; the eval: the
//                   real /api/llm-proxy), at RULE_TEST_TEMPERATURE
//   fetchSchemaCards(standard, names) → GET /api/schema-cards response
//   fetchStructure(standard, schema) → GET /api/schema-cards/structure response
//   parseXml(text) → Document (browser default: DOMParser)
// Steps (T2b): the schema(s) and skeleton the examples are built on, the
// prompt, the LLM's answer, the checks of each example, ONE automatic
// correction round for the examples that fail them, and the engine run.
import { buildRuleTestCorrectionMessage, buildRuleTestExamplesPrompt, parseRuleTestResponse, RULE_TEST_USER_MESSAGE } from '../prompts/ruleTestExamplesPrompt.js';
import { extractRuleNames } from '../validation/schemaValidation.js';
import { contextSchemasOfRule } from './ruleSchemaContext.js';
import { describeRule, parseXmlDocument } from './ruleTestEngine.js';
import { stripLiterals } from './ruleTestCommon.js';
import { chooseTestSchemas, placeExample, ruleMatchExpressions, ruleTargets } from './ruleTestSkeleton.js';
import { exampleProblems, materializeExample, runExample } from './ruleTest.js';

// Same cap as the schema facts of Ask / Suggest Rule.
const MAX_SCHEMA_FACTS = 6;

// The schemas the examples use and where each takes the LLM's content.
export async function prepareRuleTestSetup({ ruleXml, standard, schemaLocation, fetchSchemaCards, fetchStructure }) {
  const contextSchemas = contextSchemasOfRule(ruleXml).schemas;
  const targets = ruleTargets(ruleXml);
  const factNames = extractRuleNames(ruleXml).elements.slice(0, MAX_SCHEMA_FACTS);
  const lookup = [...new Set([...factNames, ...targets.checked, ...targets.absolutePrefixes.map((p) => p[0])])];
  // Schema facts improve the examples but are never required; the schema
  // choice falls back to the standard's preference order without them.
  let cards = {};
  let documentSchemas = [];
  let elementSchemas = null;
  try {
    const res = await fetchSchemaCards(standard, lookup);
    cards = res.cards || {};
    documentSchemas = res.document_schemas || [];
    // DITA (T4): which topic types have each name.
    if (res.element_schemas && Object.keys(res.element_schemas).length) elementSchemas = res.element_schemas;
  } catch {
    // no facts
  }
  const schemaFacts = factNames.filter((n) => cards[n]).map((name) => ({ name, entry: cards[name] }));
  const { testSchema, otherSchema } = chooseTestSchemas({ contextSchemas, documentSchemas, cards, elementSchemas, targets });
  const placements = {};
  const promptPlacements = [];
  for (const [schema, role] of [[testSchema, 'rule'], [otherSchema, 'other']]) {
    if (!schema) continue;
    const structure = await fetchStructure(standard, schema);
    if (!structure.available) continue;
    const placement = placeExample(structure, targets);
    placements[schema] = { structure, placement };
    promptPlacements.push({ schema, role, ...placement });
  }
  if (promptPlacements.length === 0) throw new Error(`No schema structure is available for ${standard}.`);
  return { contextSchemas, schemaFacts, promptPlacements, setup: { standard, schemaLocation, placements } };
}

// T4b: an example meant to be rejected in which the rule selects nothing
// (no node on its paths, no node any Schematron context matches) can never
// be rejected -- the test then ends "inconclusive" although the example
// is valid. It goes to the correction round too, with what it must contain.
export function missesRuleProblem(example, run, ruleXml) {
  if (example.expected !== 'reject' || !run.result || run.result.status === 'not_executable') return null;
  if (run.result.selectedNodePaths.length > 0) return null;
  const matched = ruleMatchExpressions(ruleXml).map((e) => `\`${e}\``).join(' or ');
  return `This example must contain a node matched by: ${matched}. Nothing in it matches, so the rule never runs.`;
}

// C3, Part 1c: a rule that restricts VALUES only shows it accepts a valid
// value when an example meant to be accepted contains a node it selects --
// an accept example without the node is accepted for the wrong reason (the
// rule has nothing to look at). True for:
//   BREX: a part with objectValue / objval (allowedObjectFlag="2" or no
//         objappl: restricted values; flag 1: mandatory with values) --
//         never a prohibition (allowedObjectFlag="0" / objappl="0"), where
//         the correct accept example is precisely the one WITHOUT the node.
//         allowedObjectFlag="2" WITHOUT values restricts no value at all
//         (it rejects nothing; describeRule already warns "cannot reject"),
//         and asking for the node there would contradict a Proposal that
//         forbids it (eval case rule-test-4-2-wrong-rule-flag2), so it is
//         left out;
//   Schematron: an assert / report (not a warning, not a constant) whose
//         test compares a value: = != < > eq ne lt le gt ge, or
//         matches() / contains() / starts-with() / ends-with().
const VALUE_STATEMENTS = new Set([
  'describe_restricted_values',
  'describe_mandatory_values',
  'describe_mandatory_somewhere_values',
]);
const VALUE_TEST_RE = /!=|<|>|(?<![:!<>=])=|\b(?:eq|ne|lt|le|gt|ge)\b|\b(?:matches|contains|starts-with|ends-with)\s*\(/;

export function ruleRestrictsValues(ruleXml, format, parseXml = parseXmlDocument) {
  const description = describeRule(ruleXml, format, { parseXml });
  if (!description.available) return false;
  return description.statements.some(({ statement }) => {
    if (VALUE_STATEMENTS.has(statement.code)) return true;
    if (statement.code !== 'describe_sch_assert' && statement.code !== 'describe_sch_report') return false;
    if (statement.params.warning || statement.params.constant) return false;
    const test = stripLiterals(String(statement.params.test || '')).replace(/=>/g, ' ');
    return VALUE_TEST_RE.test(test);
  });
}

// The accept examples that must be sent back because none of them contains
// a node the value rule selects: every accept example that ran, gave a
// verdict and is in scope (an example of another schema, which the rule
// does not apply to, never counts). None when one of them already has the
// node, or when no accept example ran (the invalid ones are sent back for
// their own problems anyway).
export function acceptWithoutNodeIndices(examples, runs, restrictsValues) {
  if (!restrictsValues) return [];
  const candidates = runs
    .map((r, index) => ({ r, index }))
    .filter(({ r, index }) =>
      examples[index].expected === 'accept' &&
      r.result &&
      r.result.status !== 'not_executable' &&
      !(r.result.outOfScopeSchemas?.length > 0)
    );
  if (candidates.length === 0 || candidates.some(({ r }) => r.result.selectedNodePaths.length > 0)) return [];
  return candidates.map(({ index }) => index);
}

export function acceptWithoutNodeProblem(ruleXml) {
  const matched = ruleMatchExpressions(ruleXml).map((e) => `\`${e}\``).join(' or ');
  return `The rule checks values, so at least one example meant to be accepted must contain a node matched by: ${matched}, with a value the decision allows. No accept example contains one, so the test never shows the rule accepting a valid value.`;
}

// The examples the correction round must fix: [{ index, label, problems }].
export function exampleFailures(examples, materialized, runs, { ruleXml, standard, format = null, parseXml = parseXmlDocument }) {
  const withoutNode = new Set(acceptWithoutNodeIndices(examples, runs, format ? ruleRestrictsValues(ruleXml, format, parseXml) : false));
  return runs
    .map((r, index) => {
      const problems = r.validation.runnable
        ? [missesRuleProblem(examples[index], r, ruleXml), withoutNode.has(index) ? acceptWithoutNodeProblem(ruleXml) : null].filter(Boolean)
        : exampleProblems(r.validation, { standard, schema: materialized[index].schema });
      return { index, label: examples[index].label, problems };
    })
    .filter((f) => f.problems.length > 0);
}

// Materialize, validate and run every example.
export function runRuleTestExamples(examples, { ruleXml, format, setup, vocabulary, parseXml = parseXmlDocument }) {
  const materialized = examples.map((ex) => materializeExample(ex, setup));
  const runs = materialized.map((ex) => runExample(ruleXml, format, ex, { vocabulary, parseXml }));
  return { materialized, runs };
}

// → { status: 'ready', proposalMismatch, examples, runs,
//     correction, setup, systemPrompt, responses }
//   | { status: 'error', error, badResponse?, systemPrompt?, responses? }
//   | null when isCurrent() turned false (a newer generation started).
// onPrompt(systemPrompt) is called as soon as the prompt exists (Copy test
// prompt works even if the LLM then fails).
export async function generateRuleTestExamples({
  ruleXml,
  format,
  standard,
  schemaLocation,
  brdp,
  vocabulary,
  ask,
  fetchSchemaCards,
  fetchStructure,
  parseXml = parseXmlDocument,
  isCurrent = () => true,
  onPrompt,
  previousReview = null,
}) {
  let systemPrompt = null;
  const responses = [];
  try {
    const prepared = await prepareRuleTestSetup({ ruleXml, standard, schemaLocation, fetchSchemaCards, fetchStructure });
    if (!isCurrent()) return null;
    systemPrompt = buildRuleTestExamplesPrompt({
      brdp,
      standard,
      format,
      ruleXml,
      contextSchemas: prepared.contextSchemas,
      placements: prepared.promptPlacements,
      schemaFacts: prepared.schemaFacts,
      previousReview,
      matchExpressions: ruleMatchExpressions(ruleXml),
    });
    onPrompt?.(systemPrompt);
    const run = (examples) => runRuleTestExamples(examples, { ruleXml, format, setup: prepared.setup, vocabulary, parseXml });
    const first = [{ role: 'user', content: RULE_TEST_USER_MESSAGE }];
    const answer = await ask(first, systemPrompt);
    responses.push(answer);
    if (!isCurrent()) return null;
    const parsed = parseRuleTestResponse(answer);
    if (!parsed.ok) {
      // Nothing runs on a broken answer (docs request).
      return { status: 'error', error: parsed.error, badResponse: true, systemPrompt, responses };
    }
    let { examples } = parsed;
    let { materialized, runs } = run(examples);

    // One automatic correction round (T2b, Part 3): the exact problems of
    // each failing example go back to the LLM once -- invalid examples and
    // (T4b) reject examples the rule never runs on. What still fails is
    // shown as it is, with its warnings -- never dropped.
    const failures = exampleFailures(examples, materialized, runs, { ruleXml, standard, format, parseXml });
    let correction = null;
    if (failures.length > 0) {
      correction = { attempted: failures.length, fixed: 0, failed: null };
      try {
        const again = await ask(
          [...first, { role: 'assistant', content: answer }, { role: 'user', content: buildRuleTestCorrectionMessage(failures) }],
          systemPrompt
        );
        responses.push(again);
        if (!isCurrent()) return null;
        const reparsed = parseRuleTestResponse(again);
        if (!reparsed.ok) {
          correction.failed = reparsed.error;
        } else {
          const failing = new Set(failures.map((f) => f.index));
          const next =
            reparsed.examples.length === examples.length
              ? examples.map((ex, i) => (failing.has(i) ? reparsed.examples[i] : ex))
              : reparsed.examples;
          const rerun = run(next);
          const still = new Set(exampleFailures(next, rerun.materialized, rerun.runs, { ruleXml, standard, format, parseXml }).map((f) => f.index));
          correction.fixed = failures.filter((f) => rerun.runs[f.index] && !still.has(f.index)).length;
          examples = next;
          ({ materialized, runs } = rerun);
        }
      } catch (err) {
        if (!isCurrent()) return null;
        correction.failed = err.message;
      }
    }
    return {
      status: 'ready',
      proposalMismatch: parsed.proposalMismatch,
      examples: materialized,
      runs,
      correction,
      setup: prepared.setup,
      systemPrompt,
      responses,
    };
  } catch (err) {
    if (!isCurrent()) return null;
    return { status: 'error', error: err.message, systemPrompt, responses };
  }
}
