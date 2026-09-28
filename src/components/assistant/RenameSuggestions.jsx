import { useTranslation } from 'react-i18next';
import {
  applyRenameSuggestion,
  extractContextCandidates,
  resolveDanglingElementSuggestions,
  resolvePhraseCandidates,
} from '../../validation/schemaValidation.js';
import styles from '../../pages/RecordsPage.module.css';

// Follow-up round ("consejo de nombres sin falsos positivos"): pure
// wrapper around extractContextCandidates(text).phraseCandidates +
// resolvePhraseCandidates(..., vocabulary), so every field that wants the
// "Did you mean `<x>`?" correction calls the same one function rather
// than each re-deriving it -- never gated by the session tip's dismissed
// state (a concrete correction, not the general hint). `vocabulary` is
// the already-loaded {elements,attributes} Sets for this project's
// standard -- a phrase-triggered word only ever becomes a suggestion when
// it genuinely resolves against it; an unresolvable one (a real
// adjective/verb the trigger word happened to sit next to, e.g.
// "atributos seleccionados") is silently dropped, never shown as a
// suggestion NOR as a red warning.
//
// "Did you mean con marcado a medias" round, Part 1: also offers a
// completion chip for half-typed markup ("<table" with no closing ">"),
// via `danglingElements` (a DIFFERENT source than phraseCandidates -- no
// trigger word needed, see extractContextCandidates). Merged and deduped
// by (type, name) so a name that somehow qualifies both ways never shows
// two identical chips.
function renameSuggestionsFor(text, vocabulary) {
  if (!vocabulary) return [];
  const { phraseCandidates, danglingElements } = extractContextCandidates(text || '');
  const fromDangling = resolveDanglingElementSuggestions(danglingElements, vocabulary);
  const fromPhrases = resolvePhraseCandidates(phraseCandidates, vocabulary);
  const seen = new Set();
  const merged = [];
  for (const s of [...fromDangling, ...fromPhrases]) {
    const key = `${s.type}:${s.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(s);
  }
  return merged;
}

// One "Did you mean `<x>`?" chip per resolved phrase candidate -- applying
// it rewrites `text` (wrapping the first bare occurrence) via the passed
// setter, which for the BRDP detail panel is a combined local-state-plus-
// save (see the title/definition/proposal fields in RecordsPage.jsx).
export default function RenameSuggestions({ text, vocabulary, onApply }) {
  const { t } = useTranslation();
  const suggestions = renameSuggestionsFor(text, vocabulary);
  if (suggestions.length === 0) return null;
  return (
    <div className={styles.renameSuggestions}>
      {suggestions.map((s) => (
        <button
          key={`${s.type}:${s.name}`}
          type="button"
          className={styles.linkButton}
          onClick={() => onApply(applyRenameSuggestion(text, s))}
        >
          {t('records.didYouMean', { suggestion: s.type === 'element' ? `<${s.name}>` : `@${s.name}` })}
        </button>
      ))}
    </div>
  );
}
