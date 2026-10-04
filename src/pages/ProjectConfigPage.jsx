import { useEffect, useRef, useState } from 'react';
import { useOutletContext, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { authFetch, authFetchJson } from '../services/apiClient';
import { CURATED_TEMPLATE_BY_STANDARD } from '../utils/excelUtils';
import { ruleStateOf } from '../utils/ruleState';
import { STANDARD_TO_RULE_FORMAT } from '../constants/ruleFormats';
import {
  schemaContextUrl,
  schemaLocationOf,
  schemaLocationOptions,
  supportsSchemaContext,
  validateSchemaPattern,
} from '../utils/ruleSchemaContext.js';
import {
  useActiveImportJob,
  useDismissImportJob,
  useDismissedImportJobId,
  useInvalidateImportJob,
} from '../hooks/useImportJob';
import Button, { useButtonSuccessFlash } from '../components/Button';
import RuleExtractSection from '../components/extract/RuleExtractSection';
import styles from './ProjectConfigPage.module.css';

// Plain English labels, NOT run through i18n -- Export to Excel has never
// been translated (the server's excel_io.py, its "engine", only ever writes
// literal English column headers/values), so this doesn't introduce i18n
// here either. Mirrors RecordsPage's
// i18n'd records.rule.states.* strings in their default (English) form.
const RULE_STATUS_LABELS = { todo: 'To Do', draft: 'Draft', verified: 'Verified' };

// Confirmed by reading generateBREX.js/generateBREX41.js/generateBREX301.js
// directly: all three read exactly these 9 projectConfig keys (only how
// each volcarga them into XML attribute names differs, never which fields
// exist) -- generateBREXSch.js reuses whichever of those three matches the
// project's real standard internally (see GeneratePage.jsx's BREX/
// Schematron selector), so Schematron output needs this same set too. One
// shared field list for all three S1000D standards, no per-standard
// branching.
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
// either DITA standard, so the other 8 fields would be pure dead UI.
const DITA_FIELDS = [{ key: 'projectName', labelKey: 'projectName' }];

// Both "DITA 1.3 Xpath2.0" and "DITA 1.3 Xpath3.0" (migration
// 0013_split_dita_xpath_standards.py) use the SAME config fields -- the
// XPath flavor only affects generateSchematronDITA.js's assembled
// document queryBinding, never what Project Configuration shows/saves.
function fieldsForStandard(standard) {
  return standard.startsWith('DITA 1.3') ? DITA_FIELDS : FULL_FIELDS;
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
    // Informative column: the import ignores it (the identifier decides).
    catalogEdition: brdp.catalog_edition || '',
  };
}

// Saves a downloaded file under `filename` (the browser's own download).
function saveBlob(blob, filename) {
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.URL.revokeObjectURL(url);
}

// The `detail` of a failed backend response: a string, or the object the
// export sends for cells over Excel's limit. Falls back to the status text.
async function responseDetail(res) {
  try {
    const body = await res.json();
    return body.detail ?? res.statusText;
  } catch {
    return res.statusText;
  }
}

