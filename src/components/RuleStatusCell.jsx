import { useTranslation } from 'react-i18next';
import { ruleStateOf } from '../utils/ruleState';
import RuleStatusDots from './RuleStatusDots';
import styles from '../pages/RecordsPage.module.css';

// Read-only summary for the table column -- the Edit/Verify/Revoke actions
// and the manual rule editor live in the detail panel, tied to whichever
// row is selected (see RecordsPage.jsx's Rule Status section).
//
// `approvals` is the page's one request for every BRDP's rule status:
// undefined while it loads, null when it failed (AACF 1, Part 2: no status
// shown -- never an invented "To Do"; the page says the load failed, with
// Retry), else brdp_id -> { status }.
export default function RuleStatusCell({ approvals, brdpId, format }) {
  const { t } = useTranslation();
  if (!format) {
    return (
      <span className={styles.muted} title={t('records.rule.unsupportedStandard')}>
        —
      </span>
    );
  }
  if (approvals === undefined) return <span className={styles.muted}>…</span>;
  if (approvals === null) {
    return (
      <span className={styles.muted} title={t('records.loadErrors.approvalsCell')} data-testid="rule-status-unknown">
        ?
      </span>
    );
  }
  return <RuleStatusDots state={ruleStateOf(approvals[brdpId] ?? null)} />;
}
