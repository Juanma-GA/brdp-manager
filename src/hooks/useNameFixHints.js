// "Sugerencias para erratas y nombres de otro estándar": the hints that
// follow a red "not found" line -- a near name of the project's standard,
// or the other standards a name comes from (nameFixHints in
// validation/schemaValidation.js, pure and deterministic, no AI).
//
// The project's vocabulary is the one every check already loads (cached by
// file). The OTHER standards' vocabularies are fetched only while some
// marked name needs them (a name that does not exist and has no
// capitals-only match in its own standard) -- never when the page opens --
// and stay cached for the session. Until they arrive only the
// capitals-only hints show, so a near-name suggestion never appears and
// then turns into an other-standard message.
import { useEffect, useState } from 'react';
import {
  loadOtherStandardVocabularies,
  loadSchemaVocabulary,
  nameFixHints,
  nameFixSuggestions,
  textNeedsOtherVocabularies,
} from '../validation/schemaValidation.js';

function useProjectVocabulary(standard, vocabulary) {
  const [loaded, setLoaded] = useState({ standard: null, vocabulary: null });
  useEffect(() => {
    if (vocabulary) return undefined;
    let cancelled = false;
    loadSchemaVocabulary(standard)
      .then((v) => !cancelled && setLoaded({ standard, vocabulary: v }))
      .catch(() => !cancelled && setLoaded({ standard, vocabulary: null }));
    return () => {
      cancelled = true;
    };
  }, [standard, vocabulary]);
  if (vocabulary) return vocabulary;
  return loaded.standard === standard ? loaded.vocabulary : null;
}

function useOtherStandardVocabularies(standard, needed) {
  const [loaded, setLoaded] = useState({ standard: null, vocabularies: null });
  const have = loaded.standard === standard;
  useEffect(() => {
    if (!needed || have) return undefined;
    let cancelled = false;
    loadOtherStandardVocabularies(standard).then((vocabularies) => {
      if (!cancelled) setLoaded({ standard, vocabularies });
    });
    return () => {
      cancelled = true;
    };
  }, [standard, needed, have]);
  return have ? loaded.vocabularies : null;
}

// Hints for a check result ({ available, typedNotFound, … } from
// checkAgainstVocabulary / checkRuleNames), for nameIssues(…, { hints }).
export function useNameFixHints(result, standard, vocabulary = null) {
  const own = useProjectVocabulary(standard, vocabulary);
  const typed = result?.available ? result.typedNotFound || [] : [];
  const needed = own ? nameFixHints(typed, own, null).needsOtherVocabularies : false;
  const others = useOtherStandardVocabularies(standard, needed);
  if (!own || typed.length === 0) return [];
  return nameFixHints(typed, own, others).hints;
}

// The "Did you mean" chips of a text field for its marked names that do
// not exist ({ from, name, type }).
export function useNameFixSuggestions(text, standard, vocabulary) {
  const needed = textNeedsOtherVocabularies(text, vocabulary);
  const others = useOtherStandardVocabularies(standard, needed);
  return nameFixSuggestions(text, vocabulary, others);
}
