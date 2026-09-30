import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import styles from '../../pages/RecordsPage.module.css';
import { runExample } from '../../utils/ruleTest.js';
import { runSavedTest, savedExamplesDate } from '../../utils/ruleTestSaved.js';
import { passedTestToReplaceAt } from '../../utils/ruleTestStatus.js';
import { ExampleCard, ReplacePassedQuestion, TONE_CLASS, formatTestDate, verdictView } from './RuleTestPanel';

// Guardar la prueba aprobada: the last passed test of the rule, read-only --
// the rule it was tested with and each example as it ran, with the same
// look as the Test rule panel (the application's skeleton dimmed, the result
// of each example). The engine runs the kept rule on the kept documents
// again only to highlight what it selected; nothing is called, nothing is
// saved.
// `saved` comes from utils/ruleTestSaved.js's savedPassedTest.
//
// "Probar con los ejemplos guardados" (`rerun`, a Draft rule only): the
// CURRENT rule on the same documents -- no LLM, immediate. Each example whose
// result changed is marked; the result is registered like any test (a pass
// as "Tested ✓ (examples from the test of <date>)"), asking first before
// replacing a passed test.
//   rerun: { ruleXml, approval (editor) | null, onRecord(record) -> bool,
//            onKeepPrevious(record) -> bool } | null
export default function SavedRuleTestPanel({ saved, format, standard, vocabulary, onClose, rerun = null }) {
  const { t, i18n } = useTranslation();
  const keptRuns = useMemo(
    () => saved.examples.map((ex) => runExample(saved.ruleXml, format, ex, { vocabulary })),
    [saved, format, vocabulary]
  );
  const date = formatTestDate(saved.at, i18n.language);
  const examplesDate = savedExamplesDate(saved);
  // The last run on the current rule; shown while it is for that rule and
  // these examples (a registered pass keeps the same examples).
  const [lastRun, setLastRun] = useState(null);
  const [question, setQuestion] = useState(null);
  const [answer, setAnswer] = useState(null);
  const [recorded, setRecorded] = useState(null);

  const current = lastRun && rerun && lastRun.ruleXml === rerun.ruleXml && lastRun.examplesDate === examplesDate ? lastRun : null;
  const runs = current ? current.runs : keptRuns;

  const record = async (rec) => {
    const ok = await rerun.onRecord?.(rec);
    setRecorded(ok ? rec : null);
  };
  const runOnSaved = () => {
    const result = runSavedTest(saved, rerun.ruleXml, format, { vocabulary });
    setLastRun({ ...result, ruleXml: rerun.ruleXml, examplesDate });
    setQuestion(null);
    setAnswer(null);
    setRecorded(null);
    if (!rerun.approval) return;
    const at = passedTestToReplaceAt(rerun.approval, result.record, { includeOutdated: true });
    if (at !== null) setQuestion({ record: result.record, at });
    else record(result.record);
  };
  const answerQuestion = async (register) => {
    const q = question;
    setQuestion(null);
    if (register) {
      await record(q.record);
    } else {
      const kept = await rerun.onKeepPrevious?.(q.record);
      setAnswer(kept === false ? null : { kept: true, at: q.at });
    }
  };
  const view = current ? verdictView(t, current.verdict, standard) : null;

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
      {rerun && (
        <div className={styles.suggestionActions}>
          <button type="button" onClick={runOnSaved} data-testid="saved-rule-test-rerun">
            {t('records.ruleTest.saved.rerun')}
          </button>
        </div>
      )}
      {current && (
        <>
          <p className={styles.hint} data-testid="saved-rule-test-rerun-heading">
            {t('records.ruleTest.saved.rerunHeading')}
          </p>
          <p className={`${styles.ruleTestVerdict} ${styles[TONE_CLASS[view.tone]]}`} data-testid="saved-rule-test-verdict" data-kind={current.verdict.kind}>
            {view.text}
          </p>
          {current.changed.length > 0 && (
            <p className={`${styles.ruleTestNote} ${styles.ruleTestToneWarn}`} data-testid="saved-rule-test-changed-summary">
              {t('records.ruleTest.saved.changedSummary', {
                count: current.changed.length,
                labels: current.changed.map((i) => saved.examples[i].label).join(', '),
              })}
            </p>
          )}
          <ReplacePassedQuestion question={question} answer={answer} onAnswer={answerQuestion} />
          {recorded && (
            <p className={`${styles.ruleTestNote} ${styles[TONE_CLASS[recorded.result === 'passed' ? 'ok' : 'warn']]}`} data-testid="saved-rule-test-recorded" data-result={recorded.result}>
              {recorded.result === 'passed'
                ? t('records.ruleTest.saved.recordedPassed', { from: formatTestDate(examplesDate, i18n.language) })
                : t('records.ruleTest.saved.recorded', { result: t(`records.ruleTest.results.${recorded.result}`) })}
            </p>
          )}
        </>
      )}
      <p className={styles.hint}>{t(current ? 'records.ruleTest.saved.currentRuleLabel' : 'records.ruleTest.saved.ruleLabel')}</p>
      <pre className={styles.ruleTestXml} data-testid="saved-rule-test-rule">
        {current ? current.ruleXml : saved.ruleXml}
      </pre>
      <p className={styles.hint}>{t('records.ruleTest.skeletonLegend')}</p>
      {saved.examples.map((ex, i) => (
        <ExampleCard
          key={`${i}:${current ? 'rerun' : 'kept'}`}
          example={ex}
          run={runs[i]}
          index={i}
          standard={standard}
          dita={format === 'SCH-DITA'}
          showResult
          readOnly
          testIdPrefix="saved-rule-test-example"
          previousResult={current && current.changed.includes(i) ? ex.saved.result : null}
        />
      ))}
    </section>
  );
}
