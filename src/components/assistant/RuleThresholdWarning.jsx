import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import styles from '../../pages/RecordsPage.module.css';
import { thresholdMismatch } from '../../utils/ruleThreshold.js';
import { formatThresholdMismatch } from '../../utils/ruleTestReasons.js';

// Mejoras B, Part 2: amber, never blocking -- the Proposal's numbers match
// no border of the rule's threshold ("The Proposal speaks of 5; the rule
// allows up to 6 levels and rejects from level 7 on").
export default function RuleThresholdWarning({ ruleXml, format, proposal }) {
  const { t } = useTranslation();
  const mismatch = useMemo(() => (ruleXml && format ? thresholdMismatch(ruleXml, format, proposal) : null), [ruleXml, format, proposal]);
  if (!mismatch) return null;
  return (
    <p className={`${styles.ruleTestNote} ${styles.ruleTestToneWarn}`} data-testid="rule-threshold-warning">
      ⚠ {formatThresholdMismatch(mismatch, t)}
    </p>
  );
}
