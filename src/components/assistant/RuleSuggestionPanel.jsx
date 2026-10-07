import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import styles from '../../pages/RecordsPage.module.css';
import ReferenceRow from './ReferenceRow';
import RulePathWarnings from './RulePathWarnings.jsx';
import RuleTestPanel, { canTestRule, TestRuleButton } from './RuleTestPanel';
import { finalRuleXml, ruleIdsNote, ruleSplitNote, validateRuleXml } from '../../hooks/useSuggestions';
import { NAME_HINT_TEST_IDS, extractRuleNames, nameIssues, ruleFormatIssues, xpathIssues } from '../../validation/schemaValidation.js';
import SchemaIssueLines from './SchemaIssueLines';
import RuleLintWarnings from './RuleLintWarnings';
import RuleThresholdWarning from './RuleThresholdWarning';
import { useNameFixHints } from '../../hooks/useNameFixHints.js';
import { checkRuleSchemaCoverage, supportsSchemaContext } from '../../utils/ruleSchemaContext.js';
import { engineErrorText } from '../../utils/ruleTestReasons.js';

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

// Every rule-format problem shares one test id.
const RULE_FORMAT_TEST_IDS = Object.fromEntries(
  ['rule_format_missing', 'rule_format_text', 'rule_format_wrapper', 'rule_format_empty_block', 'rule_format_other_format', 'rule_format_foreign'].map(
    (code) => [code, 'rule-format-error']
  )
);

// Red warnings for one rule fragment (docs request, Suggest Rule round,
// Part 4) -- same style as the BRDP text's vocabulary warning. Malformed
// XML, an invalid XPath expression and content that is not a rule of the
// project's format (C2, Part 0) disable Accept; name warnings never do.
export function RuleValidationWarnings({ validation, standard, proposal = null }) {
  const { t } = useTranslation();
  const { wellFormed, wellFormedError, invalidXPaths, names } = validation;
  // Near names / other standards for the rule's names: a line only, no
  // one-click fix (the XML is corrected by hand).
  const hints = useNameFixHints(names, standard);
  return (
    <>
      {!wellFormed && (
        <p className={styles.vocabWarning}>
          ⚠ {t('records.assistant.ruleNotWellFormed', { error: wellFormedError })}
        </p>
      )}
      <SchemaIssueLines
        issues={[...ruleFormatIssues(validation.ruleFormat), ...xpathIssues(invalidXPaths), ...nameIssues(names, 'rule', { standard, hints })]}
        testIds={{ ...RULE_FORMAT_TEST_IDS, ...NAME_HINT_TEST_IDS }}
      />
      {/* Barrido final 2/2, Part 2: the lint's warnings, never blocking. */}
      {validation.acceptable && <RuleLintWarnings ruleXml={validation.xml} format={validation.format} place="suggestion" />}
      {/* Mejoras B, Part 2: the rule's threshold against the Proposal's numbers (amber). */}
      {validation.acceptable && proposal != null && <RuleThresholdWarning ruleXml={validation.xml} format={validation.format} proposal={proposal} />}
    </>
  );
}

function acceptDisabledTitle(t, canEdit, validation) {
  if (!canEdit) return t('records.assistant.acceptDisabledTitle');
  if (!validation.wellFormed) return t('records.assistant.ruleAcceptDisabledMalformed');
  if (validation.ruleFormat && !validation.ruleFormat.ok) return t('records.assistant.ruleAcceptDisabledFormat');
  if (validation.invalidXPaths.length > 0) return t('records.assistant.ruleAcceptDisabledInvalidXPath');
  return undefined;
}

// Mejoras A, Part 3: the rule had N objectPath with N objectUse and the
// application split it into N rules (ruleSplit.js).
function RuleSplitNote({ split }) {
  const { t } = useTranslation();
  if (!split) return null;
  return (
    <p className={styles.hint} data-testid="rule-split-note">
      {t('records.assistant.ruleSplit', { count: split.count, path: split.path })}
    </p>
  );
}

