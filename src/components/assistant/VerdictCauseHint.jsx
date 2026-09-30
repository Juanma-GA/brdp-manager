import { useTranslation } from 'react-i18next';
import styles from '../../pages/RecordsPage.module.css';
import { verdictCause } from '../../utils/ruleTest.js';

// The message under a failed verdict, by its likely cause (utils/ruleTest.js
// verdictCause): the examples are the AI's and may be what is wrong, or every
// example ran and the rule gave the wrong result on one -- then the example
// is what to check, and "Revisar con el asistente" is right below.
export default function VerdictCauseHint({ verdict, runs }) {
  const { t } = useTranslation();
  const cause = verdictCause(verdict, runs);
  if (!cause) return null;
  if (cause.cause === 'examples') {
    return (
      <p className={`${styles.ruleTestNote} ${styles.ruleTestToneWarn}`} data-testid="rule-test-cause" data-cause="examples">
        {t('records.ruleTest.cause.examples')}
      </p>
    );
  }
  const both = cause.permissive && cause.strict;
  const what = both ? 'ruleBoth' : cause.permissive ? 'rulePermissive' : 'ruleStrict';
  return (
    <p className={`${styles.ruleTestNote} ${styles.ruleTestToneBad}`} data-testid="rule-test-cause" data-cause="rule">
      {t(`records.ruleTest.cause.${what}`)} {t('records.ruleTest.cause.checkExample', { count: both ? 2 : 1 })}
    </p>
  );
}
