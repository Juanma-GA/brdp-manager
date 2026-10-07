import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import styles from '../../pages/RecordsPage.module.css';
import { useSchemaGraphState } from '../../hooks/useSchemaGraph.js';
import { minimalDocumentRuns, newlyRejectedMinimalDocuments } from '../../utils/ruleMinimalDocuments.js';

const NEWLY_SHOWN = 5;

// Mejoras F, Part 1.1: the rule run on the document the application builds
// for each schema of the standard with nothing written for the test
// (utils/ruleMinimalDocuments.js), by code. Information, never a verdict:
//   - the schemas whose minimal document the rule already rejects (grey
//     line), under "What the rule checks" and under a suggested, corrected
//     or pasted rule;
//   - previousRuleXml (a corrected rule): the minimal documents the new rule
//     rejects and the previous one accepted -- in red, Accept stays enabled.
// The graph (with the skeletons) is loaded once per standard; when it could
// not be loaded, the line says so.
export default function MinimalDocumentsLine({ ruleXml, format, standard, schemaLocation = null, previousRuleXml = null, testId = 'rule-minimal-documents' }) {
  const { t } = useTranslation();
  const { graph, failed } = useSchemaGraphState(standard);
  const runs = useMemo(() => {
    if (!graph || !ruleXml) return null;
    try {
      return minimalDocumentRuns(ruleXml, format, graph, { standard, schemaLocation });
    } catch {
      return null;
    }
  }, [graph, ruleXml, format, standard, schemaLocation]);
  const previous = useMemo(() => {
    if (!graph || !previousRuleXml) return null;
    try {
      return minimalDocumentRuns(previousRuleXml, format, graph, { standard, schemaLocation });
    } catch {
      return null;
    }
  }, [graph, previousRuleXml, format, standard, schemaLocation]);
  if (failed) {
    return (
      <p className={styles.muted} data-testid={`${testId}-unavailable`}>
        {t('records.ruleTest.minimalUnavailable')}
      </p>
    );
  }
  if (!runs?.available) return null;
  const newly = newlyRejectedMinimalDocuments(previous, runs);
  return (
    <>
      {newly.length > 0 && (
        <p className={styles.vocabWarning} data-testid={`${testId}-newly-rejected`}>
          ⚠ {t('records.ruleTest.minimalNewlyRejected', {
            count: newly.length,
            // Mejoras G, Part 2.4 b: up to 5 types named, then "and N more".
            schemas: newly.slice(0, NEWLY_SHOWN).join(', ') + (newly.length > NEWLY_SHOWN ? t('records.ruleTest.rejectedMore', { count: newly.length - NEWLY_SHOWN }) : ''),
          })}
        </p>
      )}
      {runs.rejected.length > 0 && (
        <p className={styles.muted} data-testid={testId}>
          {t('records.ruleTest.minimalRejects', { schemas: runs.rejected.join(', '), count: runs.rejected.length, total: runs.counted })}
        </p>
      )}
    </>
  );
}
