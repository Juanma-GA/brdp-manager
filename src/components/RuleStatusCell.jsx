import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { authFetchJson } from '../services/apiClient';
import { ruleStateOf } from '../utils/ruleState';
import RuleStatusDots from './RuleStatusDots';
import styles from '../pages/RecordsPage.module.css';

// Read-only summary for the table column -- the Edit/Verify/Revoke actions
// and the manual rule editor live in the detail panel, tied to whichever
// row is selected (see RecordsPage.jsx's Rule Status section).
export default function RuleStatusCell({ projectId, brdpId, format, refreshToken }) {
  const { t } = useTranslation();
  const [approval, setApproval] = useState(undefined); // undefined = loading, null = none

  useEffect(() => {
    if (!format) return;
    let cancelled = false;
    authFetchJson(`/api/projects/${projectId}/brdps/${brdpId}/approvals/${format}`).then((data) => {
      if (!cancelled) setApproval(data);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, brdpId, format, refreshToken]);

  if (!format) {
    return (
      <span className={styles.muted} title={t('records.rule.unsupportedStandard')}>
        —
      </span>
    );
  }
  if (approval === undefined) return <span className={styles.muted}>…</span>;
  return <RuleStatusDots state={ruleStateOf(approval)} />;
}
