import { useTranslation } from 'react-i18next';
import { formatSchemaIssue, schemaIssueKey } from '../../validation/schemaValidation.js';
import styles from '../../pages/RecordsPage.module.css';

// The red warning lines of the schema validation service -- one <p> per
// issue, in the interface language. `testIds` (optional) maps an issue code
// to a data-testid.
export default function SchemaIssueLines({ issues, testIds = {} }) {
  const { t } = useTranslation();
  return issues.map((issue) => (
    <p key={schemaIssueKey(issue)} className={styles.vocabWarning} data-testid={testIds[issue.code]}>
      ⚠ {formatSchemaIssue(issue, t)}
    </p>
  ));
}
