import { useTranslation } from 'react-i18next';
import styles from '../../pages/RecordsPage.module.css';
import { ruleElementIds } from '../../utils/ruleSplit.js';

// Mejoras G, Part 2.2 b: a suggested, corrected or pasted rule whose id is
// already used by the saved rule of another BRDP of the project -- red,
// never blocking (Accept stays): two rules with the same id make the BREX
// invalid (xs:ID). `owners`: id → [{ brdpId, identifier }] of the project's
// saved rules (useRuleCorrections).
export default function RuleIdClashWarning({ ruleXml, format, owners, brdpId, testId = 'rule-id-clash' }) {
  const { t } = useTranslation();
  if (!owners || !ruleXml || !format) return null;
  const lines = [];
  for (const id of new Set(ruleElementIds(ruleXml, format))) {
    const others = (owners.get(id) || []).filter((o) => o.brdpId !== brdpId);
    if (others.length) lines.push({ id, identifiers: others.map((o) => o.identifier).join(', ') });
  }
  return lines.map((l) => (
    <p key={l.id} className={styles.vocabWarning} data-testid={testId}>
      ⚠ {t('records.ruleTest.idClash', { id: l.id, identifiers: l.identifiers })}
    </p>
  ));
}
