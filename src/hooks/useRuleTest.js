// Test rule (T2 of 4, T2b): the panel's state. Everything but the LLM calls
// is deterministic: analyzeRule (what can be known without an example, shown
// from the start), the schema(s) and skeleton the examples are built on
// (GET /api/schema-cards/structure + utils/ruleTestSkeleton.js), the checks
// of each example, one automatic correction round for the examples that fail
// them, and the engine run. The examples and any edits live only in this
// component's memory (HR1).
//
// Recording (Test de reglas T3): `onResult({ result, reason })` is called
// with the verdict of the examples AS THE LLM WROTE THEM and the
// application validated them (after the correction round) -- once per
// generation, and at mount for a rule that is not executable at all (the
// analysis is the result; no example is needed to know it). Editing an
// example and pressing "Run again" is a what-if for the user: it changes
// the verdict shown in the panel, never the recorded one (a user editing
// the examples until the rule "passes" would otherwise record a test the
// rule never passed). Illustrative examples generated on request for a
// non-executable rule record nothing either (already recorded at mount).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { authFetchJson } from '../services/apiClient';
import { sendMessage } from '../api/llmAPI';
import { fetchSchemaCards } from '../api/schemaFacts.js';
import i18n from '../i18n';
import { RULE_TEST_REVIEW_TEMPERATURE, RULE_TEST_TEMPERATURE } from '../prompts/shared.js';
import { buildCopyableTestPrompt } from '../prompts/ruleTestExamplesPrompt.js';
import {
  buildRuleTestReviewPrompt,
  mismatchedExamples,
  parseRuleTestReviewResponse,
  RULE_TEST_REVIEW_USER_MESSAGE,
} from '../prompts/ruleTestReviewPrompt.js';
import { analyzeRule, describeRule } from '../utils/ruleTestEngine.js';
import { materializeExample, runExample, ruleTestVerdict } from '../utils/ruleTest.js';
import { generateRuleTestExamples } from '../utils/ruleTestRun.js';
import { ruleDescriptionText, verdictToTestRecord } from '../utils/ruleTestReasons.js';

async function fetchStructure(standard, schema) {
  return authFetchJson(
    `/api/schema-cards/structure?standard=${encodeURIComponent(standard)}&schema=${encodeURIComponent(schema)}`
  );
}

