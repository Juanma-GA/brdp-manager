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
import { extractRuleNames } from './ruleNameCheck.js';
import { contextSchemasOfRule } from './ruleSchemaContext.js';
import { parseXmlDocument } from './ruleTestEngine.js';
import { chooseTestSchemas, placeExample, ruleTargets } from './ruleTestSkeleton.js';
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
  try {
    const res = await fetchSchemaCards(standard, lookup);
    cards = res.cards || {};
    documentSchemas = res.document_schemas || [];
  } catch {
    // no facts
  }
  const schemaFacts = factNames.filter((n) => cards[n]).map((name) => ({ name, entry: cards[name] }));
  const { testSchema, otherSchema } = chooseTestSchemas({ contextSchemas, documentSchemas, cards, targets });
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
    // each failing example go back to the LLM once. What still fails is
    // shown as it is, with its warnings -- never dropped.
    const failures = runs
      .map((r, index) => ({
        index,
        label: examples[index].label,
        problems: r.validation.runnable ? [] : exampleProblems(r.validation, { standard, schema: materialized[index].schema }),
      }))
      .filter((f) => f.problems.length > 0);
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
          correction.fixed = failures.filter((f) => rerun.runs[f.index]?.validation.runnable).length;
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
