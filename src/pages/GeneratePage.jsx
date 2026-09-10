import { useCallback, useEffect, useRef, useState } from 'react';
import { useOutletContext, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { authFetchJson } from '../services/apiClient';
import { generateBREX } from '../api/generateBREX';
import { generateBREX41 } from '../api/generateBREX41.js';
import { generateBREX301 } from '../api/generateBREX301.js';
import { generateSchematronDITA } from '../api/generateSchematronDITA.js';
import styles from './GeneratePage.module.css';

// Same format ids generateBREX*.js already default to internally (see
// each generator's `approvalsFormat` default) -- kept here explicitly
// because this page fetches approvals itself (see below) instead of
// letting the generator do it.
const FORMAT_DEFS = {
  'BREX — S1000D 4.2': { approvalsFormat: 'BREX-4.2', xsdFormat: '4.2', run: generateBREX },
  'BREX — S1000D 4.1': { approvalsFormat: 'BREX-4.1', xsdFormat: '4.1', run: generateBREX41 },
  'BREX — S1000D 3.0.1': { approvalsFormat: 'BREX-3.0.1', xsdFormat: '3.0.1', run: generateBREX301 },
  'Schematron 1.0 — DITA': { approvalsFormat: 'SCH-DITA', xsdFormat: null, run: generateSchematronDITA },
};

// docs/v2 §1/§2: project.standard is fixed at project creation and
// "Generate BREX/Schematron no ofrece selector, genera directamente el
// formato del proyecto" -- one project standard maps to exactly one
// generation format, never an open choice at generate time. (Schematron
// 1.0 — S1000D has no entry here: it's a BREX-3.0.1 derivative
// (generateBREXSch reuses generateBREX301 internally, see CLAUDE.md), not
// a project.standard value of its own in v2's model -- same reasoning
// already applied to routes/similar.py's kind='rule' standard->format
// mapping on the backend, kept consistent here.)
const STANDARD_TO_FORMAT = {
  'S1000D 4.2': 'BREX — S1000D 4.2',
  'S1000D 4.1': 'BREX — S1000D 4.1',
  'S1000D 3.0.1': 'BREX — S1000D 3.0.1',
  'DITA 1.3': 'Schematron 1.0 — DITA',
};

// generateBREX()/generateBREX41()/generateBREX301()/generateBREXSch()/
// generateSchematronDITA() are the untouched core engine (CLAUDE.md) --
// they all accept an `approvals` override (a Map keyed by brdp_id) that
// bypasses their built-in fetchApprovalsMap(), which otherwise targets
// v1's global, unscoped GET /api/approvals/format/:format (no v2
// equivalent: v2's approvals are per-project-BRDP). This fetches each
// target BRDP's frozen approval via the real v2 per-BRDP endpoint and
// feeds the engine through that seam instead, so the engine itself never
// needs to know v2 exists.
async function fetchApprovalsOverride(projectId, brdps, format) {
  const entries = await Promise.all(
    brdps.map(async (b) => {
      try {
        const approval = await authFetchJson(
          `/api/projects/${projectId}/brdps/${b.id}/approvals/${encodeURIComponent(format)}`
        );
        return approval ? [b.id, { brdp_id: b.id, ...approval }] : null;
      } catch (err) {
        console.error(`Failed to fetch approval for BRDP ${b.id} (${format}):`, err);
        return null;
      }
    })
  );
  return new Map(entries.filter(Boolean));
}

// XSD validation needs a real auth header (v2's /api/validate-brex is
// behind get_current_user, unlike v1's Express route) -- src/api/
// validateBREX.js is part of the protected core engine (CLAUDE.md) and
// uses a plain unauthenticated fetch, so this page talks to the same
// endpoint directly through authFetchJson instead of importing it.
async function validateAgainstXSDAuthed(xml, format) {
  return authFetchJson('/api/validate-brex', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ xml, format }),
  });
}

