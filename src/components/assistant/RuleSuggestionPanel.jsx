import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import styles from '../../pages/RecordsPage.module.css';
import ReferenceRow from './ReferenceRow';
import { validateRuleXml } from '../../hooks/useSuggestions';

// Red warnings for one rule fragment (docs request, Suggest Rule round,
// Part 4) -- same style as the BRDP text's vocabulary warning. Only the
// well-formedness error disables Accept; name warnings never do.
function RuleValidationWarnings({ validation, standard }) {
  const { t } = useTranslation();
  const { wellFormed, wellFormedError, names } = validation;
  return (
    <>
      {!wellFormed && (
        <p className={styles.vocabWarning}>
          ⚠ {t('records.assistant.ruleNotWellFormed', { error: wellFormedError })}
        </p>
      )}
      {names.available && names.notFound.length > 0 && (
        <p className={styles.vocabWarning}>
          ⚠ {t('records.assistant.ruleNamesNotFound', { standard, names: names.notFound.join(', ') })}
        </p>
      )}
      {names.available &&
        names.wrongType.map((w) => (
          <p key={w.name} className={styles.vocabWarning}>
            ⚠{' '}
            {t(
              w.usedAs === 'element'
                ? 'records.assistant.vocabWrongTypeAsElement'
                : 'records.assistant.vocabWrongTypeAsAttribute',
              { standard, name: w.name }
            )}
          </p>
        ))}
    </>
  );
}

function ReferenceGroup({ title, candidates, entry, onToggleReference, danger, showScore }) {
  if (candidates.length === 0) return null;
  const list = (
    <>
      <h4 className={`${styles.referencesGroupTitle}${danger ? ` ${styles.referencesGroupTitleDanger}` : ''}`}>
        {title}
      </h4>
      <ul className={styles.referencesList}>
        {candidates.map((c) => (
          <ReferenceRow
            key={c.id}
            candidate={c}
            showScore={showScore}
            showRule
            danger={danger}
            expanded={entry.expandedReferenceIds.has(c.id)}
            onToggle={() => onToggleReference(c.id)}
          />
        ))}
      </ul>
    </>
  );
  return danger ? <div className={styles.referencesGroupHighlighted}>{list}</div> : <div>{list}</div>;
}

// Everything a resolved Suggest Rule entry shows (docs request, Suggest
// Rule round, Part 5): the generated rule (or the NOT_CHECKABLE reason, or
// the error), its validation, Accept/Discard, the reference groups, Copy
// prompt, and Paste rule.
export default function RuleSuggestionPanel({
  entry,
  standard,
  vocabulary,
  canEdit,
  onAccept,
  onDiscard,
  onToggleReference,
  onPastedRuleChange,
  onAcceptPasted,
}) {
  const { t } = useTranslation();
  const [copyStatus, setCopyStatus] = useState(null); // null | 'copied' | 'failed'

  const generatedValidation = entry.text ? validateRuleXml(entry.text, vocabulary) : null;
  const pasted = (entry.pastedRule || '').trim();
  const pastedValidation = pasted ? validateRuleXml(pasted, vocabulary) : null;

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(entry.copyablePrompt);
      setCopyStatus('copied');
    } catch {
      setCopyStatus('failed');
    }
  };

  // An error before /similar answered (e.g. a 400 from its prerequisite
  // check) leaves the entry with no reference groups and no prompt.
  const sameBrdp = entry.sameBrdp || [];
  const similar = entry.similar || [];
  const formatExamples = [...(entry.standardFallback || []), ...(entry.templateFallback || [])];
  const hasPrompt = !!entry.copyablePrompt;
  const noReferences = sameBrdp.length === 0 && similar.length === 0 && formatExamples.length === 0;

  return (
    <div className={styles.suggestionBox}>
      {entry.error && (
        <span className={styles.muted}>
          ⚠ {t('records.assistant.errorPrefix')}: {entry.error}
        </span>
      )}
      {entry.notCheckable !== undefined && (
        <p className={styles.muted}>
          {t('records.assistant.ruleNotCheckable', { reason: entry.notCheckable })}
        </p>
      )}
      {entry.text && (
        <>
          <div className={styles.suggestionCode}>{entry.text}</div>
          <RuleValidationWarnings validation={generatedValidation} standard={standard} />
        </>
      )}

      <div className={styles.suggestionActions}>
        {entry.text && (
          <button
            onClick={onAccept}
            disabled={!canEdit || !generatedValidation.wellFormed}
            title={
              !canEdit
                ? t('records.assistant.acceptDisabledTitle')
                : !generatedValidation.wellFormed
                  ? t('records.assistant.ruleAcceptDisabledMalformed')
                  : undefined
            }
          >
            {t('records.assistant.accept')}
          </button>
        )}
        <button onClick={onDiscard}>{t('records.assistant.discard')}</button>
        {entry.copyablePrompt && (
          <button onClick={copyPrompt} title={t('records.assistant.copyPromptTitle')}>
            {copyStatus === 'copied' ? t('records.assistant.promptCopied') : t('records.assistant.copyPrompt')}
          </button>
        )}
      </div>
      {copyStatus === 'failed' && <p className={styles.muted}>{t('records.assistant.promptCopyFailed')}</p>}

      {hasPrompt && (
        <div className={styles.suggestionReferences}>
          {noReferences ? (
            <p className={styles.hint}>{t('records.assistant.ruleNoReferences')}</p>
          ) : (
            <>
              <ReferenceGroup
                title={t('records.assistant.proposalSameBrdpGroup')}
                candidates={sameBrdp}
                entry={entry}
                onToggleReference={onToggleReference}
                danger
                showScore={false}
              />
              <ReferenceGroup
                title={t('records.assistant.proposalSimilarGroup')}
                candidates={similar}
                entry={entry}
                onToggleReference={onToggleReference}
                showScore
              />
              <ReferenceGroup
                title={t('records.assistant.ruleFormatExamplesGroup')}
                candidates={formatExamples}
                entry={entry}
                onToggleReference={onToggleReference}
                showScore={false}
              />
            </>
          )}
        </div>
      )}

      {/* Paste rule only makes sense next to Copy prompt -- and needs the
          rule format /similar returned to know where to save it. */}
      {hasPrompt && (
        <>
          <label className={styles.fieldLabel}>{t('records.assistant.pasteRuleLabel')}</label>
          <textarea
            className={styles.pasteRuleInput}
            rows={4}
            value={entry.pastedRule || ''}
            placeholder={t('records.assistant.pasteRulePlaceholder')}
            onChange={(e) => onPastedRuleChange(e.target.value)}
          />
          {pastedValidation && <RuleValidationWarnings validation={pastedValidation} standard={standard} />}
          {pasted && (
            <div className={styles.suggestionActions}>
              <button
                onClick={onAcceptPasted}
                disabled={!canEdit || !pastedValidation.wellFormed}
                title={
                  !canEdit
                    ? t('records.assistant.acceptDisabledTitle')
                    : !pastedValidation.wellFormed
                      ? t('records.assistant.ruleAcceptDisabledMalformed')
                      : undefined
                }
              >
                {t('records.assistant.acceptPastedRule')}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
