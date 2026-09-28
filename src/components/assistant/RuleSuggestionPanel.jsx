import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import styles from '../../pages/RecordsPage.module.css';
import ReferenceRow from './ReferenceRow';
import RuleTestPanel, { canTestRule, TestRuleButton } from './RuleTestPanel';
import { finalRuleXml, validateRuleXml } from '../../hooks/useSuggestions';
import { extractRuleNames } from '../../utils/ruleNameCheck.js';
import { checkRuleSchemaCoverage, supportsSchemaContext } from '../../utils/ruleSchemaContext.js';

// Part 5 (Suggest Rule part 2): with schemas chosen, an element of the
// rule's XPath that doesn't exist in one of them -- red, never blocking.
function SchemaCoverageWarnings({ ruleXml, entry }) {
  const { t } = useTranslation();
  const problems = checkRuleSchemaCoverage(
    extractRuleNames(ruleXml).elements,
    entry.schemas || [],
    entry.coverageByName || {}
  );
  return problems.map((p) => (
    <p key={p.schema} className={styles.vocabWarning}>
      ⚠{' '}
      {t('records.assistant.ruleNamesNotInSchema', {
        names: p.missing.map((n) => `<${n}>`).join(', '),
        schema: p.schema,
      })}
    </p>
  ));
}

function AppliesTo({ entry }) {
  const { t } = useTranslation();
  if (!supportsSchemaContext(entry.standard) || !entry.schemas) return null;
  return (
    <p className={styles.ruleAppliesTo}>
      {entry.schemas.length === 0
        ? t('records.assistant.ruleAppliesToAll')
        : t('records.assistant.ruleAppliesTo', { schemas: entry.schemas.join(', ') })}
    </p>
  );
}

// Red warnings for one rule fragment (docs request, Suggest Rule round,
// Part 4) -- same style as the BRDP text's vocabulary warning. Malformed
// XML and an invalid XPath expression disable Accept; name warnings never do.
function RuleValidationWarnings({ validation, standard }) {
  const { t } = useTranslation();
  const { wellFormed, wellFormedError, invalidXPaths, names } = validation;
  return (
    <>
      {!wellFormed && (
        <p className={styles.vocabWarning}>
          ⚠ {t('records.assistant.ruleNotWellFormed', { error: wellFormedError })}
        </p>
      )}
      {invalidXPaths.map((expression) => (
        <p key={expression} className={styles.vocabWarning}>
          ⚠ {t('records.assistant.ruleInvalidXPath', { expression })}
        </p>
      ))}
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

function acceptDisabledTitle(t, canEdit, validation) {
  if (!canEdit) return t('records.assistant.acceptDisabledTitle');
  if (!validation.wellFormed) return t('records.assistant.ruleAcceptDisabledMalformed');
  if (validation.invalidXPaths.length > 0) return t('records.assistant.ruleAcceptDisabledInvalidXPath');
  return undefined;
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
  brdp,
  aiProvider,
  onAccept,
  onDiscard,
  onToggleReference,
  onPastedRuleChange,
  onAcceptPasted,
  onEnsurePastedCoverage,
  onTestResult,
}) {
  const { t } = useTranslation();
  const [copyStatus, setCopyStatus] = useState(null); // null | 'copied' | 'failed'
  // Test rule (T2): runs on the rule in memory, already wrapped in its
  // context blocks -- before Accept.
  const [testOpen, setTestOpen] = useState(false);
  const testable = !!entry.text && canTestRule(entry.format);

  const generatedValidation = entry.text ? validateRuleXml(entry.text, vocabulary) : null;
  const pasted = (entry.pastedRule || '').trim();
  // A pasted rule is validated -- and shown -- exactly as it will be saved:
  // wrapped in the chosen schemas' context blocks.
  const pastedFinal = pasted ? finalRuleXml(entry, pasted) : '';
  const pastedValidation = pasted ? validateRuleXml(pastedFinal, vocabulary) : null;
  const hasSchemas = (entry.schemas || []).length > 0;

  // Coverage of the pasted rule's element names, for the per-schema
  // warning -- fetched once typing pauses. (The callback is a fresh closure
  // every render; only the text and the schema choice re-arm the timer.)
  useEffect(() => {
    if (!pasted || !hasSchemas || !onEnsurePastedCoverage) return undefined;
    const timer = setTimeout(() => onEnsurePastedCoverage(pasted), 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pasted, hasSchemas]);

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
      {/* Red, same style as the vocabulary warnings (Suggest Rule
          adjustments round): the user has to act on it -- there is no
          rule to accept. */}
      {entry.notCheckable !== undefined && (
        <p className={styles.vocabWarning}>
          ⚠{' '}
          {t('records.assistant.ruleNotCheckable', { reason: entry.notCheckable })}
        </p>
      )}
      {(entry.text || entry.notCheckable !== undefined) && <AppliesTo entry={entry} />}
      {entry.text && (
        <>
          <div className={styles.suggestionCode}>{entry.text}</div>
          <RuleValidationWarnings validation={generatedValidation} standard={standard} />
          <SchemaCoverageWarnings ruleXml={entry.text} entry={entry} />
        </>
      )}

      <div className={styles.suggestionActions}>
        {testable && <TestRuleButton aiProvider={aiProvider} open={testOpen} onToggle={() => setTestOpen((v) => !v)} />}
        {entry.text && (
          <button
            onClick={onAccept}
            disabled={!canEdit || !generatedValidation.acceptable}
            title={acceptDisabledTitle(t, canEdit, generatedValidation)}
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
      {testable && testOpen && aiProvider && (
        <RuleTestPanel
          key={entry.text}
          ruleXml={entry.text}
          format={entry.format}
          standard={standard}
          schemaLocation={entry.schemaLocation}
          brdp={brdp}
          aiProvider={aiProvider}
          vocabulary={vocabulary}
          onClose={() => setTestOpen(false)}
          onResult={(record) => onTestResult?.(entry.text, record)}
        />
      )}

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
          {pasted && hasSchemas && pastedFinal !== pasted && (
            <>
              <AppliesTo entry={entry} />
              <div className={styles.suggestionCode}>{pastedFinal}</div>
            </>
          )}
          {pastedValidation && <RuleValidationWarnings validation={pastedValidation} standard={standard} />}
          {pasted && <SchemaCoverageWarnings ruleXml={pastedFinal} entry={entry} />}
          {pasted && (
            <div className={styles.suggestionActions}>
              <button
                onClick={onAcceptPasted}
                disabled={!canEdit || !pastedValidation.acceptable}
                title={acceptDisabledTitle(t, canEdit, pastedValidation)}
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
