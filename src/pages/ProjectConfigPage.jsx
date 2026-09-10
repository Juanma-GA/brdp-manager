import { useEffect, useRef, useState } from 'react';
import { useOutletContext, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { authFetchJson } from '../services/apiClient';
import { generateTemplate, importFromExcel, exportToExcel } from '../utils/excelUtils';
import Button from '../components/Button';
import styles from './ProjectConfigPage.module.css';

// Confirmed by reading generateBREX.js/generateBREX41.js/generateBREX301.js
// directly: all three read exactly these 9 projectConfig keys (only how
// each volcarga them into XML attribute names differs, never which fields
// exist) -- generateBREXSch.js reuses generateBREX301.js internally, so
// "Schematron 1.0 — S1000D" needs this same set too. One shared field
// list for all 4 of those standards, no per-standard branching.
const FULL_FIELDS = [
  { key: 'projectName', labelKey: 'projectName' },
  { key: 'modelIdentCode', labelKey: 'modelIdentCode', hintKey: 'modelIdentCodeHint' },
  { key: 'systemDiffCode', labelKey: 'systemDiffCode' },
  { key: 'issueNumber', labelKey: 'issueNumber' },
  { key: 'inWork', labelKey: 'inWork' },
  { key: 'languageIsoCode', labelKey: 'languageIsoCode' },
  { key: 'countryIsoCode', labelKey: 'countryIsoCode' },
  { key: 'securityClassification', labelKey: 'securityClassification' },
  { key: 'enterpriseCode', labelKey: 'enterpriseCode' },
];

// generateSchematronDITA.js reads only projectConfig.projectName (with
// modelIdentCode as a fallback if projectName is empty) -- confirmed by
// reading the file, nothing else from projectConfig is ever touched for
// this standard, so the other 8 fields would be pure dead UI.
const DITA_FIELDS = [{ key: 'projectName', labelKey: 'projectName' }];

function fieldsForStandard(standard) {
  return standard === 'Schematron 1.0 — DITA' ? DITA_FIELDS : FULL_FIELDS;
}

// v1's excelUtils.js (untouched -- the "engine" for this feature) maps the
// "BRDP Identifier"/"Comment" Excel columns to internal keys `id`/`comment`.
// v2's BRDP schema calls those `identifier`/`comments` and has a separate
// real UUID `id` -- these two helpers are the only translation needed
// between the two shapes, in either direction.
function brdpToExcelRow(brdp) {
  return {
    id: brdp.identifier,
    title: brdp.title,
    definition: brdp.definition,
    proposal: brdp.proposal,
    validation: brdp.validation,
    comment: brdp.comments,
  };
}

function excelRowToBRDPCreate(row) {
  return {
    identifier: row.id,
    title: row.title || '',
    definition: row.definition || '',
    proposal: row.proposal || '',
    validation: row.validation || 'Pending',
    comments: row.comment || '',
  };
}

function DataManagementSection({ projectId, canEdit, dataVersion, onDataChanged }) {
  const { t } = useTranslation();
  const fileInputRef = useRef(null);
  const [importedRows, setImportedRows] = useState([]);
  const [importMode, setImportMode] = useState(null); // null | 'preview'
  const [importErrors, setImportErrors] = useState([]);
  const [importMessage, setImportMessage] = useState(null);
  const [busy, setBusy] = useState(false);
  const [brdpCount, setBrdpCount] = useState(null);

  const refreshCount = () =>
    authFetchJson(`/api/projects/${projectId}/brdps`).then((data) => setBrdpCount(data.length));

  // dataVersion is bumped by ProjectConfigPage whenever ResetDataSection (a
  // separate sibling component) deletes everything -- without it, this
  // section's own displayed count would go stale after a Reset until a
  // manual page reload, since the two sections don't otherwise share state.
  useEffect(() => {
    refreshCount();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, dataVersion]);

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

  const handleFileSelect = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportErrors([]);
    setImportedRows([]);
    setImportMessage(null);
    const { rows, errors } = await importFromExcel(file);
    if (errors.length > 0) {
      setImportErrors(errors);
      setImportMode(null);
    } else if (rows.length === 0) {
      setImportErrors([t('config.dataManagement.noValidRows')]);
      setImportMode(null);
    } else {
      setImportedRows(rows);
      setImportMode('preview');
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleCancelImport = () => {
    setImportedRows([]);
    setImportMode(null);
    setImportErrors([]);
  };

  const createImportedRows = async () => {
    for (const row of importedRows) {
      await authFetchJson(`/api/projects/${projectId}/brdps`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(excelRowToBRDPCreate(row)),
      });
    }
  };

  const handleReplaceAll = async () => {
    setBusy(true);
    setImportErrors([]);
    try {
      const existing = await authFetchJson(`/api/projects/${projectId}/brdps`);
      for (const b of existing) {
        await authFetchJson(`/api/projects/${projectId}/brdps/${b.id}`, { method: 'DELETE' });
      }
      await createImportedRows();
      setImportMessage(t('config.dataManagement.importSuccess', { count: importedRows.length }));
      setImportedRows([]);
      setImportMode(null);
      refreshCount();
      onDataChanged();
    } catch (err) {
      setImportErrors([err.message]);
    } finally {
      setBusy(false);
    }
  };

  const handleMerge = async () => {
    setBusy(true);
    setImportErrors([]);
    try {
      const existing = await authFetchJson(`/api/projects/${projectId}/brdps`);
      const existingIdentifiers = new Set(existing.map((b) => b.identifier));
      const colliding = importedRows.filter((row) => existingIdentifiers.has(row.id)).map((row) => row.id);
      if (colliding.length > 0) {
        setImportErrors([t('config.dataManagement.mergeAborted', { count: colliding.length, ids: colliding.join(', ') })]);
        return;
      }
      await createImportedRows();
      setImportMessage(t('config.dataManagement.importSuccess', { count: importedRows.length }));
      setImportedRows([]);
      setImportMode(null);
      refreshCount();
      onDataChanged();
    } catch (err) {
      setImportErrors([err.message]);
    } finally {
      setBusy(false);
    }
  };

  const handleExport = async () => {
    setBusy(true);
    try {
      const brdps = await authFetchJson(`/api/projects/${projectId}/brdps`);
      exportToExcel(brdps.map(brdpToExcelRow));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.card}>
      <h2 className={styles.sectionHeading}>{t('config.dataManagement.title')}</h2>

      <div className={styles.subsection}>
        <h3 className={styles.subsectionHeading}>{t('config.dataManagement.downloadTemplateTitle')}</h3>
        <Button onClick={handleDownloadTemplate}>{t('config.dataManagement.downloadTemplateButton')}</Button>
      </div>

      <div className={styles.subsection}>
        <h3 className={styles.subsectionHeading}>{t('config.dataManagement.exportTitle')}</h3>
        <Button onClick={handleExport} disabled={busy}>
          {busy ? t('config.dataManagement.exporting') : t('config.dataManagement.exportButton')}
        </Button>
        {brdpCount !== null && (
          <p className={styles.hint}>{t('config.dataManagement.countAvailable', { count: brdpCount })}</p>
        )}
      </div>

      {canEdit && (
        <div className={styles.subsection}>
          <h3 className={styles.subsectionHeading}>{t('config.dataManagement.importTitle')}</h3>

          {importMode === null && (
            <>
              <label className={styles.fileInputLabel}>
                {t('config.dataManagement.chooseFile')}
                <input ref={fileInputRef} type="file" accept=".xlsx,.xls" onChange={handleFileSelect} hidden />
              </label>
              <p className={styles.hint}>{t('config.dataManagement.chooseFileHint')}</p>
            </>
          )}

          {importErrors.length > 0 && (
            <ul className={styles.errorList}>
              {importErrors.map((err, i) => (
                <li key={i}>{err}</li>
              ))}
            </ul>
          )}

          {importMode === 'preview' && (
            <div>
              <p className={styles.hint}>{t('config.dataManagement.rowsFound', { count: importedRows.length })}</p>
              <div className={styles.actionsRow}>
                <Button onClick={handleReplaceAll} disabled={busy}>
                  {busy ? t('config.dataManagement.importing') : t('config.dataManagement.replaceAll')}
                </Button>
                <button type="button" className={styles.secondaryButton} onClick={handleMerge} disabled={busy}>
                  {busy ? t('config.dataManagement.importing') : t('config.dataManagement.merge')}
                </button>
                <button type="button" className={styles.secondaryButton} onClick={handleCancelImport} disabled={busy}>
                  {t('config.dataManagement.cancel')}
                </button>
              </div>
            </div>
          )}

          {importMessage && <p className={styles.savedIndicator}>{importMessage}</p>}
        </div>
      )}
    </div>
  );
}

function ResetDataSection({ projectId, canEdit, onDataChanged }) {
  const { t } = useTranslation();
  const [showDialog, setShowDialog] = useState(false);
  const [brdpCount, setBrdpCount] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (showDialog) {
      authFetchJson(`/api/projects/${projectId}/brdps`).then((data) => setBrdpCount(data.length));
    }
  }, [showDialog, projectId]);

  if (!canEdit) return null;

  const handleReset = async () => {
    setBusy(true);
    try {
      const existing = await authFetchJson(`/api/projects/${projectId}/brdps`);
      for (const b of existing) {
        await authFetchJson(`/api/projects/${projectId}/brdps/${b.id}`, { method: 'DELETE' });
      }
      setShowDialog(false);
      // DataManagementSection is a separate sibling component with its own
      // "N BRDPs available for export" count -- without telling it a reset
      // just happened, that count would stay stale until a page reload.
      onDataChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.dangerCard}>
      <h2 className={styles.sectionHeading}>{t('config.resetData.title')}</h2>
      <p className={styles.dangerText}>{t('config.resetData.description')}</p>
      <button type="button" className={styles.dangerButton} onClick={() => setShowDialog(true)}>
        {t('config.resetData.button')}
      </button>

      {showDialog && (
        <div className={styles.modalOverlay} onClick={() => !busy && setShowDialog(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3 className={styles.sectionHeading}>{t('config.resetData.dialogTitle')}</h3>
            {brdpCount !== null && (
              <p className={styles.dangerText}>{t('config.resetData.warning', { count: brdpCount })}</p>
            )}
            <p className={styles.dangerText}>{t('config.resetData.irreversible')}</p>
            <div className={styles.actionsRow}>
              <button type="button" className={styles.dangerButton} onClick={handleReset} disabled={busy}>
                {busy ? t('config.resetData.resetting') : t('config.resetData.confirmButton')}
              </button>
              <button type="button" className={styles.secondaryButton} onClick={() => setShowDialog(false)} disabled={busy}>
                {t('config.resetData.cancel')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ProjectConfigPage() {
  const { t } = useTranslation();
  const { projectId } = useParams();
  const { project, refreshProject } = useOutletContext();
  const [values, setValues] = useState(project.project_config || {});
  const [isSaving, setIsSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // canEdit is purely cosmetic (disables the form) -- the backend's
  // require_project_role('editor') on PUT is the real gate regardless of
  // what this renders. project.effective_role is computed server-side
  // (admin already resolved to 'editor' there, docs/v2 §4.3), so this
  // never needs its own admin special case.
  const canEdit = project.effective_role === 'editor';
  const fields = fieldsForStandard(project.standard);
  // Bumped whenever ResetDataSection deletes everything, so
  // DataManagementSection's own BRDP count re-fetches instead of showing a
  // stale number -- the two are independent sibling components.
  const [dataVersion, setDataVersion] = useState(0);
  const bumpDataVersion = () => setDataVersion((v) => v + 1);

  useEffect(() => {
    setValues(project.project_config || {});
  }, [project]);

  const handleChange = (key, value) => {
    setValues((v) => ({ ...v, [key]: value }));
    setSaved(false);
  };

  const handleSave = async (e) => {
    e.preventDefault();
    setIsSaving(true);
    try {
      await authFetchJson(`/api/projects/${projectId}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_config: values }),
      });
      setSaved(true);
      refreshProject();
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>{t('nav.config')}</h1>
      <p className={styles.subtitle}>
        {project.name} · {project.standard}
      </p>

      <form className={styles.card} onSubmit={handleSave}>
        <div className={styles.grid}>
          {fields.map((f) => (
            <div key={f.key} className={styles.field}>
              <label className={styles.label} htmlFor={`cfg-${f.key}`}>
                {t(`config.fields.${f.labelKey}`)}
              </label>
              <input
                id={`cfg-${f.key}`}
                className={styles.input}
                value={values[f.key] || ''}
                onChange={(e) => handleChange(f.key, e.target.value)}
                disabled={!canEdit}
              />
              {f.hintKey && <span className={styles.hint}>{t(`config.fields.${f.hintKey}`)}</span>}
            </div>
          ))}
        </div>
        {canEdit && (
          <button type="submit" className={styles.saveBtn} disabled={isSaving}>
            {isSaving ? '…' : t('config.save')}
          </button>
        )}
        {saved && <span className={styles.savedIndicator}>{t('config.saved')}</span>}
        {!canEdit && <p className={styles.readOnlyNote}>{t('config.readOnly')}</p>}
      </form>

      <DataManagementSection projectId={projectId} canEdit={canEdit} dataVersion={dataVersion} onDataChanged={bumpDataVersion} />
      <ResetDataSection projectId={projectId} canEdit={canEdit} onDataChanged={bumpDataVersion} />
    </div>
  );
}
