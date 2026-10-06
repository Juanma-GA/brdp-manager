import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import styles from '../../pages/RecordsPage.module.css';
import { useSchemaGraph } from '../../hooks/useSchemaGraph.js';
import { applyRulePathFix, checkRulePaths, formatPathFix, formatPathProblem } from '../../validation/rulePathCheck.js';

// Mejoras C, Part 1: amber, never blocking -- a path of the rule that the
// standard's schemas never allow ("The path cannot exist: <trade> does not
// go inside <perscat>; it goes inside <reqpers>", "<techstd> is never the
// root of a document; it goes in dmodule/idstatus/status"). With exactly one
// mechanical fix, a button applies it to the text the caller owns
// (`onApplyFix(fixedXml)`); never on its own. Without `onApplyFix` (the rule
// test panel), only the warnings. Without the standard's graph, nothing.
//   ruleXml   what is checked (a pasted rule as it will be saved)
//   fixXml    the text the fix is applied to (default: ruleXml) -- the
//             pasted text, for a pasted rule wrapped in context blocks
export default function RulePathWarnings({ ruleXml, fixXml = null, format, standard, schemaLocation = null, onApplyFix = null, testId = 'rule-path-warning' }) {
  const { t } = useTranslation();
  const graph = useSchemaGraph(standard);
  const [note, setNote] = useState(null); // { text, xml } -- shown while the text is the fixed one
  const check = useMemo(() => {
    if (!graph || !ruleXml || !format) return null;
    try {
      return checkRulePaths(ruleXml, format, graph, { schemaLocation });
    } catch {
      return null;
    }
  }, [graph, ruleXml, format, schemaLocation]);
  const problems = check?.problems || [];
  const shownNote = note && note.xml === (fixXml ?? ruleXml) ? note.text : null;
  if (problems.length === 0 && !shownNote) return null;
  const apply = (fix) => {
    const source = fixXml ?? ruleXml;
    const { xml, changed } = applyRulePathFix(source, fix);
    if (!changed) return;
    setNote({ xml, text: t('records.rulePath.fixed', { from: fix.from, to: fix.to }) });
    onApplyFix(xml);
  };
  return (
    <>
      {problems.map((p, i) => (
        <div key={`${p.ruleId}|${p.kind}|${p.element}|${p.parent}|${p.attribute}|${i}`} className={`${styles.ruleTestNote} ${styles.ruleTestToneWarn}`} data-testid={testId} data-kind={p.kind}>
          ⚠ {formatPathProblem(p, t, { format })}
          {onApplyFix && p.fix && (
            <>
              {' '}
              <button type="button" className={styles.linkButton} data-testid={`${testId}-fix`} onClick={() => apply(p.fix)}>
                {formatPathFix(p.fix, t)}
              </button>
            </>
          )}
        </div>
      ))}
      {shownNote && (
        <p className={styles.hint} data-testid={`${testId}-fixed`}>
          {shownNote}
        </p>
      )}
    </>
  );
}
