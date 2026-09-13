import { useEffect, useState } from 'react';
import { useOutletContext, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { authFetchJson } from '../services/apiClient';
import { downloadReport } from '../api/buildBREXdocReport';
import Button from '../components/Button';
import styles from './GenerateBREXdocPage.module.css';

// buildHTML()/buildMarkdown()/downloadReport() (v1's untouched core
// engine, CLAUDE.md -- no API calls, pure client-side, confirmed by
// reading the file) still speak the old id/comment shape internally.
// v2's BRDP schema calls those identifier/comments and has a separate
// real UUID id -- same translation ProjectConfigPage's Export to Excel
// already needs for the exact same reason.
function brdpToReportRow(brdp) {
  return {
    id: brdp.identifier,
    title: brdp.title,
    definition: brdp.definition,
    proposal: brdp.proposal,
    validation: brdp.validation,
    comment: brdp.comments,
  };
}

export default function GenerateBREXdocPage() {
  const { t } = useTranslation();
  const { projectId } = useParams();
  const { project } = useOutletContext();
  const [brdps, setBrdps] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [format, setFormat] = useState('html');

  // Same fetch RecordsPage/GeneratePage already use -- no dedicated
  // backend endpoint for this report, it's assembled entirely from data
  // already available in the app.
  useEffect(() => {
    authFetchJson(`/api/projects/${projectId}/brdps`).then((data) => {
      setBrdps(data);
      setIsLoading(false);
    });
  }, [projectId]);

  const reportRows = brdps.map(brdpToReportRow);
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