export function useRuleTest({ ruleXml, format, standard, schemaLocation, brdp, aiProvider, vocabulary, onResult }) {
  // Known before any example: shown at the top from the start (T2b, Part 4).
  const analysis = useMemo(() => analyzeRule(ruleXml, format), [ruleXml, format]);
  // T3b: what the rule checks, read from its XML -- shown in place of an
  // explanation by the LLM, and the ground truth the review is given.
  const description = useMemo(() => describeRule(ruleXml, format), [ruleXml, format]);
  // "Ejemplos bajo demanda en reglas no ejecutables": when the WHOLE rule
  // cannot be executed, the examples could only illustrate it (and a real
  // run produced broken ones) -- they are not generated until the user
  // asks. status: 'idle' (waiting for that click) | 'loading' | 'error' |
  // 'ready'.
  const onDemand = analysis.status === 'not_executable';
  const [state, setState] = useState(() => ({ status: onDemand ? 'idle' : 'loading' }));
  const [copyablePrompt, setCopyablePrompt] = useState(null);
  // T3b "Review with the assistant": { status: 'loading' | 'ready' |
  // 'error', cause, explanation, mismatches, error } | null. Indicative
  // only: it never changes the verdict shown or recorded.
  const [review, setReview] = useState(null);
  // Only the latest generation may land (Regenerate while one is running).
  const generationRef = useRef(0);
  const setupRef = useRef(null);
  // Latest callback, so a generation that lands later reports to it.
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;
  const report = (record) => {
    if (record && onResultRef.current) onResultRef.current(record);
  };

  // `previousReview` (T3b): { explanation, mismatches } when the review
  // found the EXAMPLES at fault -- the new generation is told not to repeat
  // that mistake. A new generation is a new test: it is recorded as usual.
  const generate = useCallback(async (previousReview = null) => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    setState({ status: 'loading' });
    setReview(null);
    const result = await generateRuleTestExamples({
      ruleXml,
      format,
      standard,
      schemaLocation,
      brdp,
      vocabulary,
      ask: async (messages, systemPrompt) =>
        (
          await sendMessage(messages, null, aiProvider.model, aiProvider.provider, systemPrompt, {
            temperature: RULE_TEST_TEMPERATURE,
          })
        ).content,
      fetchSchemaCards,
      fetchStructure,
      isCurrent: () => generationRef.current === generation,
      onPrompt: (systemPrompt) => setCopyablePrompt(buildCopyableTestPrompt(systemPrompt)),
      previousReview: previousReview?.mismatches ? previousReview : null,
    });
    if (!result) return; // a newer generation started
    if (result.status !== 'ready') {
      setState({ status: 'error', error: result.error, badResponse: Boolean(result.badResponse) });
      return;
    }
    setupRef.current = result.setup;
    const { proposalMismatch, examples, runs, correction } = result;
    setState({ status: 'ready', proposalMismatch, examples, runs, correction });
    if (!onDemand) report(verdictToTestRecord(ruleTestVerdict(examples, runs, analysis)));
  }, [ruleXml, format, standard, schemaLocation, brdp, aiProvider, vocabulary, analysis, onDemand]);

  // Generate once when the panel opens (it is remounted for another rule),
  // unless the rule is not executable at all: then only on request. The ref
  // keeps it to once per panel: React's StrictMode (development) runs a
  // mount effect twice, which recorded "not executable" twice in History
  // and asked the LLM twice (found verifying T3b).
  const openedRef = useRef(false);
  useEffect(() => {
    if (openedRef.current) return;
    openedRef.current = true;
    if (onDemand) report({ result: 'not_executable', reason: analysis.reason });
    else generate();
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

  // T3b "Review with the assistant" (incorrect verdict only): the Proposal,
  // the rule, its deterministic description (in English, whatever the
  // interface language) and the examples whose result did not match.
  const reviewFailure = async () => {
    if (state.status !== 'ready') return;
    const mismatches = mismatchedExamples(state.examples, state.runs);
    if (mismatches.length === 0) return;
    const generation = generationRef.current;
    setReview({ status: 'loading', mismatches });
    const systemPrompt = buildRuleTestReviewPrompt({
      brdp,
      standard,
      format,
      ruleXml,
      ruleDescription: ruleDescriptionText(description, i18n.getFixedT('en')),
      mismatches,
    });
    try {
      const res = await sendMessage([{ role: 'user', content: RULE_TEST_REVIEW_USER_MESSAGE }], null, aiProvider.model, aiProvider.provider, systemPrompt, {
        temperature: RULE_TEST_REVIEW_TEMPERATURE,
      });
      if (generationRef.current !== generation) return; // examples replaced meanwhile
      const parsed = parseRuleTestReviewResponse(res.content);
      setReview(parsed.ok ? { status: 'ready', cause: parsed.cause, explanation: parsed.explanation, mismatches } : { status: 'error', error: parsed.error, mismatches });
    } catch (err) {
      if (generationRef.current === generation) setReview({ status: 'error', error: err.message, mismatches });
    }
  };

  // "Regenerate examples" after a review that blamed the examples.
  const regenerateWithReview = () =>
    review?.status === 'ready' ? generate({ explanation: review.explanation, mismatches: review.mismatches }) : generate();

  return {
    state,
    analysis,
    description,
    verdict,
    copyablePrompt,
    generate,
    regenerate: generate,
    runAgain,
    review,
    reviewFailure,
    regenerateWithReview,
  };
}
