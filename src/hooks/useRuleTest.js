// Test rule (T2 of 4): the panel's state. One LLM call writes the examples
// (prompts/ruleTestExamplesPrompt.js); everything after that is
// deterministic (utils/ruleTest.js + the T1 engine). Nothing is saved: the
// examples and any edits live only in this component's memory.
import { useCallback, useEffect, useRef, useState } from 'react';
import { sendMessage } from '../api/llmAPI';
import { fetchSchemaCards } from '../api/schemaFacts.js';
import { RULE_TEST_TEMPERATURE } from '../prompts/shared.js';
import {
  buildCopyableTestPrompt,
  buildRuleTestExamplesPrompt,
  parseRuleTestResponse,
  RULE_TEST_USER_MESSAGE,
} from '../prompts/ruleTestExamplesPrompt.js';
import { extractRuleNames } from '../utils/ruleNameCheck.js';
import { contextSchemasOfRule } from '../utils/ruleSchemaContext.js';
import { pickOtherSchema, runExample, ruleTestVerdict } from '../utils/ruleTest.js';

// Same cap as the schema facts of Ask / Suggest Rule.
const MAX_SCHEMA_FACTS = 6;

export function useRuleTest({ ruleXml, format, standard, brdp, aiProvider, vocabulary }) {
  // status: 'loading' | 'error' | 'ready'
  const [state, setState] = useState({ status: 'loading' });
  const [copyablePrompt, setCopyablePrompt] = useState(null);
  // Only the latest generation may land (Regenerate while one is running).
  const generationRef = useRef(0);

  const generate = useCallback(async () => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    const isCurrent = () => generationRef.current === generation;
    setState({ status: 'loading' });
    try {
      const contextSchemas = contextSchemasOfRule(ruleXml).schemas;
      const names = extractRuleNames(ruleXml).elements.slice(0, MAX_SCHEMA_FACTS);
      // Schema facts improve the examples but are never required: a failed
      // fetch still lets the test run (the examples are validated anyway).
      let cards = {};
      let documentSchemas = [];
      try {
        const res = await fetchSchemaCards(standard, names);
        cards = res.cards || {};
        documentSchemas = res.document_schemas || [];
      } catch {
        // no facts
      }
      const schemaFacts = names.filter((n) => cards[n]).map((name) => ({ name, entry: cards[name] }));
      const systemPrompt = buildRuleTestExamplesPrompt({
        brdp,
        standard,
        format,
        ruleXml,
        contextSchemas,
        otherSchema: pickOtherSchema(contextSchemas, documentSchemas),
        schemaFacts,
      });
      if (!isCurrent()) return;
      setCopyablePrompt(buildCopyableTestPrompt(systemPrompt));
      const res = await sendMessage(
        [{ role: 'user', content: RULE_TEST_USER_MESSAGE }],
        null,
        aiProvider.model,
        aiProvider.provider,
        systemPrompt,
        { temperature: RULE_TEST_TEMPERATURE }
      );
      if (!isCurrent()) return;
      const parsed = parseRuleTestResponse(res.content);
      if (!parsed.ok) {
        // Nothing runs on a broken answer (docs request).
        setState({ status: 'error', error: parsed.error, badResponse: true });
        return;
      }
      const examples = parsed.examples;
      const runs = examples.map((ex) => runExample(ruleXml, format, ex, { vocabulary }));
      setState({ status: 'ready', explanation: parsed.explanation, examples, runs });
    } catch (err) {
      if (isCurrent()) setState({ status: 'error', error: err.message });
    }
  }, [ruleXml, format, standard, brdp, aiProvider, vocabulary]);

  // Generate once when the panel opens (it is remounted for another rule).
  useEffect(() => {
    generate();
  }, []);

  // "Run again" on an edited example: engine only, no LLM, nothing saved.
  const runAgain = (index, xml) =>
    setState((prev) => {
      if (prev.status !== 'ready') return prev;
      const examples = prev.examples.map((ex, i) => (i === index ? { ...ex, xml } : ex));
      const runs = prev.runs.map((r, i) => (i === index ? runExample(ruleXml, format, examples[i], { vocabulary }) : r));
      return { ...prev, examples, runs };
    });

  const verdict = state.status === 'ready' ? ruleTestVerdict(state.examples, state.runs) : null;
  return { state, verdict, copyablePrompt, regenerate: generate, runAgain };
}
