import { useState, useEffect, useCallback, useRef } from 'react';
import { useProjectConfig } from '../hooks/useProjectConfig';
import { generateBREX } from '../api/generateBREX';
import { generateBREX301 } from '../api/generateBREX301.js';
import styles from './GenerateModal.module.css';

export default function GenerateModal({ brdps, onClose }) {
  const { projectConfig } = useProjectConfig();
  const [format, setFormat] = useState('BREX — S1000D 4.2');
  const [onlyValidated, setOnlyValidated] = useState(true);
  const [loading, setLoading] = useState(false);
  const [streamedChars, setStreamedChars] = useState(0);
  const [result, setResult] = useState(null);
  const [copied, setCopied] = useState(false);
  const abortRef = useRef(null);

  const validatedCount = brdps.filter(
    b => b.validation?.toLowerCase().trim() === 'validated'
  ).length;
  const allCount = brdps.length;
  const includedCount = onlyValidated ? validatedCount : allCount;
  const isConfigComplete = !!projectConfig?.modelIdentCode;
  const isBREX42 = format === 'BREX — S1000D 4.2';
  const isBREX301 = format === 'BREX — S1000D 3.0.1';

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

  useEffect(() => { setResult(null); }, [onlyValidated, format]);

  const handleGenerate = useCallback(async () => {
    const { apiKey, modelName, provider, customEndpoint } = getSettings();

    if (!apiKey) {
      setResult({ xml: null, valid: false, error: 'API key not configured. Go to Settings.', brdpCount: 0 });
      return;
    }

    setLoading(true);
    setResult(null);
    setStreamedChars(0);
    abortRef.current = new AbortController();

    try {
      let result;
      if (isBREX42) {
        result = await generateBREX(brdps, projectConfig, {
          apiKey,
          modelName,
          provider,
          customEndpoint,
          onlyValidated,
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
          onChunk: (chunk) => setStreamedChars(prev => prev + chunk.length),
          abortController: abortRef.current,
        });
      }
      setResult(result);
    } catch (err) {
      setResult({ xml: null, valid: false, error: err.message, brdpCount: 0 });
    } finally {
      setLoading(false);
    }
  }, [brdps, projectConfig, onlyValidated, isBREX42, isBREX301]);

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
              <option>Schematron 1.0</option>
            </select>
            {!isBREX42 && !isBREX301 && (
              <p className={styles.comingSoon}>
                ⚠ Only BREX — S1000D 4.2 and 3.0.1 are implemented. Other formats coming soon.
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
              disabled={!isConfigComplete || (!isBREX42 && !isBREX301)}
              title={!isBREX42 && !isBREX301 ? 'Only BREX 4.2 and 3.0.1 are available' : undefined}
            >
              {!isBREX42 && !isBREX301 ? 'Coming soon' : result ? 'Regenerate' : 'Generate'}
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
                {result.valid ? '✓ Well-formed XML' : `✗ XML error: ${result.error}`}
              </span>
              {result.brdpCount > 0 && (
                <span className={styles.countInfo}>{result.brdpCount} rules included</span>
              )}
            </div>
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
