import { useTranslation } from 'react-i18next';
import styles from '../../pages/RecordsPage.module.css';
import { useRuleReach } from '../../hooks/useRuleReach.js';
import { listElementNames, reachBeyondProposal } from '../../validation/ruleRepetition.js';

// Mejoras G, Part 2.1: a "*[@a]" step reaches every element that can go
// there and has @a -- amber, never blocking, when the Proposal names marked
// elements and the rule also reaches others ("The rule also reaches
// <cblst>, which the Proposal does not mention"). In the test panel and
// under a suggested or pasted rule.
export default function RuleReachWarning({ ruleXml, format, standard, schemaLocation = null, proposal = null, testId = 'rule-reach-warning' }) {
  const { t, i18n } = useTranslation();
  const reach = useRuleReach(ruleXml, format, standard, schemaLocation);
  const beyond = proposal ? reachBeyondProposal(reach, proposal) : [];
  if (beyond.length === 0) return null;
  return (
    <p className={`${styles.ruleTestNote} ${styles.ruleTestToneWarn}`} data-testid={testId}>
      ⚠ {t('records.ruleTest.reach.beyond', { names: listElementNames(beyond, i18n.language) })}
    </p>
  );
}