export default function GeneratePage() {
  const { t } = useTranslation();
  const { projectId } = useParams();
  const { project } = useOutletContext();

  // Fixed by the project's own standard, never user-selectable (docs/v2 §1).
  const format = STANDARD_TO_FORMAT[project.standard];

  const [brdps, setBrdps] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [onlyValidated, setOnlyValidated] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState(null);
  const [copied, setCopied] = useState(false);
  const [xsdValidation, setXsdValidation] = useState(null);
  const generationRef = useRef(0);

  useEffect(() => {
    authFetchJson(`/api/projects/${projectId}/brdps`).then((data) => {
      setBrdps(data);
      setIsLoading(false);
    });
  }, [projectId]);

  useEffect(() => {
    setResult(null);
    setXsdValidation(null);
  }, [onlyValidated]);

  const formatDef = FORMAT_DEFS[format];
  const isImplemented = !!formatDef;
  const validatedCount = brdps.filter((b) => b.validation?.toLowerCase().trim() === 'validated').length;
  const includedCount = onlyValidated ? validatedCount : brdps.length;
  const isConfigComplete = !!project.project_config?.modelIdentCode;

  const handleGenerate = useCallback(async () => {
    if (!formatDef) return;
    setGenerating(true);
    setResult(null);
    setXsdValidation(null);
    const generationId = ++generationRef.current;

    try {
      const targetBRDPs = onlyValidated
        ? brdps.filter((b) => b.validation?.toLowerCase().trim() === 'validated')
        : brdps;
      const approvals = await fetchApprovalsOverride(projectId, targetBRDPs, formatDef.approvalsFormat);
      const output = await formatDef.run(brdps, project.project_config, { onlyValidated, approvals });
      setResult(output);

      if (output?.xml && formatDef.xsdFormat) {
        setXsdValidation({ status: 'validating' });
        validateAgainstXSDAuthed(output.xml, formatDef.xsdFormat)
          .then(({ valid, errors }) => {
            if (generationRef.current === generationId) setXsdValidation({ status: 'done', valid, errors });
          })
          .catch((err) => {
            if (generationRef.current === generationId) setXsdValidation({ status: 'error', message: err.message });
          });
      }
    } catch (err) {
      setResult({ xml: null, valid: false, error: err.message, brdpCount: 0 });
    } finally {
      setGenerating(false);
    }
  }, [brdps, project.project_config, projectId, onlyValidated, formatDef]);

  const handleCopy = () => {
    if (!result?.xml) return;
    navigator.clipboard.writeText(result.xml);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    if (!result?.xml) return;
    const dateStr = new Date().toISOString().slice(0, 10);
    const mic = project.project_config?.modelIdentCode || 'UNKNOWN';
    const isSchDITA = format === 'Schematron 1.0 — DITA';
    const isBREX301 = format === 'BREX — S1000D 3.0.1';
    const isBREX41 = format === 'BREX — S1000D 4.1';
    const filename = isSchDITA
      ? `${mic}_${dateStr}_dita.sch`
      : isBREX301
      ? `DMC-${mic}-00-00-00-00A-022A-D_${dateStr}_301.xml`
      : isBREX41
      ? `DMC-${mic}-00-00-00-00A-022A-A_${dateStr}_41.xml`
      : `DMC-${mic}-00-00-00-00A-022A-A_${dateStr}.xml`;
    const blob = new Blob([result.xml], { type: 'application/xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const isSchDITA = format === 'Schematron 1.0 — DITA';

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>{t('nav.generate')}</h1>
      <p className={styles.subtitle}>
        {project.name} · {project.standard} · {isLoading ? '…' : `${brdps.length} BRDPs`}
      </p>

      <div className={styles.card}>
        <label className={styles.fieldLabel}>Format &amp; Standard</label>
        <p className={styles.fixedFormat}>{format || `No generator for "${project.standard}"`}</p>
        {!isImplemented && (
          <p className={styles.warning}>
            ⚠ Generation is not implemented yet for this project's standard ({project.standard}).
          </p>
        )}

        <label className={styles.checkboxLabel}>
          <input type="checkbox" checked={onlyValidated} onChange={(e) => setOnlyValidated(e.target.checked)} />
          Only include Validated BRDPs
        </label>

        <p className={styles.summary}>
          {includedCount} {includedCount === 1 ? 'BRDP' : 'BRDPs'} will be included
        </p>

        {!isConfigComplete && (
          <p className={styles.warning}>⚠ Project configuration incomplete. Go to Project Configuration first.</p>
        )}

        <button
          className={styles.generateBtn}
          onClick={handleGenerate}
          disabled={generating || isLoading || !isImplemented || !isConfigComplete}
        >
          {generating ? 'Generating…' : result ? 'Regenerate' : 'Generate'}
        </button>
      </div>

      {result && (
        <div className={styles.outputCard}>
          <div className={styles.outputMeta}>
            <span className={result.valid ? styles.badgeOk : styles.badgeError}>
              {result.valid ? '✓ Well-formed XML' : `✗ XML error: ${result.error || (result.errors || []).join('; ')}`}
            </span>
            {result.brdpCount > 0 && <span className={styles.countInfo}>{result.brdpCount} rules included</span>}
          </div>

          {formatDef?.xsdFormat && result.xml && (
            <div className={styles.xsdSection}>
              {xsdValidation?.status === 'validating' ? (
                <span className={styles.badgePending}>⧗ Validating against XSD…</span>
              ) : xsdValidation?.status === 'error' ? (
                <span className={styles.badgeError}>✗ XSD validation failed to run: {xsdValidation.message}</span>
              ) : xsdValidation?.status === 'done' && xsdValidation.valid ? (
                <span className={styles.badgeOk}>✓ Valid against XSD schema</span>
              ) : xsdValidation?.status === 'done' && !xsdValidation.valid ? (
                <details>
                  <summary className={styles.badgeError}>
                    ✗ {xsdValidation.errors.length} XSD validation {xsdValidation.errors.length === 1 ? 'issue' : 'issues'}
                  </summary>
                  <ul className={styles.errorList}>
                    {xsdValidation.errors.map((e, i) => (
                      <li key={i}>
                        {e.line ? `Line ${e.line}: ` : ''}
                        {e.message}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </div>
          )}

          {isSchDITA && result.xml && result.vocabularyWarnings?.length > 0 && (
            <details className={styles.xsdSection}>
              <summary className={styles.badgePending}>
                ⚠ {result.vocabularyWarnings.length} vocabulary {result.vocabularyWarnings.length === 1 ? 'warning' : 'warnings'} (non-blocking)
              </summary>
              <ul className={styles.errorList}>
                {result.vocabularyWarnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </details>
          )}

          {result.xml ? (
            <>
              <pre className={styles.xmlOutput}>{result.xml}</pre>
              <div className={styles.outputActions}>
                <button onClick={handleCopy}>{copied ? 'Copied!' : 'Copy to clipboard'}</button>
                <button onClick={handleDownload}>Download</button>
              </div>
            </>
          ) : (
            <div className={styles.errorBox}>{result.error}</div>
          )}
        </div>
      )}
    </div>
  );
}
