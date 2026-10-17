import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import styles from '../../pages/RecordsPage.module.css';

// Suggest Rule part 2, Part 3: the inline schema choice shown before
// generating an S1000D rule. Mentioned schemas come pre-checked; a schema
// where an element of the BRDP text doesn't exist is disabled with the
// reason. Generate with nothing checked = a general rule.
export default function RuleSchemaSelector({ selector, onGenerate, onCancel }) {
  const { t } = useTranslation();
  const [checked, setChecked] = useState(
    () => new Set(selector.variants.filter((v) => v.preChecked).map((v) => v.schema))
  );

  const toggle = (schema) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(schema)) next.delete(schema);
      else next.add(schema);
      return next;
    });

  // Enabled schemas first, each group in the standard's own order.
  const ordered = [...selector.variants.filter((v) => !v.disabled), ...selector.variants.filter((v) => v.disabled)];
  const chosen = selector.variants.filter((v) => checked.has(v.schema)).map((v) => v.schema);

  return (
    <div className={styles.suggestionBox} data-testid="rule-schema-selector">
      <h4 className={styles.referencesGroupTitle}>{t('records.assistant.schemaSelectorTitle')}</h4>
      <p className={styles.hint}>{t('records.assistant.schemaSelectorHint')}</p>
      {selector.mentioned.length > 0 && (
        <p className={styles.hint}>
          {t('records.assistant.schemaSelectorMentioned', { schemas: selector.mentioned.join(', ') })}
        </p>
      )}
      <div className={styles.schemaSelectorList}>
        {ordered.map((v) => {
          const reason = v.disabled
            ? t('records.assistant.schemaSelectorMissing', { names: v.missing.map((n) => `<${n}>`).join(', ') })
            : undefined;
          return (
            <label
              key={v.schema}
              className={`${styles.schemaOption}${v.disabled ? ` ${styles.schemaOptionDisabled}` : ''}`}
              title={reason}
            >
              <input
                type="checkbox"
                value={v.schema}
                checked={checked.has(v.schema)}
                disabled={v.disabled}
                onChange={() => toggle(v.schema)}
              />
              <span>
                <code>{v.schema}</code> — {t(`records.assistant.schemaLabels.${v.schema}`, { defaultValue: v.schema })}
                {reason && <span className={styles.schemaOptionReason}> ({reason})</span>}
              </span>
            </label>
          );
        })}
      </div>
      <div className={styles.suggestionActions}>
        <button onClick={() => onGenerate(chosen)}>
          {t('records.assistant.schemaSelectorGenerate')}
        </button>
        <button onClick={onCancel}>{t('records.assistant.schemaSelectorCancel')}</button>
      </div>
    </div>
  );
}
