import { useState, useEffect } from 'react';
import { Trash2 } from 'lucide-react';
import { useBRDPContext } from '../context/BRDPContext';
import { useLocalNotes } from '../hooks/useLocalNotes';
import { RuleApprovalCell } from './RuleApprovalCell';
import styles from './DetailPanel.module.css';

/**
 * Format ISO date string to DD/MM/YYYY HH:mm
 */
function formatDate(isoString) {
  try {
    const date = new Date(isoString);
    if (isNaN(date.getTime())) {
      return 'Invalid date';
    }
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${day}/${month}/${year} ${hours}:${minutes}`;
  } catch {
    return 'Invalid date';
  }
}

/**
 * Truncate text to 60 characters
 */
function truncate(text, maxLength = 60) {
  if (!text || typeof text !== 'string') return '';
  return text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
}

/**
 * Lock icon component for read-only fields
 * @returns {JSX.Element} Lock icon with tooltip
 */
function LockIcon() {
  return (
    <span className={styles.lockIcon} title="This field cannot be edited">
      🔒
    </span>
  );
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
 * Detail panel component
 * Displays full BRDP details with notes and edit mode
 * @param {Object} props - Component props
 * @param {Object} props.brdp - BRDP record to display
 * @param {Function} props.onClose - Callback when panel closes
 * @param {Function} props.showToast - Callback to show toast notifications
 * @param {Function} props.onUpdate - Callback when BRDP is updated
 * @param {Function} props.onDirtyChange - Callback when edit state changes
 * @param {Function} props.onDelete - Callback when BRDP is deleted
 * @param {string} props.primaryFormat - Project's currently-active format, or '' if unset
 * @param {number} [props.approvalsRefreshToken] - Bumped after every Generate attempt
 * @returns {JSX.Element} Detail panel with full record information
 */
export default function DetailPanel({ brdp, onClose, showToast, onUpdate, onDirtyChange, onDelete, primaryFormat, approvalsRefreshToken }) {
  const { updateBRDP, brdps } = useBRDPContext();
  const { getNote, saveNote } = useLocalNotes();
  const [notes, setNotes] = useState('');
  const [notesDirty, setNotesDirty] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [definitionUnlocked, setDefinitionUnlocked] = useState(false);
  const [editData, setEditData] = useState({
    proposal: brdp.proposal,
    validation: brdp.validation,
    comment: brdp.comment,
    definition: brdp.definition,
  });

  // Load notes on mount or when BRDP changes
  useEffect(() => {
    const savedNotes = getNote(brdp.id);
    setNotes(savedNotes);
    setNotesDirty(false);
    setIsEditing(false);
    setIsDirty(false);
    setDefinitionUnlocked(false);
    setEditData({
      proposal: brdp.proposal,
      validation: brdp.validation,
      comment: brdp.comment,
      definition: brdp.definition,
    });
  }, [brdp.id, brdp.proposal, brdp.validation, brdp.comment, brdp.definition, getNote]);

  // Notify parent when isDirty changes
  useEffect(() => {
    if (onDirtyChange) {
      onDirtyChange(isDirty);
    }
  }, [isDirty, onDirtyChange]);

  // Handle escape key to close panel
  useEffect(() => {
    /**
     * Handle keydown event
     * @param {KeyboardEvent} event - Keyboard event
     */
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  /**
   * Handle notes change
   * @param {Event} event - Change event from textarea
   */
  const handleNotesChange = (event) => {
    const newNotes = event.target.value;
    setNotes(newNotes);
    setNotesDirty(true);
    // Auto-save on change
    saveNote(brdp.id, newNotes);
    setNotesDirty(false);
  };

  /**
   * Handle edit field change
   * @param {string} field - Field name to update
   * @param {string} value - New value
   */
  const handleEditChange = (field, value) => {
    setEditData(prev => ({
      ...prev,
      [field]: value,
    }));
    if (value !== brdp[field]) {
      setIsDirty(true);
    }
  };

  /**
   * Handle save changes. History is computed once, in updateBRDP() (the
   * single source of truth -- see BRDPContext.jsx) -- its return value is
   * reused here to keep this panel and BRDPPage's selectedBRDPs in sync,
   * instead of recomputing history a second time.
   */
  const handleSaveChanges = () => {
    const updatedBrdp = updateBRDP(brdp.id, editData);
    setIsEditing(false);
    setIsDirty(false);
    setDefinitionUnlocked(false);
    if (onUpdate && updatedBrdp) {
      onUpdate(updatedBrdp);
    }
    if (showToast) {
      showToast('BRDP updated', 'success');
    }
  };

  /**
   * Handle cancel edit
   */
  const handleCancelEdit = () => {
    setEditData({
      proposal: brdp.proposal,
      validation: brdp.validation,
      comment: brdp.comment,
      definition: brdp.definition,
    });
    setIsEditing(false);
    setIsDirty(false);
    setDefinitionUnlocked(false);
  };

  /**
   * Handle close panel with unsaved changes check
   */
  const handleCloseWithCheck = () => {
    if (isDirty && isEditing) {
      if (window.confirm('You have unsaved changes. Are you sure you want to close?\n\nClick "OK" to discard changes or "Cancel" to keep editing.')) {
        setIsDirty(false);
        setIsEditing(false);
        onClose();
      }
    } else {
      onClose();
    }
  };

  return (
    <>
      {/* Overlay */}
      <div className={styles.overlay} onClick={onClose} />

      {/* Panel */}
      <div className={styles.panel}>
        {/* Header */}
        <div className={styles.header}>
          <h2 className={styles.heading}>
            {isEditing ? `Editing: ${brdp.id}` : brdp.id}
          </h2>
          <div className={styles.headerButtons}>
            {!isEditing && (
              <button
                className={styles.editBtn}
                onClick={() => setIsEditing(true)}
                aria-label="Edit BRDP"
                title="Edit BRDP"
              >
                ✏️
              </button>
            )}
            {!isEditing && onDelete && (
              <button
                className={styles.deleteBtn}
                onClick={() => {
                  if (window.confirm(`Delete ${brdp.id}? This action cannot be undone.`)) {
                    onDelete(brdp.id);
                  }
                }}
                aria-label="Delete BRDP"
                title="Delete BRDP"
              >
                <Trash2 size={16} />
              </button>
            )}
            <button
              className={styles.closeBtn}
              onClick={handleCloseWithCheck}
              aria-label="Close panel"
              title="Close"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Content */}
        <div className={styles.content}>
          <div className={styles.fieldsSection}>
            {/* BRDP Identifier */}
            <div className={styles.field}>
              <label className={styles.label}>
                BRDP Identifier <LockIcon />
              </label>
              <p className={styles.value}>{brdp.id}</p>
            </div>

            {/* Definition */}
            <div className={styles.field}>
              <label className={styles.label}>
                Definition
                {(
                  <span
                    className={styles.lockIcon}
                    title={definitionUnlocked ? "Click to lock" : "Click to unlock and edit"}
                    style={{ cursor: 'pointer' }}
                    onClick={() => setDefinitionUnlocked(prev => !prev)}
                  >
                    {definitionUnlocked ? '🔓' : '🔒'}
                  </span>
                )}
              </label>
              {isEditing && definitionUnlocked ? (
                <textarea
                  className={styles.editTextarea}
                  value={editData.definition}
                  onChange={(e) => handleEditChange('definition', e.target.value)}
                  rows="3"
                />
              ) : (
                <p className={styles.value}>{isEditing ? editData.definition : brdp.definition}</p>
              )}
            </div>

            {/* Proposal */}
            <div className={styles.field}>
              <label className={styles.label}>ATX Decision Proposal</label>
              {isEditing ? (
                <textarea
                  value={editData.proposal}
                  onChange={(e) => handleEditChange('proposal', e.target.value)}
                  className={styles.editTextarea}
                  rows="4"
                />
              ) : (
                <p className={styles.value}>{brdp.proposal}</p>
              )}
            </div>

            {/* Validation Status */}
            <div className={styles.field}>
              <label className={styles.label}>Validation Status</label>
              {isEditing ? (
                <select
                  value={editData.validation}
                  onChange={(e) => handleEditChange('validation', e.target.value)}
                  className={styles.editSelect}
                >
                  <option>Validated</option>
                  <option>Refused</option>
                  <option>Pending</option>
                </select>
              ) : (
                <ValidationBadge status={brdp.validation} />
              )}
            </div>

            {/* Comment */}
            <div className={styles.field}>
              <label className={styles.label}>Comment</label>
              {isEditing ? (
                <textarea
                  value={editData.comment}
                  onChange={(e) => handleEditChange('comment', e.target.value)}
                  className={styles.editTextarea}
                  rows="3"
                />
              ) : (
                <p className={styles.value}>{brdp.comment}</p>
              )}
            </div>

            {/* Rule Approval */}
            <div className={styles.field}>
              <label className={styles.label}>Rule Approval</label>
              <RuleApprovalCell brdpId={brdp.id} primaryFormat={primaryFormat} approvalsRefreshToken={approvalsRefreshToken} />
            </div>
          </div>

          {/* Notes Section */}
          <div className={styles.notesSection}>
            <label htmlFor="notes-textarea" className={styles.notesLabel}>
              My Notes
            </label>
            <textarea
              id="notes-textarea"
              value={notes}
              onChange={handleNotesChange}
              placeholder="Add your notes about this BRDP..."
              className={styles.textarea}
            />
            {notesDirty && <p className={styles.savingIndicator}>Saving...</p>}
          </div>

          {/* Change History Section */}
          <div className={styles.historySection}>
            <button
              className={styles.historyToggle}
              onClick={() => setShowHistory(!showHistory)}
            >
              {showHistory ? '▼' : '▶'} Change History
            </button>
            {showHistory && (
              <div className={styles.historyContent}>
                {!Array.isArray(brdp.history) || brdp.history.length === 0 ? (
                  <p className={styles.noHistory}>No changes recorded.</p>
                ) : (
                  <div className={styles.historyList}>
                    {[...brdp.history].reverse().map((entry, idx) => {
                      if (!entry || typeof entry !== 'object') return null;
                      return (
                        <div key={idx} className={styles.historyEntry}>
                          <div className={styles.historyDate}>
                            {formatDate(entry.date || '')}
                          </div>
                          <div className={styles.historyField}>
                            <strong>{entry.field || 'unknown'}</strong>
                          </div>
                          <div className={styles.historyChange}>
                            <span className={styles.oldValue}>
                              {truncate(entry.oldValue || '')}
                            </span>
                            <span className={styles.arrow}>→</span>
                            <span className={styles.newValue}>
                              {truncate(entry.newValue || '')}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        {isEditing && (
          <div className={styles.footer}>
            {isDirty && (
              <p className={styles.unsavedWarning}>⚠️ Unsaved changes</p>
            )}
            <div className={styles.editActions}>
              <button
                className={styles.saveBtn}
                onClick={handleSaveChanges}
                title="Save changes"
              >
                Save changes
              </button>
              <button
                className={styles.cancelBtn}
                onClick={handleCancelEdit}
                title="Cancel editing"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
