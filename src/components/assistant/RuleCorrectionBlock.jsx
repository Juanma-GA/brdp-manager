import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import styles from '../../pages/RecordsPage.module.css';
import compareStyles from '../compare/BrdpCompareDialog.module.css';
import { diffRuleLines, diffText, foldEqualRows, normalizeRuleXml } from '../../utils/brdpCompare.js';
import { formatRuleDefect, formatRuleFix } from '../../validation/ruleCorrection.js';

// Corrección propuesta, Part 1: next to the SAVED rule (never in the
// editor), what code found wrong with it --
//   a correction: the reasons in one sentence each, the rule before and
//     after with what changes marked, Accept / Discard (editor only);
//   no mechanical fix: "Defect detected", the reasons, and access to
//     Suggest Rule (the app never calls the AI on its own);
//   a discarded correction: a discreet line, the correction still visible
//     on request.
// `entry`: { result: { defects, proposal }, clashes, dismissed }.

function Segments({ segments, side }) {
  return segments.map((s, i) =>
    s.changed ? (
      <mark key={i} className={side === 'left' ? compareStyles.removed : compareStyles.added}>
        {s.text}
      </mark>
    ) : (
      <span key={i}>{s.text}</span>
    )
  );
}

function RuleDiff({ before, after }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(new Set());
  const rows = useMemo(() => {
    const left = normalizeRuleXml(before).text;
    const right = normalizeRuleXml(after).text;
    return foldEqualRows(diffRuleLines(left, right));
  }, [before, after]);
  const out = [];
  rows.forEach((row, i) => {
    if (row.kind === 'fold' && !open.has(i)) {
      out.push(
        <div key={`f${i}`} className={compareStyles.foldRow}>
          <button type="button" className={styles.linkButton} onClick={() => setOpen((p) => new Set(p).add(i))}>
            {t('records.compare.showEqualLines', { count: row.rows.length })}
          </button>
        </div>
      );
      return;
    }
    (row.kind === 'fold' ? row.rows : [row]).forEach((r, j) => {
      const words = r.kind === 'changed' ? diffText(r.left, r.right) : null;
      out.push(
        <div key={`${i}-${j}`} className={compareStyles.lineRow} data-kind={r.kind} data-testid="rule-correction-line">
          <pre className={`${compareStyles.line} ${r.kind === 'removed' || r.kind === 'changed' ? compareStyles.lineRemoved : r.kind === 'added' ? compareStyles.lineBlank : ''}`}>
            {words ? <Segments segments={words.left} side="left" /> : (r.left ?? '')}
          </pre>
          <pre className={`${compareStyles.line} ${r.kind === 'added' || r.kind === 'changed' ? compareStyles.lineAdded : r.kind === 'removed' ? compareStyles.lineBlank : ''}`}>
            {words ? <Segments segments={words.right} side="right" /> : (r.right ?? '')}
          </pre>
        </div>
      );
    });
  });
  return (
    <div>
      <div className={compareStyles.lineRow}>
        <strong className={styles.hint}>{t('records.ruleCorrection.before')}</strong>
        <strong className={styles.hint}>{t('records.ruleCorrection.after')}</strong>
      </div>
      <div className={compareStyles.lines}>{out}</div>
    </div>
  );
}

function DefectList({ defects, format, testId }) {
  const { t } = useTranslation();
  return (
    <ul className={styles.ruleCorrectionList} data-testid={testId}>
      {defects.map((d) => (
        <li key={d.key}>
          {formatRuleDefect(d, t, { format })}
          {d.fix && testId === 'rule-correction-fixed' ? <> → {formatRuleFix(d.fix, t)}</> : null}
        </li>
      ))}
    </ul>
  );
}

export default function RuleCorrectionBlock({ entry, ruleXml, format, canEdit, busy, error, onAccept, onDismiss, onSuggestRule, suggestRuleBlockedReason }) {
  const { t } = useTranslation();
  const [showDismissed, setShowDismissed] = useState(false);
  if (!entry) return null;
  const defects = [...(entry.result?.defects || []), ...(entry.clashes || [])];
  if (defects.length === 0) return null;
  const proposal = entry.result?.proposal || null;
  // Project-level defects (an id shared with another BRDP) are never fixed
  // by the correction: they stay in "still to fix".
  const remaining = proposal ? [...proposal.remaining, ...(entry.clashes || [])] : [];

  if (proposal && entry.dismissed && !showDismissed) {
    return (
      <div className={`${styles.ruleTestNote} ${styles.ruleTestToneWarn}`} data-testid="rule-correction-dismissed">
        {t('records.ruleCorrection.dismissed')} {defects.map((d) => formatRuleDefect(d, t, { format })).join(' ')}{' '}
        <button type="button" className={styles.linkButton} onClick={() => setShowDismissed(true)}>
          {t('records.ruleCorrection.showProposal')}
        </button>
      </div>
    );
  }

  if (proposal) {
    return (
      <div className={styles.ruleCorrectionBox} data-testid="rule-correction">
        <strong>{t('records.ruleCorrection.title')}</strong>
        <p className={styles.hint}>{t('records.ruleCorrection.intro')}</p>
        <p className={styles.ruleCorrectionHeading}>{t('records.ruleCorrection.fixedHeading')}</p>
        <DefectList defects={proposal.fixes} format={format} testId="rule-correction-fixed" />
        {remaining.length > 0 && (
          <>
            <p className={styles.ruleCorrectionHeading}>{t('records.ruleCorrection.remainingHeading')}</p>
            <DefectList defects={remaining} format={format} testId="rule-correction-remaining" />
          </>
        )}
        <RuleDiff before={ruleXml} after={proposal.xml} />
        {error && (
          <p className={styles.ruleErrorText} role="alert" data-testid="rule-correction-error">
            {error}
          </p>
        )}
        {canEdit ? (
          <div className={styles.suggestionActions}>
            <button type="button" onClick={onAccept} disabled={busy} data-testid="rule-correction-accept">
              {busy ? t('records.ruleCorrection.accepting') : t('records.ruleCorrection.accept')}
            </button>
            {!entry.dismissed && (
              <button type="button" onClick={onDismiss} disabled={busy} data-testid="rule-correction-discard">
                {t('records.ruleCorrection.discard')}
              </button>
            )}
          </div>
        ) : (
          <p className={styles.hint} data-testid="rule-correction-viewer">
            {t('records.ruleCorrection.viewerNote')}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className={styles.ruleCorrectionBox} data-testid="rule-defect">
      <strong>{t('records.ruleCorrection.defectTitle')}</strong>
      <DefectList defects={defects} format={format} testId="rule-defect-list" />
      <p className={styles.hint}>{t('records.ruleCorrection.noFixHint')}</p>
      {canEdit && onSuggestRule && (
        <button
          type="button"
          className={styles.linkButton}
          onClick={onSuggestRule}
          disabled={Boolean(suggestRuleBlockedReason)}
          title={suggestRuleBlockedReason || undefined}
          data-testid="rule-defect-suggest-rule"
        >
          {t('records.ruleCorrection.suggestRule')}
        </button>
      )}
    </div>
  );
}
