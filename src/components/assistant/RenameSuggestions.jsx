import { useTranslation } from 'react-i18next';
import { applyRenameSuggestion, extractContextCandidates, resolvePhraseCandidates } from '../../utils/vocabularyCheck.js';
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
function renameSuggestionsFor(text, vocabulary) {
  if (!vocabulary) return [];
  const { phraseCandidates } = extractContextCandidates(text || '');
  return resolvePhraseCandidates(phraseCandidates, vocabulary);
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
