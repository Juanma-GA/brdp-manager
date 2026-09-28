// Test rule (T2 of 4, T2b): the panel's state. Everything but the LLM calls
// is deterministic: analyzeRule (what can be known without an example, shown
// from the start), the schema(s) and skeleton the examples are built on
// (GET /api/schema-cards/structure + utils/ruleTestSkeleton.js), the checks
// of each example, one automatic correction round for the examples that fail
// them, and the engine run. Nothing is saved: the examples and any edits
// live only in this component's memory (HR1).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { authFetchJson } from '../services/apiClient';
import { sendMessage } from '../api/llmAPI';
import { fetchSchemaCards } from '../api/schemaFacts.js';
import { RULE_TEST_TEMPERATURE } from '../prompts/shared.js';
import {
  buildCopyableTestPrompt,
  buildRuleTestCorrectionMessage,
  buildRuleTestExamplesPrompt,
  parseRuleTestResponse,
  RULE_TEST_USER_MESSAGE,
} from '../prompts/ruleTestExamplesPrompt.js';
import { extractRuleNames } from '../utils/ruleNameCheck.js';
import { contextSchemasOfRule } from '../utils/ruleSchemaContext.js';
import { analyzeRule } from '../utils/ruleTestEngine.js';
import { chooseTestSchemas, placeExample, ruleTargets } from '../utils/ruleTestSkeleton.js';
import { exampleProblems, materializeExample, runExample, ruleTestVerdict } from '../utils/ruleTest.js';

// Same cap as the schema facts of Ask / Suggest Rule.
const MAX_SCHEMA_FACTS = 6;

async function fetchStructure(standard, schema) {
  return authFetchJson(
    `/api/schema-cards/structure?standard=${encodeURIComponent(standard)}&schema=${encodeURIComponent(schema)}`
  );
}

// The schemas the examples use and where each takes the LLM's content.
async function prepareSetup({ ruleXml, standard, schemaLocation }) {
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

export function useRuleTest({ ruleXml, format, standard, schemaLocation, brdp, aiProvider, vocabulary }) {
  // Known before any example: shown at the top from the start (T2b, Part 4).
  const analysis = useMemo(() => analyzeRule(ruleXml, format), [ruleXml, format]);
  // "Ejemplos bajo demanda en reglas no ejecutables": when the WHOLE rule
  // cannot be executed, the examples could only illustrate it (and a real
  // run produced broken ones) -- they are not generated until the user
  // asks. status: 'idle' (waiting for that click) | 'loading' | 'error' |
  // 'ready'.
  const onDemand = analysis.status === 'not_executable';
  const [state, setState] = useState(() => ({ status: onDemand ? 'idle' : 'loading' }));
  const [copyablePrompt, setCopyablePrompt] = useState(null);
  // Only the latest generation may land (Regenerate while one is running).
  const generationRef = useRef(0);
  const setupRef = useRef(null);

  const runAll = useCallback(
    (examples) => {
      const materialized = examples.map((ex) => materializeExample(ex, setupRef.current));
      const runs = materialized.map((ex) => runExample(ruleXml, format, ex, { vocabulary }));
      return { materialized, runs };
    },
    [ruleXml, format, vocabulary]
  );

  const generate = useCallback(async () => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    const isCurrent = () => generationRef.current === generation;
    setState({ status: 'loading' });
    try {
      const prepared = await prepareSetup({ ruleXml, standard, schemaLocation });
      if (!isCurrent()) return;
      setupRef.current = prepared.setup;
      const systemPrompt = buildRuleTestExamplesPrompt({
        brdp,
        standard,
        format,
        ruleXml,
        contextSchemas: prepared.contextSchemas,
        placements: prepared.promptPlacements,
        schemaFacts: prepared.schemaFacts,
      });
      setCopyablePrompt(buildCopyableTestPrompt(systemPrompt));
      const ask = (messages) =>
        sendMessage(messages, null, aiProvider.model, aiProvider.provider, systemPrompt, {
          temperature: RULE_TEST_TEMPERATURE,
        });
      const first = [{ role: 'user', content: RULE_TEST_USER_MESSAGE }];
      const res = await ask(first);
      if (!isCurrent()) return;
      const parsed = parseRuleTestResponse(res.content);
      if (!parsed.ok) {
        // Nothing runs on a broken answer (docs request).
        setState({ status: 'error', error: parsed.error, badResponse: true });
        return;
      }
      let { examples } = parsed;
      let { materialized, runs } = runAll(examples);

      // One automatic correction round (T2b, Part 3): the exact problems of
      // each failing example go back to the LLM once. What still fails is
      // shown as it is, with its warnings -- never dropped.
      const failures = runs
        .map((run, index) => ({
          index,
          label: examples[index].label,
          problems: run.validation.runnable
            ? []
            : exampleProblems(run.validation, { standard, schema: materialized[index].schema }),
        }))
        .filter((f) => f.problems.length > 0);
      let correction = null;
      if (failures.length > 0) {
        correction = { attempted: failures.length, fixed: 0, failed: null };
        try {
          const again = await ask([
            ...first,
            { role: 'assistant', content: res.content },
            { role: 'user', content: buildRuleTestCorrectionMessage(failures) },
          ]);
          if (!isCurrent()) return;
          const reparsed = parseRuleTestResponse(again.content);
          if (!reparsed.ok) {
            correction.failed = reparsed.error;
          } else {
            const failing = new Set(failures.map((f) => f.index));
            const next =
              reparsed.examples.length === examples.length
                ? examples.map((ex, i) => (failing.has(i) ? reparsed.examples[i] : ex))
                : reparsed.examples;
            const rerun = runAll(next);
            correction.fixed = failures.filter((f) => rerun.runs[f.index]?.validation.runnable).length;
            examples = next;
            ({ materialized, runs } = rerun);
          }
        } catch (err) {
          if (!isCurrent()) return;
          correction.failed = err.message;
        }
      }
      setState({
        status: 'ready',
        explanation: parsed.explanation,
        proposalMismatch: parsed.proposalMismatch,
        examples: materialized,
        runs,
        correction,
      });
    } catch (err) {
      if (isCurrent()) setState({ status: 'error', error: err.message });
    }
  }, [ruleXml, format, standard, schemaLocation, brdp, aiProvider, runAll]);

  // Generate once when the panel opens (it is remounted for another rule),
  // unless the rule is not executable at all: then only on request.
  useEffect(() => {
    if (!onDemand) generate();
  }, []);

  // "Run again" on an edited example's content: rebuilt on its skeleton,
  // checked and run -- engine only, no LLM, nothing saved.
  const runAgain = (index, content) =>
    setState((prev) => {
      if (prev.status !== 'ready') return prev;
      const example = materializeExample({ ...prev.examples[index], content }, setupRef.current);
      const examples = prev.examples.map((ex, i) => (i === index ? example : ex));
      const runs = prev.runs.map((r, i) => (i === index ? runExample(ruleXml, format, example, { vocabulary }) : r));
      return { ...prev, examples, runs };
    });

  const verdict = state.status === 'ready' ? ruleTestVerdict(state.examples, state.runs, analysis) : null;
  return { state, analysis, verdict, copyablePrompt, generate, regenerate: generate, runAgain };
}
