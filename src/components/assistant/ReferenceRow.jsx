import { useTranslation } from 'react-i18next';
import { referenceSourceLabel } from '../../utils/referenceSource';
import styles from '../../pages/RecordsPage.module.css';

// One row of Suggest Definition's reference list (docs request, readable
// references round): identifier (clickable, toggles the Definition open
// below), Title truncated to one line with the full text in `title=`, the
// origin, and -- only for the "Similar" group, never "Style references" --
// the similarity score. Never navigates anywhere; expand/collapse is pure
// local UI state owned by the parent (several rows can be open at once).
// `showProposal` (docs request, Suggest Proposal round): when set, the
// expanded panel shows BOTH Definition and Proposal, labeled -- used by
// all three of Suggest Proposal's reference groups, even "Same BRDP in
// other projects" (whose PROMPT block only ever cites Proposal -- the UI
// is more generous, per the docs request's explicit "despliega su
// Definition y su Proposal"). Suggest Definition's own two groups leave
// this unset and keep showing Definition alone, unchanged.
// `showRule` (docs request, Suggest Rule round): the expanded panel shows
// the Proposal -> rule pair the prompt cited (Proposal, then the rule XML
// in monospace).
export default function ReferenceRow({ candidate, showScore, showProposal, showRule, danger, expanded, onToggle }) {
  const { t } = useTranslation();
  const sourceLabel = referenceSourceLabel(t, candidate);
  return (
    <li>
      <div className={styles.referenceRow}>
        <button
          type="button"
          className={`${styles.referenceIdentifierButton}${danger ? ` ${styles.referenceIdentifierButtonDanger}` : ''}`}
          onClick={onToggle}
        >
          {candidate.identifier}
        </button>
        <span className={styles.referenceTitle} title={candidate.title}>
          — {candidate.title}
        </span>
        <span className={styles.referenceMeta}>
          {/* Suggest Proposal's "This project" group (docs request) never
              carries a `source` -- the project is already implied, never
              named -- so the leading " — " is skipped rather than shown
              with nothing after it. */}
          {sourceLabel ? ` — ${sourceLabel}` : ''}
          {showScore ? ` — ${candidate.score.toFixed(2)}` : ''}
        </span>
      </div>
      {expanded && (
        <div className={styles.referenceDefinition}>
          {showRule ? (
            <>
              <div>
                <strong>{t('records.assistant.referenceProposalLabel')}:</strong> {candidate.proposal}
              </div>
              <div>
                <strong>{t('records.assistant.referenceRuleLabel')}:</strong>
                <pre className={styles.referenceRuleXml}>{candidate.text}</pre>
              </div>
            </>
          ) : showProposal ? (
            <>
              <div>
                <strong>{t('records.assistant.referenceDefinitionLabel')}:</strong> {candidate.definition}
              </div>
              <div>
                <strong>{t('records.assistant.referenceProposalLabel')}:</strong> {candidate.text}
              </div>
            </>
          ) : (
            candidate.definition
          )}
        </div>
      )}
    </li>
  );
}
