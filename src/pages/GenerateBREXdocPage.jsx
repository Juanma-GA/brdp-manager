import { useEffect, useState } from 'react';
import { useOutletContext, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { authFetchJson } from '../services/apiClient';
import { downloadReport } from '../api/buildBREXdocReport';
import { STANDARD_TO_RULE_FORMAT } from '../constants/ruleFormats';
import { ruleStateOf } from '../utils/ruleState';
import Button from '../components/Button';
import styles from './GenerateBREXdocPage.module.css';

// Plain English labels, not i18n'd -- same convention already used by
// ProjectConfigPage's Export to Excel (RULE_STATUS_LABELS there) for the
// exact same reason: this report is a downloaded artifact, not live UI
// chrome, and the rest of buildBREXdocReport.js's own text (column
// headers, section titles) is hardcoded English too.
const RULE_STATUS_LABELS = { todo: 'To Do', draft: 'Draft', verified: 'Verified' };

// buildHTML()/buildMarkdown()/downloadReport() (v1's untouched core
// engine, CLAUDE.md -- no API calls, pure client-side, confirmed by
// reading the file) still speak the old id/comment shape internally.
// v2's BRDP schema calls those identifier/comments and has a separate
// real UUID id -- same translation ProjectConfigPage's Export to Excel
// already needs for the exact same reason. ruleApproval is the matching
// row from the project-wide bulk export endpoint (or null -- no row yet
// means "To Do", same convention as the live Records table and Export to
// Excel) -- Rule Status now replaces the old Comment column (docs
// request: Comment was never a real BRDP field to begin with, brdp.comments
// was v1's leftover free-text notes field).
function brdpToReportRow(brdp, ruleApproval) {
  return {
    id: brdp.identifier,
    title: brdp.title,
    definition: brdp.definition,
    proposal: brdp.proposal,
    validation: brdp.validation,
    ruleStatus: RULE_STATUS_LABELS[ruleStateOf(ruleApproval)],
  };
}

export default function GenerateBREXdocPage() {
  const { t } = useTranslation();
  const { projectId } = useParams();
  const { project } = useOutletContext();
  const [brdps, setBrdps] = useState([]);
  const [approvalsByBrdpId, setApprovalsByBrdpId] = useState({});
  const [isLoading, setIsLoading] = useState(true);
  const [format, setFormat] = useState('html');
  const ruleFormat = STANDARD_TO_RULE_FORMAT[project.standard];

  // Same fetch RecordsPage/GeneratePage already use -- no dedicated
  // backend endpoint for this report, it's assembled entirely from data
  // already available in the app. Rule Status needs the project's bulk
  // rule-approval export too (same endpoint/pattern ProjectConfigPage's
  // Export to Excel already uses) -- S1000D 5.0/6.0 have no rule format at
  // all, so that fetch is skipped for them and every row falls back to
  // "To Do" via ruleStateOf(null), same convention as everywhere else.
  useEffect(() => {
    setIsLoading(true);
    Promise.all([
      authFetchJson(`/api/projects/${projectId}/brdps`),
      ruleFormat ? authFetchJson(`/api/projects/${projectId}/approvals/${ruleFormat}/export`) : Promise.resolve([]),
    ]).then(([brdpData, approvals]) => {
      setBrdps(brdpData);
      setApprovalsByBrdpId(Object.fromEntries(approvals.map((a) => [a.brdp_id, a])));
      setIsLoading(false);
    });
  }, [projectId, ruleFormat]);

  const reportRows = brdps.map((b) => brdpToReportRow(b, approvalsByBrdpId[b.id] ?? null));
  const total = reportRows.length;
  const validated = reportRows.filter((b) => b.validation === 'Validated').length;
  const refused = reportRows.filter((b) => b.validation === 'Refused').length;
  const pending = reportRows.filter((b) => b.validation === 'Pending').length;

  const handleDownload = () => {
    downloadReport(reportRows, project.project_config || {}, format);
  };

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>{t('nav.brexdoc')}</h1>
      <p className={styles.subtitle}>
        {project.name} · {project.standard}
      </p>

      <div className={styles.card}>
        {isLoading ? (
          <p>…</p>
        ) : (
          <>
            <div className={styles.statsRow}>
              <div className={styles.stat}>
                <span className={styles.statNum}>{total}</span>
                <span className={styles.statLbl}>{t('brexdoc.total')}</span>
              </div>
              <div className={`${styles.stat} ${styles.green}`}>
                <span className={styles.statNum}>{validated}</span>
                <span className={styles.statLbl}>{t('records.validationOptions.Validated')}</span>
              </div>
              <div className={`${styles.stat} ${styles.red}`}>
                <span className={styles.statNum}>{refused}</span>
                <span className={styles.statLbl}>{t('records.validationOptions.Refused')}</span>
              </div>
              <div className={`${styles.stat} ${styles.amber}`}>
                <span className={styles.statNum}>{pending}</span>
                <span className={styles.statLbl}>{t('records.validationOptions.Pending')}</span>
              </div>
            </div>

            <label className={styles.fieldLabel}>{t('brexdoc.outputFormat')}</label>
            <div className={styles.radioGroup}>
              <label className={styles.radioLabel}>
                <input type="radio" checked={format === 'html'} onChange={() => setFormat('html')} />
                {t('brexdoc.formatHtml')} <span className={styles.hint}>{t('brexdoc.formatHtmlHint')}</span>
              </label>
              <label className={styles.radioLabel}>
                <input type="radio" checked={format === 'md'} onChange={() => setFormat('md')} />
                {t('brexdoc.formatMarkdown')} <span className={styles.hint}>{t('brexdoc.formatMarkdownHint')}</span>
              </label>
            </div>

            <Button onClick={handleDownload}>
              {t('brexdoc.download', { extension: format === 'html' ? '.html' : '.md' })}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
