import { useState, useRef, useCallback, useEffect } from 'react';
import { extractBRDPs } from '../../api/extractBRDPs';
import styles from './AIExtractModal.module.css';

function getKeywords(text) {
  const stopwords = new Set([
    'the','a','an','of','to','and','is','be','shall','must','should',
    'that','this','in','on','for','with','not','are','or','as','by',
    'it','its','from','at','use','used','using','all','any','each',
    'will','may','been','have','has','was','were','their','they'
  ]);
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 3 && !stopwords.has(w));
}

function jaccardSimilarity(text1, text2) {
  const words1 = new Set(getKeywords(text1));
  const words2 = new Set(getKeywords(text2));
  if (words1.size === 0 || words2.size === 0) return 0;
  const intersection = new Set([...words1].filter(w => words2.has(w)));
  const union = new Set([...words1, ...words2]);
  return intersection.size / union.size;
}

function findDuplicate(newBrdp, existingBRDPs) {
  return existingBRDPs.find(existing =>
    jaccardSimilarity(newBrdp.title, existing.title) > 0.5 ||
    jaccardSimilarity(newBrdp.proposal, existing.proposal) > 0.4
  );
}

export default function AIExtractModal({ onClose, existingBRDPs, onImport }) {
  const [file, setFile] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0, foundCount: 0 });
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [mergeMode, setMergeMode] = useState('add');
  const [extractingMsg, setExtractingMsg] = useState('Reading document...');
  const [inputMode, setInputMode] = useState('file');
  const [pastedText, setPastedText] = useState('');
  const [excludedIds, setExcludedIds] = useState([]);
  const abortRef = useRef(null);
  const inputRef = useRef(null);

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

  useEffect(() => {
    if (!extracting) return;

    const messages = [
      'Reading document...',
      'Extracting text...',
      'Preparing text...',
    ];

    let index = 0;

    const interval = setInterval(() => {
      index = (index + 1) % messages.length;
      setExtractingMsg(messages[index]);
    }, 3000);

    return () => clearInterval(interval);
  }, [extracting]);

  useEffect(() => {
    if (result) setExcludedIds([]);
  }, [result]);

  const handleFile = (f) => {
    if (!f) return;
    const name = f.name.toLowerCase();
    if (!name.endsWith('.docx') && !name.endsWith('.pdf')) {
      setError('Only .docx and .pdf files are supported.');
      return;
    }
    setFile(f);
    setError(null);
    setResult(null);
  };

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setDragging(false);
    handleFile(e.dataTransfer.files[0]);
  }, []);

  const handleExtract = async () => {
    const { apiKey, modelName, provider, customEndpoint } = getSettings();
    if (!apiKey) {
      setError('API key not configured. Go to Settings.');
      return;
    }
    if (inputMode === 'file' && !file) {
      setError('Please select a file first.');
      return;
    }
    if (inputMode === 'text' && pastedText.trim().length === 0) {
      setError('Please paste some text first.');
      return;
    }
    if (inputMode === 'text' && pastedText.trim().length > 3000) {
      setError(`Text is too long: ${pastedText.trim().length} characters. Maximum is 3000 (about one page). For longer documents, use "Upload file".`);
      return;
    }

    setLoading(true);
    setExtracting(true);
    setError(null);
    setResult(null);
    setProgress({ current: 0, total: 0, foundCount: 0 });
    abortRef.current = new AbortController();

    try {
      const res = await extractBRDPs(inputMode === 'file' ? file : null, existingBRDPs, {
        apiKey,
        modelName,
        provider,
        customEndpoint,
        rawText: inputMode === 'text' ? pastedText : null,
        onProgress: (current, total, foundCount) => {
          setExtracting(false);
          setProgress({ current, total, foundCount });
        },
        abortController: abortRef.current,
      });
      setResult(res);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = () => {
    abortRef.current?.abort();
    setLoading(false);
  };

  const toggleExclude = (id) => {
    setExcludedIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  const handleImport = () => {
    if (!result?.brdps) return;
    const toImport = result.brdps.filter(b => !excludedIds.includes(b.id));
    if (toImport.length === 0) return;
    onImport(toImport, mergeMode);
    onClose();
  };

  return (
    <div className={styles.overlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className={styles.modal}>

        {/* Header */}
        <div className={styles.header}>
          <div>
            <h2 className={styles.title}>AI Extract</h2>
            <span className={styles.subtitle}>Extract BRDPs from a document using AI</span>
          </div>
          <button className={styles.closeBtn} onClick={onClose}>✕</button>
        </div>

        <div className={styles.content}>

          {/* Input mode selector */}
          <div className={styles.sourceTypeSection}>
            <label className={styles.sourceTypeLabel}>Input</label>
            <div className={styles.sourceTypeGroup}>
              {[['file', 'Upload file'], ['text', 'Paste text']].map(([mode, label]) => (
                <button
                  key={mode}
                  className={`${styles.sourceTypeBtn} ${inputMode === mode ? styles.sourceTypeBtnActive : ''}`}
                  onClick={() => { setInputMode(mode); setError(null); setResult(null); }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Paste text */}
          {inputMode === 'text' && (
            <textarea
              className={styles.dropZone}
              style={{ width: '100%', minHeight: '160px', resize: 'vertical', fontFamily: 'inherit', fontSize: '0.9rem', padding: '12px', boxSizing: 'border-box', textAlign: 'left', verticalAlign: 'top' }}
              placeholder="Paste your document text here (rules, style guide, BREX text, etc.)"
              value={pastedText}
              onChange={(e) => { setPastedText(e.target.value); setError(null); setResult(null); }}
            />
          )}

          {/* Drop zone */}
          {inputMode === 'file' && (
          <div
            className={`${styles.dropZone} ${dragging ? styles.dragging : ''} ${file ? styles.hasFile : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            onClick={() => inputRef.current?.click()}
          >
            <input
              ref={inputRef}
              type="file"
              accept=".docx,.pdf"
              style={{ display: 'none' }}
              onChange={(e) => handleFile(e.target.files[0])}
            />
            {file ? (
              <div className={styles.fileInfo}>
                <span className={styles.fileIcon}>📄</span>
                <span className={styles.fileName}>{file.name}</span>
                <span className={styles.fileSize}>({(file.size / 1024).toFixed(0)} KB)</span>
                <button
                  className={styles.removeFile}
                  onClick={(e) => { e.stopPropagation(); setFile(null); setResult(null); }}
                >✕</button>
              </div>
            ) : (
              <div className={styles.dropPrompt}>
                <span className={styles.dropIcon}>⬆</span>
                <span>Drop a <strong>.docx</strong> or <strong>.pdf</strong> file here</span>
                <span className={styles.dropSub}>or click to browse</span>
              </div>
            )}
          </div>
          )}

          {/* Error */}
          {error && <div className={styles.errorBox}>{error}</div>}

          {/* Extract button / loading */}
          {!loading ? (
            <button
              className={styles.extractBtn}
              onClick={handleExtract}
              disabled={inputMode === 'file' && !file}
            >
              {result ? 'Re-extract' : 'Extract BRDPs'}
            </button>
          ) : null}

          {loading && (
            <div className={styles.loadingRow}>
              <span className={styles.spinner} />
              {extracting ? (
                <>
                  <span>{extractingMsg}</span>
                  <button className={styles.cancelBtn} onClick={handleCancel}>Cancel</button>
                </>
              ) : (
                <>
                  <div className={styles.progressInfo}>
                    <span>Processing section {progress.current} of {progress.total}</span>
                    <div className={styles.progressBar}>
                      <div
                        className={styles.progressFill}
                        style={{ width: progress.total > 0 ? `${(progress.current / progress.total) * 100}%` : '0%' }}
                      />
                    </div>
                  </div>
                  <button className={styles.cancelBtn} onClick={handleCancel}>Cancel</button>
                </>
              )}
            </div>
          )}

          {/* Results */}
          {result && (
            <div className={styles.results}>
              <div className={styles.resultsMeta}>
                <span className={styles.badgeOk}>✓ {result.rawCount} BRDPs extracted</span>
              </div>

              {(() => {
                const duplicateCount = result.brdps.filter(b => findDuplicate(b, existingBRDPs)).length;
                return duplicateCount > 0 ? (
                  <div className={styles.duplicateWarning}>
                    ⚠️ {duplicateCount} possible duplicate{duplicateCount > 1 ? 's' : ''} detected — review before importing
                  </div>
                ) : null;
              })()}

              {/* Preview table */}
              <div className={styles.tableWrapper}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th></th>
                      <th>ID</th>
                      <th>Title</th>
                      <th>Proposal</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.brdps.map((b) => {
                      const duplicate = findDuplicate(b, existingBRDPs);
                      return (
                        <tr key={b.id} className={`${duplicate ? styles.duplicateRow : ''} ${excludedIds.includes(b.id) ? styles.excludedRow : ''}`}>
                          <td className={styles.tdCheck}>
                            <input
                              type="checkbox"
                              checked={!excludedIds.includes(b.id)}
                              onChange={() => toggleExclude(b.id)}
                            />
                          </td>
                          <td className={styles.tdId}>{b.id}</td>
                          <td className={styles.tdTitle}>
                            {b.title}
                            {duplicate && (
                              <div className={styles.duplicateInfo}>
                                <span className={styles.duplicateBadge}>duplicate</span>
                                <span className={styles.duplicateOf}>↔ {duplicate.id}: {duplicate.title}</span>
                              </div>
                            )}
                          </td>
                          <td className={styles.tdProposal}>{b.proposal}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Merge mode */}
              <div className={styles.mergeSection}>
                <label className={styles.mergeLabel}>Import mode</label>
                <div className={styles.radioGroup}>
                  <label className={styles.radioLabel}>
                    <input
                      type="radio"
                      value="add"
                      checked={mergeMode === 'add'}
                      onChange={() => setMergeMode('add')}
                    />
                    Add to existing BRDPs
                    <span className={styles.hint}> — keeps current {existingBRDPs.length} records</span>
                  </label>
                  <label className={styles.radioLabel}>
                    <input
                      type="radio"
                      value="replace"
                      checked={mergeMode === 'replace'}
                      onChange={() => setMergeMode('replace')}
                    />
                    Replace all BRDPs
                    <span className={styles.hintWarn}> — current records will be lost</span>
                  </label>
                </div>
              </div>

              {/* Import button */}
              <button className={styles.importBtn} onClick={handleImport}>
                Import {result.brdps.filter(b => !excludedIds.includes(b.id)).length} BRDPs
              </button>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
