import { useState, useEffect } from 'react';
import { getApproval, deleteApproval, approveApproval } from '../api/approvals';
import styles from './BRDPTable.module.css';

const FORMAT_LABELS = {
  'BREX-3.0.1': 'BREX 3.0.1',
  'BREX-4.1': 'BREX 4.1',
  'BREX-4.2': 'BREX 4.2',
  'SCH-S1000D': 'Schematron S1000D',
  'SCH-DITA': 'Schematron DITA',
};

/**
 * Rule Approval cell component
 * Shows the frozen deterministic rule for the project's currently-active
 * format (ProjectConfig.primaryFormat), if any. Approvals are stored per
 * (BRDP, format) pair -- see src/api/approvals.js.
 * @param {string} brdpId - BRDP id
 * @param {string} primaryFormat - Project's currently-active format, or '' if unset
 * @param {number} [approvalsRefreshToken] - Bumped after every Generate attempt
 *   (see App.jsx) so this cell refetches instead of staying stale until a
 *   manual page reload -- Issue #15.
 * @returns {JSX.Element}
 */
export function RuleApprovalCell({ brdpId, primaryFormat, approvalsRefreshToken }) {
  const [approval, setApproval] = useState(null); // null = none/loading
  const [busy, setBusy] = useState(false);

  const reload = () => {
    if (!primaryFormat) {
      setApproval(null);
      return Promise.resolve();
    }
    return getApproval(brdpId, primaryFormat).then((data) => setApproval(data));
  };

  useEffect(() => {
    if (!primaryFormat) {
      setApproval(null);
      return;
    }
    let cancelled = false;
    getApproval(brdpId, primaryFormat).then((data) => {
      if (!cancelled) setApproval(data);
    });
    return () => {
      cancelled = true;
    };
  }, [brdpId, primaryFormat, approvalsRefreshToken]);

  const handleRevoke = async (e) => {
    e.stopPropagation?.();
    if (!window.confirm('Revoke this approval? The rule will go through the LLM again next time it is generated.')) return;
    setBusy(true);
    try {
      await deleteApproval(brdpId, primaryFormat);
      setApproval(null);
    } finally {
      setBusy(false);
    }
  };

  const handleDiscard = async (e) => {
    e.stopPropagation?.();
    setBusy(true);
    try {
      await deleteApproval(brdpId, primaryFormat);
      setApproval(null);
    } finally {
      setBusy(false);
    }
  };

  const handleApprove = async (e) => {
    e.stopPropagation?.();
    setBusy(true);
    try {
      await approveApproval(brdpId, primaryFormat);
      await reload();
    } finally {
      setBusy(false);
    }
  };

  if (!primaryFormat) {
    return <span className={styles.noFormat}>No format selected</span>;
  }

  if (!approval) {
    return (
      <button
        className={styles.approvalPendingBtn}
        disabled
        title={`Coming soon (${FORMAT_LABELS[primaryFormat] || primaryFormat})`}
        onClick={(e) => e.stopPropagation()}
      >
        Generate &amp; review rule
      </button>
    );
  }

  if (approval.status === 'pending_review') {
    return (
      <details className={styles.approvalDetails} onClick={(e) => e.stopPropagation()}>
        <summary className={styles.pendingBadge}>
          ⏳ Pending review <span className={styles.approvalSource}>({FORMAT_LABELS[primaryFormat] || primaryFormat} · {approval.source})</span>
        </summary>
        <pre className={styles.approvalXml}>{approval.rule_xml}</pre>
        <div className={styles.approvalActions}>
          <button className={styles.approveBtn} onClick={handleApprove} disabled={busy}>
            {busy ? 'Approving…' : 'Approve'}
          </button>
          <button className={styles.discardBtn} onClick={handleDiscard} disabled={busy}>
            {busy ? 'Discarding…' : 'Discard'}
          </button>
        </div>
      </details>
    );
  }

  return (
    <details className={styles.approvalDetails} onClick={(e) => e.stopPropagation()}>
      <summary className={styles.approvedBadge}>
        ✓ Approved <span className={styles.approvalSource}>({FORMAT_LABELS[primaryFormat] || primaryFormat} · {approval.source})</span>
      </summary>
      <pre className={styles.approvalXml}>{approval.rule_xml}</pre>
      <button className={styles.revokeBtn} onClick={handleRevoke} disabled={busy}>
        {busy ? 'Revoking…' : 'Revoke'}
      </button>
    </details>
  );
}
