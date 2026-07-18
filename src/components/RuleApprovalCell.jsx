import { useState, useEffect } from 'react';
import { getApproval, deleteApproval, approveApproval, proposeApproval } from '../api/approvals';
import { useBRDPContext } from '../context/BRDPContext';
import styles from './BRDPTable.module.css';

const FORMAT_LABELS = {
  'BREX-3.0.1': 'BREX 3.0.1',
  'BREX-4.1': 'BREX 4.1',
  'BREX-4.2': 'BREX 4.2',
  'SCH-S1000D': 'Schematron S1000D',
  'SCH-DITA': 'Schematron DITA',
};

// Human-readable label for a rule_approvals row's status, used as the
// oldValue/newValue text in the BRDP's own Change History (see
// appendHistoryEntry in BRDPContext.jsx) -- distinct from FORMAT_LABELS,
// which names the S1000D/DITA format itself.
function statusLabel(approval) {
  if (!approval) return '';
  return approval.status === 'approved' ? 'Approved' : 'Pending review';
}

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
  const { appendHistoryEntry } = useBRDPContext();
  const [approval, setApproval] = useState(null); // null = none/loading
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const historyField = `rule_approval (${FORMAT_LABELS[primaryFormat] || primaryFormat})`;

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

  // Manual edit mode -- available whether or not an approval already exists
  // (editing an existing pending_review/approved rule, or writing one from
  // scratch). Saving always freezes it as 'approved' with source='manual':
  // a human who just wrote/reviewed the rule_xml themselves has nothing left
  // to re-review, unlike an LLM proposal.
  const handleStartEdit = (e) => {
    e.stopPropagation?.();
    setDraft(approval?.rule_xml || '');
    setEditing(true);
  };

  const handleCancelEdit = (e) => {
    e.stopPropagation?.();
    setEditing(false);
  };

  const handleSaveEdit = async (e) => {
    e.stopPropagation?.();
    setBusy(true);
    try {
      const oldLabel = statusLabel(approval);
      await proposeApproval(brdpId, primaryFormat, draft, 'manual', 'approved');
      setEditing(false);
      await reload();
      appendHistoryEntry(brdpId, historyField, oldLabel, 'Approved (manual)');
    } finally {
      setBusy(false);
    }
  };

  const handleRevoke = async (e) => {
    e.stopPropagation?.();
    if (!window.confirm('Revoke this approval? The rule will go through the LLM again next time it is generated.')) return;
    setBusy(true);
    try {
      await deleteApproval(brdpId, primaryFormat);
      setApproval(null);
      appendHistoryEntry(brdpId, historyField, 'Approved', 'Revoked');
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
      appendHistoryEntry(brdpId, historyField, 'Pending review', 'Discarded');
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
      appendHistoryEntry(brdpId, historyField, 'Pending review', 'Approved');
    } finally {
      setBusy(false);
    }
  };

  if (!primaryFormat) {
    return <span className={styles.noFormat}>No format selected</span>;
  }

  if (editing) {
    return (
      <div className={styles.approvalDetails} onClick={(e) => e.stopPropagation()}>
        <textarea
          className={styles.ruleEditTextarea}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Paste or write the rule XML fragment for this BRDP…"
          rows={8}
          autoFocus
        />
        <div className={styles.approvalActions}>
          <button className={styles.approveBtn} onClick={handleSaveEdit} disabled={busy || !draft.trim()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button className={styles.discardBtn} onClick={handleCancelEdit} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (!approval) {
    return (
      <div className={styles.approvalActions}>
        <button
          className={styles.approvalPendingBtn}
          disabled
          title={`Coming soon (${FORMAT_LABELS[primaryFormat] || primaryFormat})`}
          onClick={(e) => e.stopPropagation()}
        >
          Generate &amp; review rule
        </button>
        <button className={styles.ruleEditBtn} onClick={handleStartEdit}>
          Create manually
        </button>
      </div>
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
          <button className={styles.ruleEditBtn} onClick={handleStartEdit} disabled={busy}>
            Edit
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
      <div className={styles.approvalActions}>
        <button className={styles.ruleEditBtn} onClick={handleStartEdit} disabled={busy}>
          Edit
        </button>
        <button className={styles.revokeBtn} onClick={handleRevoke} disabled={busy}>
          {busy ? 'Revoking…' : 'Revoke'}
        </button>
      </div>
    </details>
  );
}
