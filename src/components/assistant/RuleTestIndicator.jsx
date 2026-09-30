import { useTranslation } from 'react-i18next';
import styles from '../../pages/RecordsPage.module.css';
import { formatRuleTestReason } from '../../utils/ruleTestReasons.js';
import { ruleTestStatus } from '../../utils/ruleTestStatus.js';

const INDICATOR_TONE = {
  passed: 'ruleTestToneOk',
  failed: 'ruleTestToneBad',
  not_executable: 'ruleTestToneWarn',
  inconclusive: 'ruleTestToneWarn',
  outdated: 'ruleTestToneWarn',
  not_tested: 'ruleTestToneNeutral',
};

function formatDate(value, language) {
  if (!value) return '';
  return new Date(value).toLocaleDateString(language, { year: 'numeric', month: 'short', day: 'numeric' });
}

// Test de reglas T3, Part 2: the recorded test of the saved rule, in the
// Rule Status box. The reason is a code translated here, so it follows the
// interface language.
export function RuleTestIndicator({ approval }) {
  const { t, i18n } = useTranslation();
  const status = ruleTestStatus(approval);
  const date = formatDate(status.at, i18n.language);
  const reason = formatRuleTestReason(status.reason, t);
  const text = {
    passed:
      status.editedCount > 0
        ? t('records.ruleTest.indicator.passedEdited', { date, count: status.editedCount })
        : t('records.ruleTest.indicator.passed', { date }),
    failed: t('records.ruleTest.indicator.failed'),
    inconclusive: t('records.ruleTest.indicator.inconclusive'),
    not_executable: t('records.ruleTest.indicator.notExecutable', { reason }),
    not_tested: t('records.ruleTest.indicator.notTested'),
    outdated: t('records.ruleTest.indicator.outdated'),
  }[status.kind];
  const title = {
    passed:
      status.editedCount > 0
        ? t('records.ruleTest.indicator.passedEditedTitle', { date, count: status.editedCount })
        : t('records.ruleTest.indicator.passedTitle', { date }),
    failed: t('records.ruleTest.indicator.failedTitle', { date, reason }),
    inconclusive: t('records.ruleTest.indicator.inconclusiveTitle', { date, reason }),
    not_executable: undefined,
    not_tested: t('records.ruleTest.indicator.notTestedTitle'),
    outdated: t('records.ruleTest.indicator.outdatedTitle', { date }),
  }[status.kind];
  return (
    <p
      className={`${styles.ruleTestIndicator} ${styles[INDICATOR_TONE[status.kind]]}`}
      title={title}
      data-testid="rule-test-indicator"
      data-state={status.kind}
      data-edited={status.editedCount || undefined}
    >
      {text}
    </p>
  );
}

// Test de reglas T3, Part 3: the warning before Verify -- never a block.
// `warning` comes from utils/ruleTestStatus.js's verifyWarning.
export function VerifyWarningDialog({ warning, busy, onTestNow, onVerifyAnyway, onCancel }) {
  const { t } = useTranslation();
  const reason = formatRuleTestReason(warning.reason, t);
  const message = {
    not_tested: t('records.ruleTest.verifyDialog.notTested'),
    outdated: t('records.ruleTest.verifyDialog.outdated'),
    failed: t('records.ruleTest.verifyDialog.failed', { reason }),
    inconclusive: t('records.ruleTest.verifyDialog.inconclusive', { reason }),
    not_executable: t('records.ruleTest.verifyDialog.notExecutable', { reason }),
    passed_edited: t('records.ruleTest.verifyDialog.passedEdited', { count: warning.editedCount }),
  }[warning.kind];
  return (
    <div className={styles.modalOverlay} onClick={onCancel}>
      <div
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="verify-warning-title"
        data-testid="verify-warning-dialog"
        data-kind={warning.kind}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="verify-warning-title" className={styles.modalTitle}>
          {t('records.ruleTest.verifyDialog.title')}
        </h3>
        <p className={styles.modalMessage}>{message}</p>
        {warning.kind === 'not_executable' && <p className={styles.hint}>{t('records.ruleTest.verifyDialog.notExecutableNote')}</p>}
        <div className={styles.suggestionActions}>
          {warning.canTestNow && (
            <button type="button" onClick={onTestNow} disabled={busy}>
              {t('records.ruleTest.verifyDialog.testNow')}
            </button>
          )}
          <button type="button" onClick={onVerifyAnyway} disabled={busy}>
            {t('records.ruleTest.verifyDialog.verifyAnyway')}
          </button>
          <button type="button" onClick={onCancel} disabled={busy} autoFocus>
            {t('records.ruleTest.verifyDialog.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}
