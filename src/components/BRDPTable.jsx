import { useState, useEffect } from 'react';
import { Trash2 } from 'lucide-react';
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
 * Utility function to truncate text with ellipsis
 * @param {string} text - Text to truncate
 * @param {number} maxLength - Maximum character length
 * @returns {string} Truncated text with ellipsis if needed
 */
function truncate(text, maxLength) {
  if (!text) return '';
  return text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
}

/**
 * Validation badge component
 * Shows colored badge based on validation status
 * @param {string} status - Validation status: 'Validated', 'Refused', or 'Pending'
 * @returns {JSX.Element} Colored badge
 */
function ValidationBadge({ status }) {
  let badgeClass = styles.badge;

  if (status === 'Validated') {
    badgeClass += ` ${styles.validated}`;
  } else if (status === 'Refused') {
    badgeClass += ` ${styles.refused}`;
  } else if (status === 'Pending') {
    badgeClass += ` ${styles.pending}`;
  }

  return <span className={badgeClass}>{status}</span>;
}

/**
 * Rule Approval cell component
 * Shows the frozen deterministic rule for the project's currently-active
 * format (ProjectConfig.primaryFormat), if any. Approvals are stored per
 * (BRDP, format) pair -- see src/api/approvals.js.
 * @param {string} brdpId - BRDP id
 * @param {string} primaryFormat - Project's currently-active format, or '' if unset
 * @returns {JSX.Element}
 */