// A `detail` as one line of text (FastAPI's own validation errors are a
// list of objects).
function detailText(detail) {
  if (typeof detail === 'string') return detail;
  if (detail && typeof detail.message === 'string') return detail.message;
  return JSON.stringify(detail);
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
  // The rows "from another edition's catalog" are listed on demand (a
  // Lufthansa file has 116 of them).
  const [showCatalogEdition, setShowCatalogEdition] = useState(false);
  const [importErrors, setImportErrors] = useState([]);
  const [exportError, setExportError] = useState(null);
  const [templateError, setTemplateError] = useState(null);
  // Only for the parse + analyze calls and the Export request -- Apply
  // itself is a background job now (docs request), tracked via the job
  // below, never this flag.
  const [busy, setBusy] = useState(false);
  const [brdpCount, setBrdpCount] = useState(null);
  // True only while the POST /apply request itself is in flight (a real,
  // short-lived network round trip) -- once it returns 202, the actual
  // import's progress comes from `job` below, polled from Postgres, never
  // a local fake countdown.
  const [applying, setApplying] = useState(false);
  // Which job.id (if any) the user has closed, hiding a finished
  // (completed/failed) job's panel so they can get back to the file
  // picker without starting a fresh import. Lives in the QueryClient
  // cache (useDismissedImportJobId/useDismissImportJob below), not local
  // component state -- a plain useState here reset every time this page
  // unmounted (navigating away and back within the app), silently
  // resurrecting a result the user had already closed. The QueryClient
  // itself is still only created once per real page load (App.jsx), so
  // closing the tab and reopening later still correctly re-surfaces the
  // last known result (docs request), same as before.
  const dismissedJobId = useDismissedImportJobId(projectId);
  const dismissImportJob = useDismissImportJob();

  // Postgres, via import_jobs, is the only source of truth for "is an
  // import running" (HR1: never localStorage/sessionStorage) -- this is
  // what survives navigating away from this page and back, reloading, or
  // closing the tab entirely and reopening the app later. Shared with
  // Sidebar's badge via the same React Query cache key, so both poll
  // exactly once, not twice.
  const { data: job } = useActiveImportJob(projectId);
  const invalidateImportJob = useInvalidateImportJob();
  const lastJobStatusRef = useRef(null);

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

  // Fires exactly once per job completion (not on every poll tick while
  // already completed) -- refreshes this section's own BRDP count and
  // tells ResetDataSection's sibling count to refresh too, exactly like
  // the old synchronous handleApplyImport did right after success.
  useEffect(() => {
    const prevStatus = lastJobStatusRef.current;
    lastJobStatusRef.current = job?.status ?? null;
    if (job?.status === 'completed' && prevStatus !== 'completed') {
      refreshCount();
      onDataChanged();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.status]);

  // Real, curated template per standard (10 real BRDPs, Rule Status Verified,
  // Rule already filled in -- CURATED_TEMPLATE_BY_STANDARD's own comment),
  // served as it is from public/, when one exists for this project's
  // standard; S1000D 5.0/6.0 (no generation engine yet) and any future
  // standard without a curated file get the generic template the server
  // builds (GET /api/brdp-template.xlsx, excel_io.py). A failed download
  // is shown next to the button (HR7), never swallowed.
  const handleDownloadTemplate = async () => {
    setTemplateError(null);
    const curatedPath = CURATED_TEMPLATE_BY_STANDARD[standard];
    try {
      const res = curatedPath ? await fetch(curatedPath) : await authFetch('/api/brdp-template.xlsx');
      if (!res.ok) throw new Error(detailText(await responseDetail(res)));
      saveBlob(await res.blob(), curatedPath ? curatedPath.slice(1) : 'brdp-template.xlsx');
    } catch (err) {
      setTemplateError(t('config.dataManagement.templateFailed', { message: err.message }));
    }
  };

  const resetImportState = () => {
    setPendingRows(null);
    setAnalysis(null);
    setConflictResolution('keep');
    setImportErrors([]);
  };

  // Phase 1 (docs request): runs automatically as soon as a file parses
  // cleanly -- no writes to Postgres happen here at all, it only builds
  // the summary the user reviews before Apply. The file itself is read on
  // the server (POST .../import/parse, excel_io.py): a file that cannot be
  // read safely (not .xlsx, corrupt, too large) comes back as a 422 with
  // the reason, shown here, and nothing goes further.
  const handleFileSelect = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    resetImportState();
    if (fileInputRef.current) fileInputRef.current.value = '';
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await authFetch(`/api/projects/${projectId}/brdps/import/parse`, { method: 'POST', body: form });
      if (!res.ok) {
        setImportErrors([detailText(await responseDetail(res))]);
        return;
      }
      const { rows, errors } = await res.json();
      if (errors.length > 0) {
        setImportErrors(errors);
        return;
      }
      if (rows.length === 0) {
        setImportErrors([t('config.dataManagement.noValidRows')]);
        return;
      }
      const result = await authFetchJson(`/api/projects/${projectId}/brdps/import/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows }),
      });
      setPendingRows(rows);
      setAnalysis(result);
      setShowCatalogEdition(false);
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
  // Phase 1 summary and explicitly clicked Apply. Now fires the
  // background job and returns immediately (202) -- the real work,
  // including re-validating against CURRENT Postgres state, happens
  // server-side (app/services/import_jobs.py), never trusting the Phase 1
  // classification computed here, which could be stale by now.
  const handleApplyImport = async () => {
    setApplying(true);
    setImportErrors([]);
    try {
      await authFetchJson(`/api/projects/${projectId}/brdps/import/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: pendingRows, conflict_resolution: conflictResolution }),
      });
      setPendingRows(null);
      setAnalysis(null);
      dismissImportJob(projectId, null);
      invalidateImportJob(projectId);
    } catch (err) {
      // 409 (another job already running for this project -- docs
      // request: at most one at a time) reads fine as-is from the
      // backend's own detail message; refresh the job query either way so
      // the UI reflects whatever IS actually running instead of staying
      // stuck on the stale "no job" view.
      setImportErrors([err.message]);
      invalidateImportJob(projectId);
    } finally {
      setApplying(false);
    }
  };

  const okCount = analysis?.results.filter((r) => r.outcome === 'ok').length ?? 0;
  const rejectedRows = analysis?.results.filter((r) => r.outcome === 'rejected') ?? [];
  const conflictRows = analysis?.results.filter((r) => r.outcome === 'conflict') ?? [];
  // Warning, not a rejection -- these rows DO still import (docs request),
  // shown up front (same place/detail level as rejected rows) so the
  // Title/Definition override is visible before confirming, not after.
  const catalogOverrideRows = analysis?.results.filter((r) => r.catalog_override) ?? [];
  // Same idea as catalogOverrideRows above, for the Rule column -- a row
  // that will replace an existing Rule with different content, shown
  // alongside (not instead of) a catalog override on the same row.
  const ruleOverrideRows = analysis?.results.filter((r) => r.rule_override) ?? [];
  // Purely informational (docs request), never a warning like the two
  // above -- rows Apply will skip touching entirely because all four core
  // fields already match what's stored (no field write, no history entry).
  const unchangedRows = analysis?.results.filter((r) => r.unchanged) ?? [];
  // An official identifier the catalog of the project's standard does not
  // have but another S1000D edition's does: imported with that edition's
  // Title/Definition, never rejected (same as AI Extract's "From catalog
  // (S1000D 4.1)").
  const catalogEditionRows = analysis?.results.filter((r) => r.catalog_edition) ?? [];
  const standardVersion = standard?.replace(/^S1000D\s+/, '');

  const handleExport = async () => {
    setBusy(true);
    setExportError(null);
    try {
      const brdps = await authFetchJson(`/api/projects/${projectId}/brdps`);
      // S1000D 5.0/6.0 have no rule format at all (no generation engine
      // exists for them yet, see STANDARD_TO_RULE_FORMAT) -- skip the
      // fetch entirely rather than call an endpoint with an undefined
      // format; every row falls back to "To Do"/empty Rule, same as
      // RecordsPage's own convention. Every other standard, both DITA 1.3
      // flavors included (SCH-DITA), has a real format and exports real
      // Rule/Rule Status content.
      const ruleFormat = STANDARD_TO_RULE_FORMAT[standard];
      let approvalsByBrdpId = {};
      if (ruleFormat) {
        const approvals = await authFetchJson(`/api/projects/${projectId}/approvals/${ruleFormat}/export`);
        approvalsByBrdpId = Object.fromEntries(approvals.map((a) => [a.brdp_id, a]));
      }
      const reportRows = brdps.map((b) => brdpToExportRow(b, approvalsByBrdpId[b.id] ?? null));

      // The server writes the file (POST .../export.xlsx, excel_io.py). A
      // cell over Excel's 32,767-character limit refuses the whole export
      // with a 422 naming each BRDP and field -- shown here, nothing cut,
      // never a partial file.
      const res = await authFetch(`/api/projects/${projectId}/export.xlsx`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: reportRows }),
      });
      if (!res.ok) {
        const detail = await responseDetail(res);
        if (detail?.code === 'cell_too_large') {
          const ids = [...new Set(detail.cells.map((c) => c.id))];
          const listed = detail.cells.map((c) => `${c.id} (${c.field})`).join(', ');
          setExportError(t('config.dataManagement.exportCellTooLarge', { count: ids.length, ids: listed }));
        } else {
          setExportError(t('config.dataManagement.exportFailed', { message: detailText(detail) }));
        }
        return;
      }
      saveBlob(await res.blob(), 'brdps-export.xlsx');
    } catch (err) {
      setExportError(t('config.dataManagement.exportFailed', { message: err.message }));
    } finally {
      setBusy(false);
    }
  };

  // Showing the job's own panel (progress/result/error) takes over the
  // whole Import subsection in place of the file-picker/analyze/apply
  // flow -- a job that's actually running must not be raced by starting
  // a second analyze/apply in the same UI, and a just-finished one is the
  // more relevant thing to show until the user dismisses it.
  const showingJobPanel = !!job && (job.status === 'running' || (job.id !== dismissedJobId && job.status !== 'running'));

  return (
    <div className={styles.card}>
      <h2 className={styles.sectionHeading}>{t('config.dataManagement.title')}</h2>

      <div className={styles.subsection}>
        <h3 className={styles.subsectionHeading}>{t('config.dataManagement.downloadTemplateTitle')}</h3>
        <Button onClick={handleDownloadTemplate}>{t('config.dataManagement.downloadTemplateButton')}</Button>
        {templateError && (
          <ul className={styles.errorList}>
            <li>{templateError}</li>
          </ul>
        )}
      </div>

      <div className={styles.subsection}>
        <h3 className={styles.subsectionHeading}>{t('config.dataManagement.exportTitle')}</h3>
        <Button onClick={handleExport} disabled={busy}>
          {/* A large project's export takes a few seconds (fetching every
              BRDP and rule, then the server writing the file) -- the
              spinner keeps the "still working" signal visible. */}
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

          {showingJobPanel ? (
            <div>
              {job.status === 'running' && (
                <p className={styles.hint}>
                  <span className={styles.spinner} aria-hidden="true" />
                  {t('config.dataManagement.jobRunning', {
                    processed: job.processed_rows,
                    total: job.total_rows,
                  })}
                </p>
              )}

              {job.status === 'completed' && (
                <div>
                  <h4 className={styles.subsectionHeading}>{t('config.dataManagement.resultTitle')}</h4>
                  <ul className={styles.summaryList}>
                    <li>{t('config.dataManagement.resultCreated', { count: job.result.created })}</li>
                    <li>{t('config.dataManagement.resultUpdated', { count: job.result.updated })}</li>
                    <li>{t('config.dataManagement.resultUnchanged', { count: job.result.unchanged })}</li>
                    <li>{t('config.dataManagement.resultRejected', { count: job.result.rejected })}</li>
                    {job.result.conflicts_kept > 0 && (
                      <li>{t('config.dataManagement.resultConflictsKept', { count: job.result.conflicts_kept })}</li>
                    )}
                    {job.result.conflicts_cleared > 0 && (
                      <li>
                        {t('config.dataManagement.resultConflictsCleared', { count: job.result.conflicts_cleared })}
                      </li>
                    )}
                  </ul>
                  <button type="button" className={styles.secondaryButton} onClick={() => dismissImportJob(projectId, job.id)}>
                    {t('config.dataManagement.close')}
                  </button>
                </div>
              )}

              {job.status === 'failed' && (
                <div>
                  <ul className={styles.errorList}>
                    <li>{t('config.dataManagement.jobFailed', { error: job.error })}</li>
                  </ul>
                  <button type="button" className={styles.secondaryButton} onClick={() => dismissImportJob(projectId, job.id)}>
                    {t('config.dataManagement.close')}
                  </button>
                </div>
              )}
            </div>
          ) : (
            <>
              {!analysis && (
                <>
                  <label className={styles.fileInputLabel}>
                    {t('config.dataManagement.chooseFile')}
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".xlsx"
                      onChange={handleFileSelect}
                      hidden
                      disabled={busy}
                    />
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
                    {unchangedRows.length > 0 && (
                      <>
                        {' · '}
                        {t('config.dataManagement.summaryUnchanged', { count: unchangedRows.length })}
                      </>
                    )}
                    {catalogOverrideRows.length > 0 && (
                      <>
                        {' · '}
                        {t('config.dataManagement.summaryCatalogOverrides', { count: catalogOverrideRows.length })}
                      </>
                    )}
                    {catalogEditionRows.length > 0 && (
                      <>
                        {' · '}
                        <span data-testid="import-catalog-edition-count">
                          {t('config.dataManagement.summaryCatalogEdition', { count: catalogEditionRows.length })}
                        </span>
                      </>
                    )}
                    {ruleOverrideRows.length > 0 && (
                      <>
                        {' · '}
                        {t('config.dataManagement.summaryRuleOverrides', { count: ruleOverrideRows.length })}
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

                  {catalogEditionRows.length > 0 && (
                    <div data-testid="import-catalog-edition">
                      <h4 className={styles.subsectionHeading}>
                        {t('config.dataManagement.catalogEditionListTitle', { count: catalogEditionRows.length })}{' '}
                        <button
                          type="button"
                          className={styles.linkButton}
                          aria-expanded={showCatalogEdition}
                          onClick={() => setShowCatalogEdition((v) => !v)}
                          data-testid="import-catalog-edition-toggle"
                        >
                          {showCatalogEdition
                            ? t('config.dataManagement.catalogEditionHide')
                            : t('config.dataManagement.catalogEditionShow')}
                        </button>
                      </h4>
                      {showCatalogEdition && (
                        <>
                          <p className={styles.hint}>{t('config.dataManagement.catalogEditionHint')}</p>
                          <ul className={styles.warningList} data-testid="import-catalog-edition-list">
                            {catalogEditionRows.map((r) => (
                              <li key={r.row_number}>
                                {t(
                                  r.catalog_edition_retired
                                    ? 'config.dataManagement.catalogEditionRowRetired'
                                    : 'config.dataManagement.catalogEditionRow',
                                  {
                                    row: r.row_number,
                                    identifier: r.identifier,
                                    standard,
                                    edition: r.catalog_edition,
                                    version: standardVersion,
                                  },
                                )}
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                    </div>
                  )}

                  {catalogOverrideRows.length > 0 && (
                    <>
                      <h4 className={styles.subsectionHeading}>
                        {t('config.dataManagement.catalogOverrideListTitle')}
                      </h4>
                      <ul className={styles.warningList}>
                        {catalogOverrideRows.map((r) => (
                          <li key={r.row_number}>
                            {r.catalog_edition
                              ? t('config.dataManagement.catalogOverrideRowEdition', {
                                  row: r.row_number,
                                  identifier: r.identifier,
                                  edition: r.catalog_edition,
                                })
                              : t('config.dataManagement.catalogOverrideRow', {
                                  row: r.row_number,
                                  identifier: r.identifier,
                                })}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}

                  {ruleOverrideRows.length > 0 && (
                    <>
                      <h4 className={styles.subsectionHeading}>
                        {t('config.dataManagement.ruleOverrideListTitle')}
                      </h4>
                      <ul className={styles.warningList}>
                        {ruleOverrideRows.map((r) => (
                          <li key={r.row_number}>
                            {t('config.dataManagement.ruleOverrideRow', {
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
                    <Button onClick={handleApplyImport} disabled={applying}>
                      {applying && <span className={styles.spinner} aria-hidden="true" />}
                      {applying ? t('config.dataManagement.applying') : t('config.dataManagement.applyButton')}
                    </Button>
                    <button
                      type="button"
                      className={styles.secondaryButton}
                      onClick={handleCancelImport}
                      disabled={applying}
                    >
                      {t('config.dataManagement.cancel')}
                    </button>
                  </div>
                </div>
              )}
            </>
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
      // One bulk request (backend: brdps.py's reset_project_data, a
      // single UPDATE ... WHERE project_id = ...) instead of N sequential
      // per-row DELETEs -- the N+1 this used to be. Still a soft-delete,
      // same Papelera path as any other delete (docs request: no
      // hard-delete shortcut here).
      await authFetchJson(`/api/projects/${projectId}/brdps`, { method: 'DELETE' });
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
  // C3b: success is confirmed on the button itself (green with a ✓ for a
  // moment); a failure stays next to it until the next attempt (HR7).
  const [saved, flashSaved] = useButtonSuccessFlash();
  const [saveError, setSaveError] = useState(null);

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
  };

  // A failed save (or a failed reload of what was saved) is shown next to
  // the button, never swallowed (HR7).
  // Schema location (S1000D only): the option shown is one this standard
  // offers -- "master" stored on a 4.x project reads as flat --, and a custom
  // pattern must be valid before anything is saved (the reason is shown
  // under the field; the backend refuses an invalid one too).
  const hasSchemaLocation = supportsSchemaContext(project.standard);
  const locationOptions = schemaLocationOptions(project.standard);
  const selectedLocation = locationOptions.includes(values.schemaLocation) ? values.schemaLocation : 'flat';
  const patternError =
    hasSchemaLocation && selectedLocation === 'custom' ? validateSchemaPattern(values.schemaLocationPattern) : null;
  const previewLocation =
    selectedLocation === 'custom'
      ? patternError
        ? null
        : String(values.schemaLocationPattern).trim()
      : schemaLocationOf({ schemaLocation: selectedLocation }, project.standard);

  const handleSave = async (e) => {
    e.preventDefault();
    if (patternError) return;
    setIsSaving(true);
    setSaveError(null);
    const toSave = { ...values };
    if (hasSchemaLocation) {
      toSave.schemaLocation = selectedLocation;
      if (selectedLocation === 'custom') toSave.schemaLocationPattern = String(values.schemaLocationPattern).trim();
    }
    try {
      await authFetchJson(`/api/projects/${projectId}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_config: toSave }),
      });
    } catch (err) {
      setSaveError(t('config.saveError', { error: err.message }));
      setIsSaving(false);
      return;
    }
    try {
      await refreshProject();
    } catch (err) {
      setSaveError(t('config.reloadError', { error: err.message }));
    } finally {
      // The save itself succeeded: the button confirms it once it is no
      // longer busy, so the whole second of green is visible.
      setIsSaving(false);
      flashSaved();
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
          {hasSchemaLocation && (
            <div className={styles.field}>
              <label className={styles.label} htmlFor="cfg-schemaLocation">
                {t('config.fields.schemaLocation')}
              </label>
              <select
                id="cfg-schemaLocation"
                className={styles.input}
                value={selectedLocation}
                onChange={(e) => handleChange('schemaLocation', e.target.value)}
                disabled={!canEdit}
              >
                {locationOptions.map((loc) => (
                  <option key={loc} value={loc}>
                    {t(`config.fields.schemaLocationOptions.${loc}`)}
                  </option>
                ))}
              </select>
              <span className={styles.hint}>{t('config.fields.schemaLocationHint')}</span>
              {selectedLocation === 'custom' && (
                <>
                  <label className={styles.label} htmlFor="cfg-schemaLocationPattern">
                    {t('config.fields.schemaLocationPattern')}
                  </label>
                  <input
                    id="cfg-schemaLocationPattern"
                    className={styles.input}
                    value={values.schemaLocationPattern || ''}
                    placeholder="../schemas/{schema}.xsd"
                    onChange={(e) => handleChange('schemaLocationPattern', e.target.value)}
                    disabled={!canEdit}
                    aria-invalid={patternError ? 'true' : 'false'}
                  />
                  <span className={styles.hint}>{t('config.fields.schemaLocationPatternHint')}</span>
                  {patternError && (
                    <span className={styles.saveError} role="alert" data-testid="schema-pattern-error">
                      {t(`config.fields.schemaPatternErrors.${patternError.code}`, patternError.params)}
                    </span>
                  )}
                </>
              )}
              {previewLocation && (
                <div className={styles.hint} data-testid="schema-location-preview">
                  {t('config.fields.schemaLocationPreview')}:
                  {['proced', 'descript'].map((schema) => (
                    <div key={schema}>
                      <code>{schemaContextUrl(project.standard, schema, previewLocation)}</code>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {canEdit && (
          <Button
            type="submit"
            busy={isSaving}
            busyLabel={t('config.saving')}
            success={saved}
            disabled={!!patternError}
            data-testid="config-save"
          >
            {t('config.save')}
          </Button>
        )}
        {saveError && (
          <span className={styles.saveError} role="alert" data-testid="config-save-error">
            {saveError}
          </span>
        )}
        {!canEdit && <p className={styles.readOnlyNote}>{t('config.readOnly')}</p>}
      </form>

      <DataManagementSection
        projectId={projectId}
        standard={project.standard}
        canEdit={canEdit}
        dataVersion={dataVersion}
        onDataChanged={bumpDataVersion}
      />
      {STANDARD_TO_RULE_FORMAT[project.standard] && (
        <RuleExtractSection
          projectId={projectId}
          standard={project.standard}
          ruleFormat={STANDARD_TO_RULE_FORMAT[project.standard]}
          canEdit={canEdit}
          onDataChanged={bumpDataVersion}
        />
      )}
      <ResetDataSection projectId={projectId} canEdit={canEdit} onDataChanged={bumpDataVersion} />
    </div>
  );
}
