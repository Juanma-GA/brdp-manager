import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import styles from '../../pages/RecordsPage.module.css';
import { lintWarnings } from '../../utils/ruleLint.js';
import { useSchemaGraph } from '../../hooks/useSchemaGraph.js';

// Barrido final 2/2, Part 2: the warnings that only the lint scripts showed
// (scripts/lint-curated-templates.mjs, backend/scripts/lint_stored_rules.py)
// -- "must not" but allowed, flag 1 with a value filter, count(ancestor::*)
// as depth, a value listed twice, and (outside the Test rule panel, which
// already says it) "cannot reject" -- shown while the rule is worked on.
// Same checks (src/utils/ruleLint.js), one line per problem; never blocking.
// place: 'panel' (Test rule) or 'suggestion' (suggested / pasted rule).
// standard (Remates de Mejoras G, Part 1.2b): its graph says whether the
// schema already requires the attribute of a "mandatory with values" rule.
export default function RuleLintWarnings({ ruleXml, format, place, standard = null }) {
  const { t } = useTranslation();
  const schemaGraph = useSchemaGraph(standard);
  const warnings = useMemo(() => lintWarnings(ruleXml, format, place, t, { schemaGraph }), [ruleXml, format, place, t, schemaGraph]);
  return warnings.map((w) => (
    <p
      key={w.code}
      className={w.amber ? `${styles.ruleTestNote} ${styles.ruleTestToneWarn}` : styles.vocabWarning}
      data-testid="rule-lint-warning"
      data-code={w.code}
    >
      ⚠ {w.title}: {w.detail}
    </p>
  ));
}