// Mejoras B, Part 4.3: rules with the same id were numbered {id}-1 … {id}-N.
export function RuleIdsNote({ renamed }) {
  const { t } = useTranslation();
  if (!renamed || renamed.length === 0) return null;
  return (
    <p className={styles.hint} data-testid="rule-ids-note">
      {renamed.map((r) => t('records.assistant.ruleIdsNumbered', { id: r.id, ids: r.to.join(', ') })).join(' ')}
    </p>
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
  brdp,
  aiProvider,
  onAccept,
  onDiscard,
  onToggleReference,
  onPastedRuleChange,
  onRuleTextChange,
  onAcceptPasted,
  onEnsurePastedCoverage,
  onTestResult,
  onSuggestCorrectedRule,
  correctedRuleBlockedReason,
}) {
  const { t } = useTranslation();
  const [copyStatus, setCopyStatus] = useState(null); // null | 'copied' | 'failed'
  // Test rule (T2): runs on the rule in memory, already wrapped in its
  // context blocks -- before Accept.
  const [testOpen, setTestOpen] = useState(false);
  const testable = !!entry.text && canTestRule(entry.format);

  const generatedValidation = entry.text ? validateRuleXml(entry.text, vocabulary, entry.format) : null;
  const pasted = (entry.pastedRule || '').trim();
  // A pasted rule is validated -- and shown -- exactly as it will be saved:
  // wrapped in the chosen schemas' context blocks.
  const pastedFinal = pasted ? finalRuleXml(entry, pasted) : '';
  const pastedValidation = pasted ? validateRuleXml(pastedFinal, vocabulary, entry.format) : null;
  const pastedSplit = pasted ? ruleSplitNote(entry, pasted) : null;
  const pastedIds = pasted ? ruleIdsNote(entry, pasted) : null;
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
      {entry.correctedFromTest && !entry.correctedEngineErrors?.length && (
        <p className={styles.hint} data-testid="rule-corrected-note">
          {t('records.ruleTest.review.correctedNote')}
        </p>
      )}
      {/* Mejoras E, Part 2.3: the new rule gives an error on the failed
          test's examples -- offered, but never as "corrected". */}
      {entry.correctedFromTest &&
        (entry.correctedEngineErrors || []).map((e, i) => (
          <p key={i} className={styles.vocabWarning} data-testid="rule-corrected-engine-error">
            ⚠ {t('records.ruleTest.review.correctedEngineError', { label: e.label, detail: engineErrorText(e, t) })}
          </p>
        ))}
      {(entry.text || entry.notCheckable !== undefined) && <AppliesTo entry={entry} />}
      {entry.text && (
        <>
          <div className={styles.suggestionCode}>{entry.text}</div>
          <RuleSplitNote split={entry.split} />
          <RuleIdsNote renamed={entry.idsRenamed} />
          <RuleValidationWarnings validation={generatedValidation} standard={standard} proposal={brdp?.proposal ?? null} />
          <RulePathWarnings
            ruleXml={entry.text}
            format={entry.format}
            standard={standard}
            schemaLocation={entry.schemaLocation}
            onApplyFix={onRuleTextChange}
            testId="suggested-rule-path-warning"
          />
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
          recordsOnAccept
          onSuggestCorrectedRule={onSuggestCorrectedRule}
          correctedRuleBlockedReason={correctedRuleBlockedReason}
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
          {pasted && pastedFinal !== pasted && (
            <>
              {hasSchemas && <AppliesTo entry={entry} />}
              <div className={styles.suggestionCode}>{pastedFinal}</div>
            </>
          )}
          <RuleSplitNote split={pastedSplit} />
          <RuleIdsNote renamed={pastedIds} />
          {pastedValidation && <RuleValidationWarnings validation={pastedValidation} standard={standard} proposal={brdp?.proposal ?? null} />}
          {pasted && pastedValidation?.wellFormed && (
            <RulePathWarnings
              ruleXml={pastedFinal}
              fixXml={entry.pastedRule || ''}
              format={entry.format}
              standard={standard}
              schemaLocation={entry.schemaLocation}
              onApplyFix={onPastedRuleChange}
              testId="pasted-rule-path-warning"
            />
          )}
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
