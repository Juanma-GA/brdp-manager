// Prompt-refactor round: "Ask a Question" state/logic extracted out of
// RecordsPage.jsx verbatim (no behavior change) -- question/answer/prev-
// turn chaining, the "+ Compare with another BRDP" picker, and the real
// schema facts fetched for the currently displayed exchange.
import { useEffect, useRef, useState } from 'react';
import { authFetchJson } from '../services/apiClient';
import { sendMessage } from '../api/llmAPI';
import { ruleStateOf } from '../utils/ruleState';
import { fetchSchemaAttribute, fetchSchemaCards, fetchSchemaFacts, fetchSchemaRelation } from '../api/schemaFacts.js';
import { buildAskSystemPrompt } from '../prompts/askPrompt.js';
import { ASK_TEMPERATURE } from '../prompts/shared.js';
import { checkAnswerNames, loadSchemaVocabulary } from '../validation/schemaValidation.js';
import { answerStructuralQuestion } from '../utils/structuralAnswer.js';

export function useAskAssistant({ projectId, standard, ruleFormat, selected, ruleApproval, aiProvider, vocabulary, recomputeVocabResult }) {
  // `question` is only ever the live DRAFT in the textarea -- it auto-
  // clears on a successful answer (docs request: feel like a mini
  // conversation, not a submitted form) and is intentionally left alone on
  // error, so the user never loses what they typed. The exchange actually
  // shown/asked lives in the fields below, decoupled from the draft.
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [askError, setAskError] = useState(null);
  // The question belonging to the CURRENTLY DISPLAYED exchange (pending,
  // answered, or errored) -- null when there's nothing to show yet. Only
  // one exchange is ever shown, matching the one-turn chaining already in
  // place: what's on screen and what's sent to the LLM as history must
  // always be the same single turn.
  const [lastAsked, setLastAsked] = useState(null);
  // True only while THIS specific request is in flight -- kept separate
  // from `busy` (the Ask panel's own send-button/Enter-key guard) so the
  // "Thinking…" indicator and the disabled button track slightly
  // different things. Suggest doesn't share `busy` at all -- it has its
  // own per-entry `loading` flag in useSuggestions' suggestionsByBrdpId.
  const [askPending, setAskPending] = useState(false);
  // The single previous Ask turn ({ question, answer }), or null -- one
  // turn of chaining only (docs request), not unlimited history, so cost
  // and context stay bounded. Set only on a SUCCESSFUL answer (an errored
  // question never becomes something the LLM "remembers"). Cleared by
  // Clear or by switching BRDP.
  const [prevTurn, setPrevTurn] = useState(null);
  // Docs request ("Servicio de fichas de esquema y su uso en Ask"): the
  // real schema facts fetched for the CURRENTLY DISPLAYED exchange (in
  // priority order, question's own names first) -- the exact same array
  // both buildSchemaFactsBlock used to build the prompt AND the "Schema
  // facts used" line renders, so what the user sees and what the LLM saw
  // are always the same data (same precedent already established for
  // Suggest Definition/Proposal's reference lists). Empty when the
  // question/BRDP mentioned no real schema names, or the standard has no
  // generated cards -- no line, no prompt block either way.
  const [lastAskedSchemaFacts, setLastAskedSchemaFacts] = useState([]);
  const [expandedSchemaFactNames, setExpandedSchemaFactNames] = useState(new Set());
  // "Ask: comprobar los nombres de la respuesta": the names the displayed
  // answer mentions as schema names, checked against the standard's
  // vocabulary (validation/schemaValidation.js) -- { available, notFound,
  // wrongType } or null. Only a warning under the answer; the answer
  // itself is never changed.
  const [answerNameCheck, setAnswerNameCheck] = useState(null);
  // C1, Part 2: where the displayed answer came from -- 'schema' (a
  // structural question answered from the schema cards, without the LLM),
  // 'llm', or null while nothing is shown.
  const [answerSource, setAnswerSource] = useState(null);
  // An answer taken from the schema, as the interface shows it: its lists'
  // "+N more" are markers for `cuts` (the hidden names), which the answer
  // renderer turns into buttons. `answer` stays the text the LLM receives as
  // the previous turn. { seq, display, cuts } or null -- `seq` numbers every
  // answer, so a repeated question still gets a fresh answer (all lists folded).
  const [schemaAnswerView, setSchemaAnswerView] = useState(null);
  const schemaAnswerSeqRef = useRef(0);
  // "+ Compare with another BRDP": collapsed by default. compareBrdp holds
  // the chosen entry ({ source: 'records'|'catalog'|'other_project',
  // identifier, title, definition, and for 'records'/'other_project' also
  // proposal/validation/ruleState/ruleXml -- 'other_project' also carries
  // projectName and standard }) or null. compareCatalogEntries is fetched lazily, once,
  // the first time the search opens (same lazy-load pattern as Add BRDP's
  // catalog picker) -- it's global reference data keyed only by the
  // project's standard, so it stays valid across switching BRDPs and
  // doesn't need to be refetched per selection.
  const [compareOpen, setCompareOpen] = useState(false);
  const [compareQuery, setCompareQuery] = useState('');
  const [compareCatalogEntries, setCompareCatalogEntries] = useState([]);
  const [compareBrdp, setCompareBrdp] = useState(null);
  const [compareBusy, setCompareBusy] = useState(false);
  const [busy, setBusy] = useState(false);

  // Bug fix (docs request): switching the selected BRDP must reset the Ask
  // panel entirely -- previously `answer`/`question` just sat there, so a
  // stale answer (built from and about the PREVIOUS BRDP's context) stayed
  // visible, and the next question would have chained onto it as if it
  // were still about the newly selected BRDP.
  useEffect(() => {
    setQuestion('');
    setAnswer('');
    setAskError(null);
    setLastAsked(null);
    setPrevTurn(null);
    setLastAskedSchemaFacts([]);
    setExpandedSchemaFactNames(new Set());
    setAnswerNameCheck(null);
    setAnswerSource(null);
    setSchemaAnswerView(null);
    setCompareOpen(false);
    setCompareQuery('');
    setCompareBrdp(null);
  }, [selected?.id]);

  // Docs request ("Servicio de fichas de esquema y su uso en Ask"): real
  // structural facts for Ask -- question first, then Title/Definition/
  // Proposal, capped at 6 (see src/api/schemaFacts.js, shared with Suggest
  // Rule). A fetch failure degrades to "no schema facts this time", never
  // blocks the question itself.
  const fetchAskSchemaFacts = (q, brdp) =>
    fetchSchemaFacts(standard, vocabulary, [q, brdp.title, brdp.definition, brdp.proposal], 6);

  // The Ask panel only ever renders inside the `selected` branch of the
  // detail panel, so `selected` is always set here.
  const askGeneric = async () => {
    if (!question.trim() || !aiProvider || !selected) return;
    const askedQuestion = question;
    setBusy(true);
    setAskPending(true);
    // Shown immediately (docs request: "mostrar la pregunta enviada ya en
    // la zona de intercambio con un indicador de carga") -- and this is
    // also the point where the exchange on screen switches to the NEW
    // question, replacing whatever was shown before, matching exactly what
    // gets sent as history below (only ever one turn, never both).
    setLastAsked(askedQuestion);
    setAnswer('');
    setAskError(null);
    setLastAskedSchemaFacts([]);
    setExpandedSchemaFactNames(new Set());
    setAnswerNameCheck(null);
    setAnswerSource(null);
    setSchemaAnswerView(null);
    try {
      const vocab = await recomputeVocabResult(selected);
      const schemaFacts = await fetchAskSchemaFacts(askedQuestion, selected);
      setLastAskedSchemaFacts(schemaFacts);
      // C1, Part 2: children / parents / attributes / values of one schema
      // name are answered from the schema cards, without the LLM. The
      // answer is a normal turn: a follow-up ("¿y por qué?") goes to the
      // LLM with it as the previous turn. Its names come from the schema,
      // so the answer-name check does not apply.
      const questionVocabulary = vocabulary || (await loadSchemaVocabulary(standard).catch(() => null));
      if (questionVocabulary) {
        const structural = await answerStructuralQuestion({
          question: askedQuestion,
          standard,
          vocabulary: questionVocabulary,
          fetchCards: fetchSchemaCards,
          fetchAttribute: fetchSchemaAttribute,
          fetchRelation: fetchSchemaRelation,
        });
        if (structural) {
          setAnswer(structural.text);
          setAnswerSource('schema');
          setSchemaAnswerView({ seq: ++schemaAnswerSeqRef.current, display: structural.display, cuts: structural.cuts });
          setPrevTurn({ question: askedQuestion, answer: structural.text });
          setQuestion('');
          return;
        }
      }
      const systemPrompt = buildAskSystemPrompt(selected, ruleApproval, compareBrdp, standard, vocab, schemaFacts);
      // One turn of chaining (docs request): the previous Q/A, if any,
      // goes in first as real conversation history so a follow-up like
      // "and why?" resolves correctly, then the new question.
      const messages = [];
      if (prevTurn) {
        messages.push({ role: 'user', content: prevTurn.question });
        messages.push({ role: 'assistant', content: prevTurn.answer });
      }
      messages.push({ role: 'user', content: askedQuestion });

      const res = await sendMessage(messages, null, aiProvider.model, aiProvider.provider, systemPrompt, {
        temperature: ASK_TEMPERATURE,
      });
      setAnswer(res.content);
      setAnswerSource('llm');
      // The same vocabulary as the BRDP's own notice; the names that notice
      // already reports are left out (the user has been warned about them).
      setAnswerNameCheck(checkAnswerNames(res.content, questionVocabulary, vocab));
      setPrevTurn({ question: askedQuestion, answer: res.content });
      // Auto-clear on success only (docs request) -- an errored question
      // stays in the textarea below so the user never loses what they typed.
      setQuestion('');
    } catch (err) {
      setAskError(err.message);
    } finally {
      setBusy(false);
      setAskPending(false);
    }
  };

  const clearAsk = () => {
    setAnswer('');
    setAskError(null);
    setLastAsked(null);
    setPrevTurn(null);
    setLastAskedSchemaFacts([]);
    setExpandedSchemaFactNames(new Set());
    setAnswerNameCheck(null);
    setAnswerSource(null);
    setSchemaAnswerView(null);
  };

  const openCompareSearch = () => {
    setCompareOpen(true);
    if (compareCatalogEntries.length === 0) {
      // Global reference data, not project-scoped (same source/pattern as
      // Add BRDP's catalog fetch) -- fetched once, lazily, the first time
      // the search actually opens.
      authFetchJson(`/api/brdp-catalog?standard=${encodeURIComponent(standard)}`)
        .then(setCompareCatalogEntries)
        .catch(() => setCompareCatalogEntries([]));
    }
  };

  const closeCompareSearch = () => {
    setCompareOpen(false);
    setCompareQuery('');
  };

  // Rule Status/Rule for a Records candidate live in rule_approvals, not on
  // the BRDP row itself -- the bulk-fetched ruleApprovalsById only carries
  // `status` (enough to sort by), not `rule_xml`, so a dedicated fetch is
  // needed here, same endpoint and shape the main ruleApproval effect
  // already uses.
  const chooseCompareBrdp = async (candidate) => {
    if (candidate.source === 'catalog') {
      const { entry } = candidate;
      setCompareBrdp({ source: 'catalog', identifier: entry.identifier, title: entry.title, definition: entry.definition });
      closeCompareSearch();
      return;
    }
    const { entry } = candidate;
    setCompareBusy(true);
    try {
      const approval = ruleFormat
        ? await authFetchJson(`/api/projects/${projectId}/brdps/${entry.id}/approvals/${ruleFormat}`)
        : null;
      setCompareBrdp({
        source: 'records',
        identifier: entry.identifier,
        title: entry.title,
        definition: entry.definition,
        proposal: entry.proposal,
        validation: entry.validation,
        ruleState: ruleStateOf(approval),
        ruleXml: approval?.rule_xml ?? null,
      });
    } finally {
      setCompareBusy(false);
    }
    closeCompareSearch();
  };

  const clearCompareBrdp = () => setCompareBrdp(null);

  // "Explicar las diferencias" from the side-by-side comparison: compare
  // with an entry the view already loaded ({ source: 'records' |
  // 'other_project', projectName, standard, identifier, title, definition,
  // proposal, validation, ruleState, ruleXml }), without another fetch.
  const compareWith = (entry) => {
    setCompareBrdp(entry);
    closeCompareSearch();
  };

  return {
    question,
    setQuestion,
    answer,
    askError,
    lastAsked,
    askPending,
    prevTurn,
    lastAskedSchemaFacts,
    answerNameCheck,
    answerSource,
    schemaAnswerView,
    expandedSchemaFactNames,
    setExpandedSchemaFactNames,
    compareOpen,
    compareQuery,
    setCompareQuery,
    compareCatalogEntries,
    compareBrdp,
    compareBusy,
    busy,
    askGeneric,
    clearAsk,
    openCompareSearch,
    closeCompareSearch,
    chooseCompareBrdp,
    clearCompareBrdp,
    compareWith,
  };
}
