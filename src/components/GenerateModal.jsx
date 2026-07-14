import { useState, useEffect, useCallback, useRef } from 'react';
import { useProjectConfig } from '../hooks/useProjectConfig';
import { generateBREX } from '../api/generateBREX';
import { generateBREX41 } from '../api/generateBREX41.js';
import { generateBREX301 } from '../api/generateBREX301.js';
import { generateBREXSch } from '../api/generateBREXSch.js';
import { generateSchematronDITA } from '../api/generateSchematronDITA.js';
import { validateAgainstXSD } from '../api/validateBREX.js';
import styles from './GenerateModal.module.css';

const XSD_FORMAT_MAP = {
  'BREX — S1000D 3.0.1': '3.0.1',
  'BREX — S1000D 4.1': '4.1',
  'BREX — S1000D 4.2': '4.2',
};

export default function GenerateModal({ brdps, onClose }) {
  const { projectConfig } = useProjectConfig();
  const [format, setFormat] = useState('BREX — S1000D 4.2');
  const [onlyValidated, setOnlyValidated] = useState(true);
  const [loading, setLoading] = useState(false);
  const [streamedChars, setStreamedChars] = useState(0);
  const [result, setResult] = useState(null);
  const [copied, setCopied] = useState(false);
  const [xsdValidation, setXsdValidation] = useState(null);
  const abortRef = useRef(null);
  const xsdGenerationRef = useRef(0);

  const validatedCount = brdps.filter(
    b => b.validation?.toLowerCase().trim() === 'validated'
  ).length;
  const allCount = brdps.length;
  const includedCount = onlyValidated ? validatedCount : allCount;
  const isConfigComplete = !!projectConfig?.modelIdentCode;
  const isBREX42 = format === 'BREX — S1000D 4.2';
  const isBREX41 = format === 'BREX — S1000D 4.1';
  const isBREX301 = format === 'BREX — S1000D 3.0.1';
  const isSchS1000D = format === 'Schematron 1.0 — S1000D';
  const isSchDITA = format === 'Schematron 1.0 — DITA';
  const xsdFormat = XSD_FORMAT_MAP[format];

  const getSettings = () => ({
    apiKey: localStorage.getItem('brdp_api_key') || '',
    modelName: localStorage.getItem('brdp_model') || '',
    provider: localStorage.getItem('brdp_provider') || 'Anthropic',
    customEndpoint: localStorage.getItem('brdp_custom_endpoint') || '',
  });

  useEffect(() => {
    const handleKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  useEffect(() => { setResult(null); setXsdValidation(null); }, [onlyValidated, format]);

  const handleGenerate = useCallback(async () => {
    const { apiKey, modelName, provider, customEndpoint } = getSettings();

    if (!apiKey) {
      setResult({ xml: null, valid: false, error: 'API key not configured. Go to Settings.', brdpCount: 0 });
      return;
    }

    setLoading(true);
    setResult(null);
    setXsdValidation(null);
    setStreamedChars(0);
    abortRef.current = new AbortController();
    const generationId = ++xsdGenerationRef.current;

    try {
      let result;
      if (isBREX42) {
        result = await generateBREX(brdps, projectConfig, {
          apiKey,
          modelName,
          provider,
          customEndpoint,
          onlyValidated,
          approvalsFormat: 'BREX-4.2',
          onChunk: (chunk) => setStreamedChars(prev => prev + chunk.length),
          abortController: abortRef.current,
        });
      } else if (isBREX41) {
        result = await generateBREX41(brdps, projectConfig, {
          apiKey,
          modelName,
          provider,
          customEndpoint,
          onlyValidated,
          approvalsFormat: 'BREX-4.1',
          onChunk: (chunk) => setStreamedChars(prev => prev + chunk.length),
          abortController: abortRef.current,
        });
      } else if (isBREX301) {
        result = await generateBREX301(brdps, projectConfig, {
          apiKey,
          modelName,
          provider,
          customEndpoint,
          onlyValidated,
          approvalsFormat: 'BREX-3.0.1',
          onChunk: (chunk) => setStreamedChars(prev => prev + chunk.length),
          abortController: abortRef.current,
        });
      } else if (isSchS1000D) {
        result = await generateBREXSch(brdps, projectConfig, {
          apiKey,
          modelName,
          provider,
          customEndpoint,
          onlyValidated,
          onChunk: (chunk) => setStreamedChars(prev => prev + chunk.length),
          abortController: abortRef.current,
        });
      } else if (isSchDITA) {
        result = await generateSchematronDITA(brdps, projectConfig, {
          apiKey,
          modelName,
          provider,
          customEndpoint,
          onlyValidated,
          onChunk: (chunk) => setStreamedChars(prev => prev + chunk.length),
          abortController: abortRef.current,
        });
      }
      setResult(result);

      // Real XSD schema validation -- separate from checkWellFormed() above.
      // Fires in the background; never blocks or replaces the generated XML.
      // Not available in `npm run dev` (no Node backend behind the Vite dev server).
      // Guarded by generationId so a slow response from a previous Generate
      // click can never overwrite the state of a newer one.
      if (result?.xml && xsdFormat && !import.meta.env.DEV) {
        setXsdValidation({ status: 'validating' });
        validateAgainstXSD(result.xml, xsdFormat)
          .then(({ valid, errors }) => {
            if (xsdGenerationRef.current === generationId) {
              setXsdValidation({ status: 'done', valid, errors });
            }
          })
          .catch((err) => {
            if (xsdGenerationRef.current === generationId) {
              setXsdValidation({ status: 'error', message: err.message });
            }
          });
      }
    } catch (err) {
      setResult({ xml: null, valid: false, error: err.message, brdpCount: 0 });
    } finally {
      setLoading(false);
    }
  }, [brdps, projectConfig, onlyValidated, isBREX42, isBREX41, isBREX301, isSchS1000D, isSchDITA, xsdFormat]);

  const handleCancel = () => {
    abortRef.current?.abort();
    setLoading(false);
  };

  const handleCopy = () => {
    if (!result?.xml) return;
    navigator.clipboard.writeText(result.xml);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    if (!result?.xml) return;
    const dateStr = new Date().toISOString().slice(0, 10);
    const filename = isBREX301
      ? `DMC-${projectConfig.modelIdentCode}-00-00-00-00A-022A-D_${dateStr}_301.xml`
      : isSchDITA
      ? `${projectConfig.modelIdentCode}_${dateStr}_dita.sch`
      : isSchS1000D
      ? `${projectConfig.modelIdentCode}_${dateStr}.sch`
      : isBREX41
      ? `DMC-${projectConfig.modelIdentCode}-00-00-00-00A-022A-A_${dateStr}_41.xml`
      : `DMC-${projectConfig.modelIdentCode}-00-00-00-00A-022A-A_${dateStr}.xml`;
    const blob = new Blob([result.xml], { type: 'application/xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className={styles.overlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className={styles.modal}>

        <div className={styles.header}>
          <div>
            <h2 className={styles.title}>Generate Output</h2>
            <span className={styles.subtitle}>{format}</span>
          </div>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className={styles.content}>

          <div className={styles.formGroup}>
            <label htmlFor="format" className={styles.label}>Format & Standard</label>
            <select
              id="format"
              value={format}
              onChange={(e) => setFormat(e.target.value)}
              className={styles.select}
            >
              <option>BREX — S1000D 3.0.1</option>
              <option>BREX — S1000D 4.1</option>
              <option>BREX — S1000D 4.2</option>
              <option>BREX — S1000D 5.0</option>
              <option>BREX — S1000D 6.0</option>
              <option>Schematron 1.0 — S1000D</option>
              <option>Schematron 1.0 — DITA</option>
            </select>
            {!isBREX42 && !isBREX41 && !isBREX301 && !isSchS1000D && !isSchDITA && (
              <p className={styles.comingSoon}>
                ⚠ Only BREX — S1000D 4.2, 4.1, 3.0.1, Schematron 1.0 — S1000D and Schematron 1.0 — DITA are implemented. Other formats coming soon.
              </p>
            )}
          </div>

          <div className={styles.checkboxGroup}>
            <label className={styles.checkboxLabel}>
              <input
                type="checkbox"
                checked={onlyValidated}
                onChange={(e) => setOnlyValidated(e.target.checked)}
                className={styles.checkbox}
              />
              Only include Validated BRDPs
            </label>
          </div>

          <div className={styles.summary}>
            <p className={styles.summaryText}>
              {includedCount} {includedCount === 1 ? 'BRDP' : 'BRDPs'} will be included
            </p>
          </div>

          <div className={styles.projectSummary}>
            {!isConfigComplete && (
              <p className={styles.warningText}>
                ⚠ Project configuration incomplete. Go to Settings before generating.
              </p>
            )}
            <p className={styles.projectText}>
              Project: <strong>{projectConfig.projectName || '—'}</strong> |{' '}
              Model: <strong>{projectConfig.modelIdentCode || '—'}</strong>
            </p>
          </div>

        </div>

        <div className={styles.generateSection}>
          {!loading ? (
            <button
              className={styles.generateBtn}
              onClick={handleGenerate}
              disabled={!isConfigComplete || (!isBREX42 && !isBREX41 && !isBREX301 && !isSchS1000D && !isSchDITA)}
              title={!isBREX42 && !isBREX41 && !isBREX301 && !isSchS1000D && !isSchDITA ? 'Only BREX 4.2, 4.1, 3.0.1, Schematron 1.0 — S1000D and Schematron 1.0 — DITA are available' : undefined}
            >
              {!isBREX42 && !isBREX41 && !isBREX301 && !isSchS1000D && !isSchDITA ? 'Coming soon' : result ? 'Regenerate' : 'Generate'}
            </button>
          ) : (
            <div className={styles.loadingRow}>
              <span className={styles.spinner} />
              <span>Generating… {streamedChars} characters received</span>
              <button className={styles.cancelBtn} onClick={handleCancel}>Cancel</button>
            </div>
          )}
        </div>

        {result && (
          <div className={styles.outputSection}>
            <div className={styles.outputMeta}>
              <span className={result.valid ? styles.badgeOk : styles.badgeError}>
                {result.valid ? '✓ Well-formed XML' : `✗ XML error: ${result.error || (result.errors || []).join('; ')}`}
              </span>
              {result.brdpCount > 0 && (
                <span className={styles.countInfo}>{result.brdpCount} rules included</span>
              )}
            </div>
            {xsdFormat && result.xml && (
              <div className={styles.xsdSection}>
                {import.meta.env.DEV ? (
                  <p className={styles.devNotice}>
                    Validación XSD no disponible en modo desarrollo (solo en npm start).
                  </p>
                ) : xsdValidation?.status === 'validating' ? (
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
                    <ul className={styles.xsdErrorList}>
                      {xsdValidation.errors.map((e, i) => (
                        <li key={i}>{e.line ? `Line ${e.line}: ` : ''}{e.message}</li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </div>
            )}
            {isSchDITA && result.xml && (
              <div className={styles.schSection}>
                {result.valid ? (
                  <span className={styles.badgeOk}>✓ Schematron structure checks passed</span>
                ) : (
                  <details>
                    <summary className={styles.badgeError}>
                      ✗ {result.errors.length} Schematron structure {result.errors.length === 1 ? 'issue' : 'issues'}
                    </summary>
                    <ul className={styles.xsdErrorList}>
                      {result.errors.map((e, i) => <li key={i}>{e}</li>)}
                    </ul>
                  </details>
                )}
                {result.vocabularyWarnings?.length > 0 && (
                  <details>
                    <summary className={styles.badgePending}>
                      ⚠ {result.vocabularyWarnings.length} vocabulary {result.vocabularyWarnings.length === 1 ? 'warning' : 'warnings'} (non-blocking)
                    </summary>
                    <ul className={styles.warnList}>
                      {result.vocabularyWarnings.map((w, i) => <li key={i}>{w}</li>)}
                    </ul>
                  </details>
                )}
              </div>
            )}
            {result.xml ? (
              <>
                <pre className={styles.xmlOutput}>{result.xml}</pre>
                <div className={styles.outputActions}>
                  <button className={styles.actionBtn} onClick={handleCopy}>
                    {copied ? 'Copied!' : 'Copy to clipboard'}
                  </button>
                  <button className={styles.actionBtn} onClick={handleDownload}>
                    Download as .xml
                  </button>
                </div>
              </>
            ) : (
              <div className={styles.errorBox}>{result.error}</div>
            )}
            <p className={styles.footerNote}>
              Validate against the full schema.
            </p>
          </div>
        )}

      </div>
    </div>
  );
}
