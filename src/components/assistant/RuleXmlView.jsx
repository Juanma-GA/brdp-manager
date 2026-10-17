import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import styles from '../../pages/RecordsPage.module.css';
import { formatRuleForDisplay } from '../../utils/ruleDisplay.js';

// Read-only view of a rule (Test de reglas, progreso y causas, Part 2.2):
// formatted by default (utils/ruleDisplay.js -- coloured tokens, long
// XPath split, sch:let as "$name := value", a repeated xmlns once), or the
// text exactly as saved. The choice is not remembered. A rule that does not
// parse is shown as saved, with a warning. Copy always copies the saved
// text. Never an editor.
const TOKEN_CLASS = {
  element: 'ruleTokElement',
  attribute: 'ruleTokAttribute',
  value: 'ruleTokValue',
  variable: 'ruleTokVariable',
  string: 'ruleTokString',
  comment: 'ruleTokComment',
  keyword: 'ruleTokKeyword',
};

export default function RuleXmlView({ ruleXml, format, className = '', testId = 'rule-xml-view' }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState('formatted');
  const [copied, setCopied] = useState(null);
  const view = useMemo(() => formatRuleForDisplay(ruleXml, format), [ruleXml, format]);
  const formatted = mode === 'formatted' && view.ok;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(ruleXml || '');
      setCopied('copied');
    } catch {
      setCopied('failed');
    }
  };

  return (
    <div className={styles.ruleXmlView} data-testid={testId} data-mode={formatted ? 'formatted' : 'raw'}>
      <div className={styles.ruleXmlViewBar} role="group" aria-label={t('records.ruleView.label')}>
        <button type="button" aria-pressed={mode === 'formatted'} className={mode === 'formatted' ? styles.viewToggleActive : styles.viewToggle} onClick={() => setMode('formatted')} data-testid={`${testId}-formatted`}>
          {t('records.ruleView.formatted')}
        </button>
        <button type="button" aria-pressed={mode === 'raw'} className={mode === 'raw' ? styles.viewToggleActive : styles.viewToggle} onClick={() => setMode('raw')} data-testid={`${testId}-raw`}>
          {t('records.ruleView.raw')}
        </button>
        <button type="button" className={styles.linkButton} onClick={copy} data-testid={`${testId}-copy`}>
          {copied === 'copied' ? t('records.ruleView.copied') : t('records.ruleView.copy')}
        </button>
        {copied === 'failed' && <span className={styles.muted}>{t('records.ruleView.copyFailed')}</span>}
      </div>
      {mode === 'formatted' && !view.ok && (
        <p className={`${styles.ruleTestNote} ${styles.ruleTestToneWarn}`} data-testid={`${testId}-not-formatted`}>
          {t('records.ruleView.notWellFormed')}
        </p>
      )}
      {formatted ? (
        <div className={`${className} ${styles.ruleXmlFormatted}`} data-testid={`${testId}-content`}>
          {view.sharedNamespaces.map((ns) => (
            <div key={ns.prefix} className={styles.ruleXmlLine}>
              <span className={styles.ruleTokAttribute}>xmlns:{ns.prefix}</span>="<span className={styles.ruleTokValue}>{ns.uri}</span>"{' '}
              <span className={styles.ruleTokComment}>({t('records.ruleView.declaredInEach')})</span>
            </div>
          ))}
          {view.lines.map((line, i) => (
            <div key={i} className={styles.ruleXmlLine} style={{ paddingLeft: `${line.indent * 2}ch` }}>
              {line.tokens.map((tok, j) =>
                TOKEN_CLASS[tok.type] ? (
                  <span key={j} className={styles[TOKEN_CLASS[tok.type]]}>
                    {tok.text}
                  </span>
                ) : (
                  tok.text
                )
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className={className} data-testid={`${testId}-content`}>
          {ruleXml}
        </div>
      )}
    </div>
  );
}
