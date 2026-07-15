import { useState, useRef } from 'react';
import { generateTemplate, importFromExcel, exportToExcel, exportToCSV } from '../utils/excelUtils';
import styles from './DataManagementSection.module.css';

/**
 * Data Management section component
 * Handles Excel import/export and data management
 * @param {Object} props - Component props
 * @param {Array} props.brdps - Current BRDP records
 * @param {Function} props.onSetBrdps - Callback to replace all BRDPs
 * @param {Function} props.onAddBrdps - Callback to append new BRDPs (Merge)
 * @param {Function} props.showToast - Callback to show toast notifications
 * @returns {JSX.Element} Data management section
 */
export default function DataManagementSection({ brdps, onSetBrdps, onAddBrdps, showToast }) {
  const [importedRows, setImportedRows] = useState([]);
  const [importErrors, setImportErrors] = useState([]);
  const [importMode, setImportMode] = useState(null);
  const fileInputRef = useRef(null);

  /**
   * Handle download template
   */
  const handleDownloadTemplate = () => {
    const blob = new Blob([generateTemplate()], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'brdp-template.xlsx';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(url);
  };

  /**
   * Handle file selection for import
   */
  const handleFileSelect = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setImportErrors([]);
    setImportedRows([]);

    const { rows, errors } = await importFromExcel(file);

    if (errors.length > 0) {
      setImportErrors(errors);
      setImportedRows([]);
      setImportMode(null);
    } else if (rows.length === 0) {
      setImportErrors(['No valid data found in file']);
      setImportMode(null);
    } else {
      setImportedRows(rows);
      setImportMode('preview');
      setImportErrors([]);
    }

    // Reset file input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  /**
   * Handle replace all BRDPs
   */
  const handleReplaceAll = () => {
    onSetBrdps(importedRows);
    setImportedRows([]);
    setImportMode(null);
    if (showToast) {
      showToast(`${importedRows.length} BRDPs imported successfully`, 'success');
    }
  };

  /**
   * Handle merge with existing BRDPs
   * Merge only adds new IDs -- if the imported file contains any ID that
   * already exists, the whole operation is aborted (no partial merge) so
   * existing BRDPs are never silently skipped or overwritten. Use Replace
   * to update existing IDs instead.
   */
  const handleMerge = () => {
    const existingIds = new Set(brdps.map((b) => b.id));
    const collidingIds = importedRows
      .filter((row) => existingIds.has(row.id))
      .map((row) => row.id);

    if (collidingIds.length > 0) {
      setImportErrors([
        `Merge aborted: ${collidingIds.length} BRDP ID(s) already exist and would be skipped or overwritten: ${collidingIds.join(', ')}. Use "Replace all BRDPs" if you want to update existing IDs.`,
      ]);
      return;
    }

    onAddBrdps(importedRows);
    setImportedRows([]);
    setImportMode(null);
    if (showToast) {
      showToast(`${importedRows.length} new BRDPs imported successfully`, 'success');
    }
  };

  /**
   * Handle cancel import
   */
  const handleCancelImport = () => {
    setImportedRows([]);
    setImportMode(null);
    setImportErrors([]);
  };

  /**
   * Handle export to Excel
   */
  const handleExportExcel = () => {
    exportToExcel(brdps);
    if (showToast) {
      showToast('File downloaded successfully', 'success');
    }
  };

  /**
   * Handle export to CSV
   */
  const handleExportCSV = () => {
    exportToCSV(brdps);
    if (showToast) {
      showToast('File downloaded successfully', 'success');
    }
  };

  return (
    <div className={styles.section}>
      <h3 className={styles.title}>Data Management</h3>

      {/* Subsection A: Download Template */}
      <div className={styles.subsection}>
        <h4 className={styles.subtitle}>Download template</h4>
        <button onClick={handleDownloadTemplate} className={styles.primaryButton}>
          Download Excel template (.xlsx)
        </button>
      </div>

      {/* Subsection B: Import from Excel */}
      <div className={styles.subsection}>
        <h4 className={styles.subtitle}>Import BRDPs from Excel</h4>

        {importMode === null && (
          <>
            <label className={styles.fileInputLabel}>
              Choose Excel file
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls"
                onChange={handleFileSelect}
                className={styles.fileInputHidden}
              />
            </label>
            <p className={styles.helpText}>
              Select an Excel file created from the template
            </p>
          </>
        )}

        {/* Import Errors */}
        {importErrors.length > 0 && (
          <div className={styles.errorContainer}>
            <h5 className={styles.errorTitle}>Import errors:</h5>
            <ul className={styles.errorList}>
              {importErrors.map((error, idx) => (
                <li key={idx}>{error}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Import Preview */}
        {importMode === 'preview' && importedRows.length > 0 && (
          <div className={styles.previewContainer}>
            <p className={styles.previewInfo}>
              {importedRows.length} rows found
            </p>

            <div className={styles.previewActions}>
              <button onClick={handleReplaceAll} className={styles.primaryButton}>
                Replace all BRDPs
              </button>
              <button onClick={handleMerge} className={styles.secondaryButton}>
                Merge
              </button>
              <button onClick={handleCancelImport} className={styles.cancelButton}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Subsection C: Export */}
      <div className={styles.subsection}>
        <h4 className={styles.subtitle}>Export current BRDPs</h4>
        <div className={styles.exportButtonsGroup}>
          <button onClick={handleExportExcel} className={styles.primaryButton}>
            Export to Excel (.xlsx)
          </button>
          <button onClick={handleExportCSV} className={styles.secondaryButton}>
            Export to CSV
          </button>
        </div>
        <p className={styles.helpText}>
          {brdps.length} BRDP record{brdps.length !== 1 ? 's' : ''} available for export
        </p>
      </div>

    </div>
  );
}
