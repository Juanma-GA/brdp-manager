// AI Extract (2/2): "Import from text or document" -- a box to paste text
// and a button to attach a .txt, .md, .docx or .pdf (read in the browser:
// src/utils/documentText.js). The words are counted by code before any AI
// call (the server counts them again); over the limit the text is
// rejected, never cut. onSubmit(text, filename) starts the extraction
// (filename "" for a pasted text).
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Button from '../Button';
import { DOCUMENT_EXTENSIONS, readDocumentText } from '../../utils/documentText.js';
import { countWords, formatCount } from '../../utils/textExtract.js';
import pageStyles from '../../pages/ProjectConfigPage.module.css';
import styles from './RuleExtractSection.module.css';

export default function TextExtractInput({ maxWords, disabledReason, busy, onSubmit }) {
  const { t, i18n } = useTranslation();
  const [text, setText] = useState('');
  const [filename, setFilename] = useState('');
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState(null);
  const fileRef = useRef(null);
  const words = countWords(text);
  const tooLong = maxWords != null && words > maxWords;
  const n = (v) => formatCount(v, i18n.language);

  const attach = async (file) => {
    setReadError(null);
    setReading(true);
    try {
      const content = await readDocumentText(file);
      setText(content);
      setFilename(file.name);
    } catch (err) {
      setReadError(
        err.code === 'unsupported'
          ? t(err.detail === '.doc' ? 'config.ruleExtract.text.readDoc' : 'config.ruleExtract.text.readUnsupported', { ext: err.detail || file.name })
          : err.code === 'pdf_no_text'
          ? t('config.ruleExtract.text.readPdfNoText')
          : err.code === 'pdf_password'
          ? t('config.ruleExtract.text.readPdfPassword')
          : t('config.ruleExtract.text.readUnreadable', { reason: err.detail || err.message })
      );
    } finally {
      setReading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const clear = () => {
    setText('');
    setFilename('');
    setReadError(null);
  };

  const blocked = disabledReason || busy || reading;
  return (
    <div className={styles.textInput} data-testid="text-extract">
      <h3 className={pageStyles.subsectionHeading}>{t('config.ruleExtract.text.title')}</h3>
      {disabledReason && (
        <p className={pageStyles.hint} data-testid="text-extract-disabled">
          {disabledReason}
        </p>
      )}
      <textarea
        className={styles.textBox}
        rows={8}
        value={text}
        disabled={!!blocked}
        onChange={(e) => setText(e.target.value)}
        placeholder={t('config.ruleExtract.text.placeholder')}
        aria-label={t('config.ruleExtract.text.placeholder')}
        data-testid="text-extract-box"
      />
      <div className={styles.textBar}>
        <label className={`${pageStyles.secondaryButton} ${blocked ? styles.disabledLabel : ''}`}>
          {t('config.ruleExtract.text.attach')}
          <input
            ref={fileRef}
            type="file"
            accept={DOCUMENT_EXTENSIONS.join(',')}
            hidden
            disabled={!!blocked}
            data-testid="text-extract-file"
            onChange={(e) => e.target.files?.[0] && attach(e.target.files[0])}
          />
        </label>
        {reading && (
          <span className={pageStyles.hint}>
            <span className={pageStyles.spinner} aria-hidden="true" />
            {t('config.ruleExtract.text.reading')}
          </span>
        )}
        {filename && (
          <span className={styles.muted} data-testid="text-extract-filename">
            {t('config.ruleExtract.text.fromFile', { file: filename })}
          </span>
        )}
        {(text || filename) && !busy && (
          <button type="button" className={styles.linkButton} onClick={clear} data-testid="text-extract-clear">
            {t('config.ruleExtract.text.clear')}
          </button>
        )}
        <span className={`${styles.wordCount} ${tooLong ? styles.wordCountOver : ''}`} data-testid="text-extract-count">
          {t('config.ruleExtract.text.wordCount', { count: words, words: n(words), max: maxWords != null ? n(maxWords) : '…' })}
        </span>
      </div>
      <p className={pageStyles.hint}>{t('config.ruleExtract.text.hint', { max: maxWords != null ? n(maxWords) : '…' })}</p>
      {tooLong && (
        <>
          <ul className={pageStyles.errorList} data-testid="text-extract-too-long">
            <li>{t('config.ruleExtract.text.tooLong', { words: n(words), max: n(maxWords) })}</li>
          </ul>
          {/* Why there is a limit: only next to the message that it was passed. */}
          <p className={styles.textHelp} data-testid="text-extract-why-limit">
            <strong>{t('config.ruleExtract.text.whyLimit')}</strong> {t('config.ruleExtract.text.whyLimitText')}
          </p>
        </>
      )}
      {readError && (
        <ul className={pageStyles.errorList} data-testid="text-extract-read-error">
          <li>{readError}</li>
        </ul>
      )}
      <Button
        onClick={() => onSubmit(text, filename)}
        busy={busy}
        busyLabel={t('config.ruleExtract.text.finding')}
        disabled={!!blocked || !text.trim() || tooLong || maxWords == null}
        data-testid="text-extract-submit"
      >
        {t('config.ruleExtract.text.submit')}
      </Button>
    </div>
  );
}
