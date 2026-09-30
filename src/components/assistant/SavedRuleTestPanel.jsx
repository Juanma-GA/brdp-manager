import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import styles from '../../pages/RecordsPage.module.css';
import { runExample } from '../../utils/ruleTest.js';
import { savedExamplesDate } from '../../utils/ruleTestSaved.js';
import { ExampleCard, formatTestDate } from './RuleTestPanel';

// Guardar la prueba aprobada: the last passed test of the rule, read-only --
// the rule it was tested with and each example as it ran, with the same
// look as the Test rule panel (the application's skeleton dimmed, the result
// of each example). The engine runs the kept rule on the kept documents
// again only to highlight what it selected; nothing is called, nothing is
// saved.
// `saved` comes from utils/ruleTestSaved.js's savedPassedTest.
export default function SavedRuleTestPanel({ saved, format, standard, vocabulary, onClose }) {
  const { t, i18n } = useTranslation();
  const runs = useMemo(
    () => saved.examples.map((ex) => runExample(saved.ruleXml, format, ex, { vocabulary })),
    [saved, format, vocabulary]
  );
  const date = formatTestDate(saved.at, i18n.language);
  const examplesDate = savedExamplesDate(saved);

  return (
    <section className={styles.ruleTestPanel} aria-label={t('records.ruleTest.saved.title', { date })} data-testid="saved-rule-test-panel">
      <div className={styles.ruleTestHead}>
        <h4 className={styles.ruleTestTitle}>{t('records.ruleTest.saved.title', { date })}</h4>
        <button type="button" className={styles.linkButton} onClick={onClose}>
          {t('records.ruleTest.close')}
        </button>
      </div>
      {saved.ruleChanged && (
        <p className={`${styles.ruleTestNote} ${styles.ruleTestToneWarn}`} data-testid="saved-rule-test-rule-changed">
          ⚠ {t('records.ruleTest.saved.ruleChanged')}
        </p>
      )}
      {saved.proposalChanged && (
        <p className={`${styles.ruleTestNote} ${styles.ruleTestToneWarn}`} data-testid="saved-rule-test-proposal-changed">
          ⚠ {t('records.ruleTest.saved.proposalChanged')}
        </p>
      )}
      {saved.examplesFrom && (
        <p className={styles.ruleTestNote} data-testid="saved-rule-test-examples-from">
          {t('records.ruleTest.saved.examplesFrom', { date: formatTestDate(examplesDate, i18n.language) })}
        </p>
      )}
      {saved.editedCount > 0 && (
        <p className={styles.ruleTestNote} data-testid="saved-rule-test-edited">
          {t('records.ruleTest.saved.edited', { count: saved.editedCount })}
        </p>
      )}
      <p className={styles.hint}>{t('records.ruleTest.saved.ruleLabel')}</p>
      <pre className={styles.ruleTestXml} data-testid="saved-rule-test-rule">
        {saved.ruleXml}
      </pre>
      <p className={styles.hint}>{t('records.ruleTest.skeletonLegend')}</p>
      {saved.examples.map((ex, i) => (
        <ExampleCard
          key={i}
          example={ex}
          run={runs[i]}
          index={i}
          standard={standard}
          dita={format === 'SCH-DITA'}
          showResult
          readOnly
          testIdPrefix="saved-rule-test-example"
        />
      ))}
    </section>
  );
}
