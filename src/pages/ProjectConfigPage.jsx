import { useEffect, useRef, useState } from 'react';
import { useOutletContext, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { authFetchJson } from '../services/apiClient';
import { generateTemplate, importFromExcel, exportToExcel } from '../utils/excelUtils';
import { ruleStateOf } from '../utils/ruleState';
import { STANDARD_TO_RULE_FORMAT } from '../constants/ruleFormats';
import Button from '../components/Button';
import styles from './ProjectConfigPage.module.css';

// Plain English labels, NOT run through i18n -- Export to Excel has never
// been translated (generateTemplate()/importFromExcel() in excelUtils.js,
// its "engine", only ever emit literal English column headers/values), so
// this round doesn't introduce i18n here either. Mirrors RecordsPage's
// i18n'd records.rule.states.* strings in their default (English) form.
const RULE_STATUS_LABELS = { todo: 'To Do', draft: 'Draft', verified: 'Verified' };

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

// Export's own shape (ID/Title/Definition/Proposal/Proposal Status/Rule
// Status/Rule, in that order, "Comment" dropped). ruleApproval is the
// matching row from the project-wide bulk export endpoint (or null -- no
// row yet means "To Do" and an empty Rule, same convention as the live
// Records table).
function brdpToExportRow(brdp, ruleApproval) {
  return {
    id: brdp.identifier,
    title: brdp.title,
    definition: brdp.definition,
    proposal: brdp.proposal,
    proposalStatus: brdp.validation,
    ruleStatus: RULE_STATUS_LABELS[ruleStateOf(ruleApproval)],
    rule: ruleApproval?.rule_xml || '',
  };
}

// Excel's own hard per-cell text limit -- confirmed real: XLSX.write()
// (called inside exportToExcel()) throws an uncaught exception deep
// inside SheetJS for any cell over this, silently failing the WHOLE
// export with no user-facing message at all (found while stress-testing
// the freeze fix below, not the originally reported bug -- confirmed
// with the user this round: catch it and tell them exactly which
// BRDP(s) are affected, never download a partial/corrupt file).
const EXCEL_CELL_CHAR_LIMIT = 32767;

// Checked client-side BEFORE calling exportToExcel() -- the raw SheetJS
// exception carries no row/column information at all, so this is the
// only way to name the actual offending BRDP(s) in the error message.
function findOversizedExportRows(rows) {
  const fields = ['id', 'title', 'definition', 'proposal', 'proposalStatus', 'ruleStatus', 'rule'];
  return rows.filter((row) => fields.some((f) => (row[f] || '').length > EXCEL_CELL_CHAR_LIMIT)).map((row) => row.id);
}

function DataManagementSection({ projectId, standard, canEdit, dataVersion, onDataChanged }) {
  const { t } = useTranslation();
  const fileInputRef = useRef(null);
  // pendingRows is the EXACT same row array sent to both /analyze and
  // /apply (docs request: apply re-validates against current Postgres
  // state itself, so the client only ever needs to remember the raw
  // parsed rows, never a client-computed classification).
  const [pendingRows, setPendingRows] = useState(null);
  const [analysis, setAnalysis] = useState(null); // { results: [...] } from /analyze
  const [conflictResolution, setConflictResolution] = useState('keep');
  const [applyResult, setApplyResult] = useState(null);
  const [importErrors, setImportErrors] = useState([]);
  const [exportError, setExportError] = useState(null);
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

  const resetImportState = () => {
    setPendingRows(null);
    setAnalysis(null);
    setConflictResolution('keep');
    setApplyResult(null);
    setImportErrors([]);
  };

  // Phase 1 (docs request): runs automatically as soon as a file parses
  // cleanly -- no writes to Postgres happen here at all, it only builds
  // the summary the user reviews before Apply.
  const handleFileSelect = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    resetImportState();
    const { rows, errors } = await importFromExcel(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (errors.length > 0) {
      setImportErrors(errors);
      return;
    }
    if (rows.length === 0) {
      setImportErrors([t('config.dataManagement.noValidRows')]);
      return;
    }
    setBusy(true);
    try {
      const result = await authFetchJson(`/api/projects/${projectId}/brdps/import/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows }),
      });
      setPendingRows(rows);
      setAnalysis(result);
    } catch (err) {
      setImportErrors([err.message]);
    } finally {
      setBusy(false);
    }
  };

  const handleCancelImport = () => {
    resetImportState();
  };

  // Phase 2 (docs request): only reachable after the user has seen the
  // Phase 1 summary and explicitly clicked Apply -- re-validates against
  // current Postgres state server-side rather than trusting the Phase 1
  // classification, which could be stale by now.
  const handleApplyImport = async () => {
    setBusy(true);
    setImportErrors([]);
    try {
      const result = await authFetchJson(`/api/projects/${projectId}/brdps/import/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: pendingRows, conflict_resolution: conflictResolution }),
      });
      setApplyResult(result);
      setPendingRows(null);
      setAnalysis(null);
      refreshCount();
      onDataChanged();
    } catch (err) {
      setImportErrors([err.message]);
    } finally {
      setBusy(false);
    }
  };

  const okCount = analysis?.results.filter((r) => r.outcome === 'ok').length ?? 0;
  const rejectedRows = analysis?.results.filter((r) => r.outcome === 'rejected') ?? [];
  const conflictRows = analysis?.results.filter((r) => r.outcome === 'conflict') ?? [];
  // Warning, not a rejection -- these rows DO still import (docs request),
  // shown up front (same place/detail level as rejected rows) so the
  // Title/Definition override is visible before confirming, not after.
  const catalogOverrideRows = analysis?.results.filter((r) => r.catalog_override) ?? [];

  const handleExport = async () => {
    setBusy(true);
    setExportError(null);
    // Real yield to the browser before any work starts (docs request,
    // confirmed with real timing: exportToExcel() below is synchronous
    // XLSX generation -- for a project with many BRDPs and long Rule
    // content, that call alone can block the main thread for multiple
    // seconds). Without this, the two awaited fetches that follow
    // *usually* yield enough for React to paint "Exporting..." first --
    // but that's incidental to how fast the network happens to respond,
    // not guaranteed by the code, and a fast/cached response can win the
    // race against the browser's next paint. Double rAF (not a single
    // one) waits until the frame AFTER the one currently being prepared,
    // so a real paint has already happened, not just been scheduled, by
    // the time exportToExcel() runs.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    try {
      const brdps = await authFetchJson(`/api/projects/${projectId}/brdps`);
      // No rule format at all for this standard (Schematron 1.0 -- DITA,
      // see STANDARD_TO_RULE_FORMAT) -- skip the fetch entirely rather
      // than call an endpoint with an undefined format; every row falls
      // back to "To Do"/empty Rule, same as RecordsPage's own convention.
      const ruleFormat = STANDARD_TO_RULE_FORMAT[standard];
      let approvalsByBrdpId = {};
      if (ruleFormat) {
        const approvals = await authFetchJson(`/api/projects/${projectId}/approvals/${ruleFormat}/export`);
        approvalsByBrdpId = Object.fromEntries(approvals.map((a) => [a.brdp_id, a]));
      }
      const reportRows = brdps.map((b) => brdpToExportRow(b, approvalsByBrdpId[b.id] ?? null));

      // Confirmed with the user: catch this and name the affected BRDP(s)
      // rather than let SheetJS throw uncaught and silently fail the
      // whole export with no message at all.
      const oversized = findOversizedExportRows(reportRows);
      if (oversized.length > 0) {
        setExportError(
          t('config.dataManagement.exportCellTooLarge', { count: oversized.length, ids: oversized.join(', ') })
        );
        return;
      }

      try {
        exportToExcel(reportRows);
      } catch (err) {
        setExportError(t('config.dataManagement.exportFailed', { message: err.message }));
      }
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
          {/* Static text alone isn't enough for a large project (docs
              request, confirmed with real timing: the synchronous XLSX
              build can block the main thread for multiple seconds with
              many BRDPs / long Rule content) -- an animated spinner stays
              an unmistakable "still working" signal even while nothing
              else on the page can update. */}
          {busy && <span className={styles.spinner} aria-hidden="true" />}
          {busy ? t('config.dataManagement.exporting') : t('config.dataManagement.exportButton')}
        </Button>
        {brdpCount !== null && (
          <p className={styles.hint}>{t('config.dataManagement.countAvailable', { count: brdpCount })}</p>
        )}
        {exportError && (
          <ul className={styles.errorList}>
            <li>{exportError}</li>
          </ul>
        )}
      </div>

      {canEdit && (
        <div className={styles.subsection}>
          <h3 className={styles.subsectionHeading}>{t('config.dataManagement.importTitle')}</h3>

          {!analysis && !applyResult && (
            <>
              <label className={styles.fileInputLabel}>
                {t('config.dataManagement.chooseFile')}
                <input ref={fileInputRef} type="file" accept=".xlsx,.xls" onChange={handleFileSelect} hidden disabled={busy} />
              </label>
              <p className={styles.hint}>{t('config.dataManagement.chooseFileHint')}</p>
              {busy && <p className={styles.hint}>{t('config.dataManagement.analyzing')}</p>}
            </>
          )}

          {importErrors.length > 0 && (
            <ul className={styles.errorList}>
              {importErrors.map((err, i) => (
                <li key={i}>{err}</li>
              ))}
            </ul>
          )}

          {analysis && (
            <div>
              <p className={styles.hint}>
                {t('config.dataManagement.summaryOk', { count: okCount })}
                {' · '}
                {t('config.dataManagement.summaryRejected', { count: rejectedRows.length })}
                {' · '}
                {t('config.dataManagement.summaryConflicts', { count: conflictRows.length })}
                {catalogOverrideRows.length > 0 && (
                  <>
                    {' · '}
                    {t('config.dataManagement.summaryCatalogOverrides', { count: catalogOverrideRows.length })}
                  </>
                )}
              </p>

              {rejectedRows.length > 0 && (
                <>
                  <h4 className={styles.subsectionHeading}>{t('config.dataManagement.rejectedListTitle')}</h4>
                  <ul className={styles.errorList}>
                    {rejectedRows.map((r) => (
                      <li key={r.row_number}>
                        {t('config.dataManagement.rowReason', {
                          row: r.row_number,
                          identifier: r.identifier || '—',
                          reason: r.reason,
                        })}
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {catalogOverrideRows.length > 0 && (
                <>
                  <h4 className={styles.subsectionHeading}>{t('config.dataManagement.catalogOverrideListTitle')}</h4>
                  <ul className={styles.warningList}>
                    {catalogOverrideRows.map((r) => (
                      <li key={r.row_number}>
                        {t('config.dataManagement.catalogOverrideRow', {
                          row: r.row_number,
                          identifier: r.identifier,
                        })}
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {conflictRows.length > 0 && (
                <>
                  <h4 className={styles.subsectionHeading}>{t('config.dataManagement.conflictsListTitle')}</h4>
                  <ul className={styles.errorList}>
                    {conflictRows.map((r) => (
                      <li key={r.row_number}>
                        {t('config.dataManagement.conflictRow', {
                          row: r.row_number,
                          identifier: r.identifier,
                          status: r.existing_rule_status,
                        })}
                      </li>
                    ))}
                  </ul>
                  <fieldset className={styles.field}>
                    <legend className={styles.label}>{t('config.dataManagement.conflictResolutionTitle')}</legend>
                    <label>
                      <input
                        type="radio"
                        name="conflictResolution"
                        value="keep"
                        checked={conflictResolution === 'keep'}
                        onChange={() => setConflictResolution('keep')}
                      />{' '}
                      {t('config.dataManagement.conflictResolutionKeep')}
                    </label>
                    <br />
                    <label>
                      <input
                        type="radio"
                        name="conflictResolution"
                        value="clear"
                        checked={conflictResolution === 'clear'}
                        onChange={() => setConflictResolution('clear')}
                      />{' '}
                      {t('config.dataManagement.conflictResolutionClear')}
                    </label>
                  </fieldset>
                </>
              )}

              <div className={styles.actionsRow}>
                <Button onClick={handleApplyImport} disabled={busy}>
                  {busy ? t('config.dataManagement.applying') : t('config.dataManagement.applyButton')}
                </Button>
                <button type="button" className={styles.secondaryButton} onClick={handleCancelImport} disabled={busy}>
                  {t('config.dataManagement.cancel')}
                </button>
              </div>
            </div>
          )}

          {applyResult && (
            <div>
              <h4 className={styles.subsectionHeading}>{t('config.dataManagement.resultTitle')}</h4>
              <ul className={styles.summaryList}>
                <li>{t('config.dataManagement.resultCreated', { count: applyResult.created })}</li>
                <li>{t('config.dataManagement.resultUpdated', { count: applyResult.updated })}</li>
                <li>{t('config.dataManagement.resultRejected', { count: applyResult.rejected })}</li>
                {applyResult.conflicts_kept > 0 && (
                  <li>{t('config.dataManagement.resultConflictsKept', { count: applyResult.conflicts_kept })}</li>
                )}
                {applyResult.conflicts_cleared > 0 && (
                  <li>{t('config.dataManagement.resultConflictsCleared', { count: applyResult.conflicts_cleared })}</li>
                )}
              </ul>
              <button type="button" className={styles.secondaryButton} onClick={resetImportState}>
                {t('config.dataManagement.close')}
              </button>
            </div>
          )}
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

      <DataManagementSection
        projectId={projectId}
        standard={project.standard}
        canEdit={canEdit}
        dataVersion={dataVersion}
        onDataChanged={bumpDataVersion}
      />
      <ResetDataSection projectId={projectId} canEdit={canEdit} onDataChanged={bumpDataVersion} />
    </div>
  );
}
