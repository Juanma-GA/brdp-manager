// Prompt-refactor round: vocabulary-check state/logic extracted out of
// RecordsPage.jsx verbatim (no behavior change) -- the real schema
// vocabulary for the project's standard (used synchronously by "Did you
// mean" suggestions) plus the deterministic notFound/wrongType check
// (used by the big red banner and, via recomputeVocabResult, injected
// into Ask/Suggest's prompts).
import { useEffect, useState } from 'react';
import {
  checkAgainstVocabulary,
  extractContextCandidates,
  hashVocabInputText,
  loadSchemaVocabulary,
} from '../validation/schemaValidation.js';

export function useVocabularyCheck(standard, selected) {
  // Follow-up round ("sin falsos positivos"): the real schema vocabulary
  // for this project's standard, loaded once and kept in state so the
  // "Did you mean" suggestion (resolvePhraseCandidates, validation/schemaValidation.js)
  // can be computed SYNCHRONOUSLY on every render of every field -- unlike
  // the big red notice (recomputeVocabResult below), which only needs to
  // run on selection/save and can afford to be async. `loadSchemaVocabulary`
  // caches by file internally, so this is cheap even across many BRDPs of
  // the same project.
  const [vocabulary, setVocabulary] = useState(null);
  useEffect(() => {
    let cancelled = false;
    loadSchemaVocabulary(standard)
      .then((v) => {
        if (!cancelled) setVocabulary(v);
      })
      .catch(() => {
        if (!cancelled) setVocabulary(null);
      });
    return () => {
      cancelled = true;
    };
  }, [standard]);

  // Docs request (schema vocabulary check round), extended by the "aviso
  // ligado al texto" round and by the "solo determinista" follow-up: the
  // CURRENT check's result -- { brdpId, hash, available, notFound,
  // wrongType } -- or null before anything has run yet. Guarded by
  // `brdpId` at render time (never explicitly cleared on BRDP change) so a
  // stale result from a PREVIOUS BRDP simply never displays once
  // `selected` moves on. `hash` is the text (title+definition+proposal)
  // this result reflects. Entirely deterministic now (no LLM call, no
  // cache to invalidate) -- recomputeVocabResult is cheap enough to run on
  // every selection change and every save, so the notice always reflects
  // the BRDP's CURRENT text.
  const [vocabResult, setVocabResult] = useState(null);

  // "Aviso ligado al texto" round, point 1, simplified by the "solo
  // determinista" follow-up: the vocabulary check (context extraction +
  // comparison against the real schema, no LLM call anywhere) -- fast
  // enough to run on every selection change and every save, so the notice
  // always reflects the BRDP's CURRENT text. Also called from
  // askGeneric/requestSuggestion BEFORE building their system prompt, so
  // the unknown-names block (if any) can be included in that same call --
  // there is now only ONE vocabulary-check function, used everywhere.
  const recomputeVocabResult = async (brdp) => {
    if (!brdp) {
      setVocabResult(null);
      return null;
    }
    const hash = hashVocabInputText(brdp.title, brdp.definition, brdp.proposal);
    const vocab = await loadSchemaVocabulary(standard).catch(() => null);
    const contextCandidates = extractContextCandidates(`${brdp.title}\n${brdp.definition}\n${brdp.proposal}`);
    const checked = checkAgainstVocabulary(contextCandidates, vocab);
    const result = {
      brdpId: brdp.id,
      hash,
      available: checked.available,
      notFound: checked.notFound,
      wrongType: checked.wrongType,
      typedNotFound: checked.typedNotFound,
    };
    setVocabResult(result);
    return result;
  };

  // "Aviso ligado al texto" round, point 1: the deterministic vocabulary
  // check reflects whichever BRDP just became selected as soon as it's
  // selected -- never requiring an Ask/Suggest click first (a BRDP whose
  // Title already has, say, <cocacola> shows the notice, and its Suggest
  // buttons are already blocked, the moment it's opened).
  useEffect(() => {
    recomputeVocabResult(selected);
  }, [selected?.id]);

  return { vocabulary, vocabResult, recomputeVocabResult };
}