function RuleApprovalCell({ brdpId, primaryFormat }) {
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
  }, [brdpId, primaryFormat]);

  const handleRevoke = async (e) => {
    e.stopPropagation();
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
    e.stopPropagation();
    setBusy(true);
    try {
      await deleteApproval(brdpId, primaryFormat);
      setApproval(null);
    } finally {
      setBusy(false);
    }
  };

  const handleApprove = async (e) => {
    e.stopPropagation();
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

/**
 * Sort indicator component
 * Shows arrow icon for sort direction
 * @param {string} sortDir - Sort direction ('asc', 'desc', or '')
 * @returns {JSX.Element|null} Sort arrow icon or null
 */
function SortIndicator({ sortDir }) {
  if (!sortDir) return null;
  return <span className={styles.sortArrow}>{sortDir === 'asc' ? '↑' : '↓'}</span>;
}

/**
 * BRDP Table component
 * Displays BRDP records with sorting and pagination
 * @param {Object} props - Component props
 * @param {Array} props.rows - Array of BRDP records to display (already paginated)
 * @param {Function} props.onSelect - Callback when row is clicked (highlight + load context)
 * @param {Function} props.onEdit - Callback when edit button is clicked (open detail panel)
 * @param {string} [props.selectedId] - ID of currently selected row
 * @param {Function} props.onSort - Callback when column header is clicked
 * @param {string} props.sortField - Current sort field
 * @param {string} props.sortDir - Current sort direction
 * @param {number} props.currentPage - Current page number
 * @param {number} props.totalPages - Total number of pages
 * @param {number} props.total - Total records matching filter/search
 * @param {Function} props.onPageChange - Callback to change page
 * @param {boolean} props.noResults - Whether there are no results to display
 * @param {boolean} [props.noBrdps] - Whether there are no BRDPs at all (vs no search results)
 * @param {Function} [props.onGoToSettings] - Callback to navigate to settings
 * @returns {JSX.Element} Table displaying BRDP records with pagination
 */
export default function BRDPTable({
  rows,
  onSelect,
  onEdit,
  selectedIds = [],
  onSort,
  sortField,
  sortDir,
  currentPage,
  totalPages,
  total,
  onPageChange,
  noResults,
  noBrdps,
  onGoToSettings,
  editingBrdpId,
  isDirtyEditing,
  onDeleteSelected,
  primaryFormat,
}) {
  const [lastSelectedId, setLastSelectedId] = useState(null);
  /**
   * Get sort direction for a column
   * Cycles: none → asc → desc → none
   * @param {string} field - Column field name
   * @returns {string} Next sort direction
   */
  const getNextSortDir = (field) => {
    if (sortField !== field) return 'asc';
    if (sortDir === 'asc') return 'desc';
    if (sortDir === 'desc') return '';
    return 'asc';
  };

  /**
   * Handle sort header click
   * @param {string} field - Column field to sort by
   */
  const handleSort = (field) => {
    const nextDir = getNextSortDir(field);
    onSort(field, nextDir);
  };

  /**
   * Get class for sortable header
   * @param {string} field - Column field name
   * @returns {string} Combined class name
   */
  const getHeaderClass = (field) => {
    if (field !== 'id' && field !== 'validation') return '';
    let cls = styles.sortableHeader;
    if (sortField === field) {
      cls += ` ${styles.sorted}`;
    }
    return cls;
  };

  /**
   * Handle row click with support for multi-selection
   * Single click: select only this row
   * Ctrl/Cmd+Click: toggle this row in/out of selection
   * Shift+Click: select range from last clicked to this row
   */
  const handleRowClick = (brdp, e) => {
    e.stopPropagation();

    if (e.ctrlKey || e.metaKey) {
      // Ctrl/Cmd+Click: toggle selection
      onSelect(brdp, { mode: 'toggle' });
      setLastSelectedId(brdp.id);
    } else if (e.shiftKey) {
      // Shift+Click: range selection
      onSelect(brdp, { mode: 'range', lastSelectedId });
      setLastSelectedId(brdp.id);
    } else {
      // Single click: select only this row
      onSelect(brdp, { mode: 'single' });
      setLastSelectedId(brdp.id);
    }
  };

  if (noBrdps) {
    return (
      <div className={styles.container}>
        <div className={styles.emptyState}>
          <p className={styles.emptyMessage}>📋 No BRDPs loaded</p>
          <p className={styles.emptyHint}>Import an Excel file in Settings to get started</p>
          {onGoToSettings && (
            <button onClick={onGoToSettings} className={styles.settingsBtn}>
              Go to Settings
            </button>
          )}
        </div>
      </div>
    );
  }

  if (noResults) {
    return (
      <div className={styles.container}>
        <div className={styles.emptyState}>
          <p className={styles.emptyMessage}>🔍 No BRDPs found</p>
          <p className={styles.emptyHint}>Try adjusting your search or filters</p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      {selectedIds.length > 0 && (
        <div className={styles.selectionToolbar}>
          <span>{selectedIds.length} BRDP{selectedIds.length > 1 ? 's' : ''} selected</span>
          <button
            className={styles.deleteSelectedBtn}
            onClick={() => {
              if (window.confirm(`Delete ${selectedIds.length} BRDP${selectedIds.length > 1 ? 's' : ''}? This cannot be undone.`)) {
                onDeleteSelected(selectedIds);
              }
            }}
          >
            <Trash2 size={14} /> Delete selected
          </button>
        </div>
      )}
      <table className={styles.table}>
        <thead>
          <tr>
            <th className={styles.editHeader}></th>
            <th
              className={getHeaderClass('id')}
              onClick={() => handleSort('id')}
            >
              BRDP Identifier
              {sortField === 'id' && <SortIndicator sortDir={sortDir} />}
            </th>
            <th>Title</th>
            <th>Definition</th>
            <th>Proposal</th>
            <th
              className={getHeaderClass('validation')}
              onClick={() => handleSort('validation')}
            >
              Validation
              {sortField === 'validation' && <SortIndicator sortDir={sortDir} />}
            </th>
            <th>Rule Approval</th>
            <th>Comment</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((brdp) => (
            <tr
              key={brdp.id}
              className={`${selectedIds.includes(brdp.id) ? styles.selected : ''} ${styles.row}`}
              onClick={(e) => handleRowClick(brdp, e)}
            >
              <td className={styles.editCell}>
                <div className={styles.editBtnContainer}>
                  <button
                    className={styles.editBtn}
                    onClick={(e) => {
                      e.stopPropagation();
                      onEdit(brdp);
                    }}
                    aria-label="Edit BRDP"
                    title="Edit BRDP"
                  >
                    ✏️
                  </button>
                  {editingBrdpId === brdp.id && isDirtyEditing && (
                    <div className={styles.dirtyIndicator} title="Unsaved changes" />
                  )}
                </div>
              </td>
              <td className={styles.id}>{brdp.id}</td>
              <td className={styles.title} title={brdp.title}>
                {truncate(brdp.title, 40)}
              </td>
              <td className={styles.definition} title={brdp.definition}>
                {truncate(brdp.definition, 60)}
              </td>
              <td className={styles.proposal} title={brdp.proposal}>
                {truncate(brdp.proposal, 60)}
              </td>
              <td className={styles.validation}>
                <ValidationBadge status={brdp.validation} />
              </td>
              <td className={styles.ruleApproval}>
                <RuleApprovalCell brdpId={brdp.id} primaryFormat={primaryFormat} />
              </td>
              <td className={styles.comment} title={brdp.comment}>
                {truncate(brdp.comment, 40)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className={styles.footer}>
        <div className={styles.footerInfo}>
          {total} {total === 1 ? 'record' : 'records'} | Page {currentPage} of{' '}
          {totalPages}
        </div>
        <div className={styles.pagination}>
          <button
            onClick={() => onPageChange(currentPage - 1)}
            disabled={currentPage === 1}
            className={styles.paginationBtn}
          >
            Previous
          </button>
          <button
            onClick={() => onPageChange(currentPage + 1)}
            disabled={currentPage === totalPages}
            className={styles.paginationBtn}
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}

