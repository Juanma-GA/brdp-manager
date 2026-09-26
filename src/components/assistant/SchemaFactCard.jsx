import { useTranslation } from 'react-i18next';
import { summarizeSchemaFactEntry } from '../../utils/vocabularyCheck.js';
import styles from '../../pages/RecordsPage.module.css';

// Docs request ("Servicio de fichas de esquema y su uso en Ask"): renders
// one expanded schema-fact card -- exactly the same data
// buildSchemaFactsBlock (src/prompts/shared.js) formatted into the prompt
// (the entry object is used as-is, never reformatted a second, possibly-
// diverging way).
function formatSchemaFactAttributeUi(attr, t) {
  let text = attr.required ? `@${attr.name} (${t('records.assistant.schemaFactRequired')})` : `@${attr.name}`;
  if (attr.enum && attr.enum.length > 0) {
    const values = attr.enum.join(' | ') + (attr.enum_truncated ? `, +${attr.enum_omitted}` : '');
    text += ` [${values}]`;
  }
  return text;
}

function formatSchemaFactNameListUi(names, truncated, omitted, t) {
  if (!names || names.length === 0) return t('records.assistant.schemaFactNone');
  return names.join(', ') + (truncated ? `, +${omitted}` : '');
}

function formatSchemaFactAttributeListUi(attrs, t) {
  if (!attrs || attrs.length === 0) return t('records.assistant.schemaFactNone');
  return attrs.map((a) => formatSchemaFactAttributeUi(a, t)).join(', ');
}

// Ask-with-schema-cards follow-up round, point 4: same common/per-variant-
// diff split as buildSchemaFactsBlock, rendered as the UI's expandable
// card -- both consume summarizeSchemaFactEntry so the prompt the LLM
// sees and the card the user can expand never drift apart.
export default function SchemaFactCard({ name, entry }) {
  const { t } = useTranslation();
  const summary = summarizeSchemaFactEntry(entry);
  const parentsText = formatSchemaFactNameListUi(entry.parents, entry.parents_truncated, entry.parents_omitted, t);

  if (!summary.common) {
    const v = entry.variants[0];
    return (
      <div className={styles.referenceDefinition}>
        <div>
          <strong>&lt;{name}&gt;</strong> ({t('records.assistant.schemaFactSchemas')}: {v.schemas.join(', ')})
        </div>
        {!v.resolved && <div className={styles.vocabWarning}>{t('records.assistant.schemaFactUnresolved')}</div>}
        <div>
          {t('records.assistant.schemaFactAttributes')}:{' '}
          {v.attributes.length > 0
            ? formatSchemaFactAttributeListUi(v.attributes, t) + (v.attributes_truncated ? `, +${v.attributes_omitted}` : '')
            : t('records.assistant.schemaFactNone')}
        </div>
        <div>
          {t('records.assistant.schemaFactChildren')}:{' '}
          {formatSchemaFactNameListUi(v.children, v.children_truncated, v.children_omitted, t)}
        </div>
        <div>
          {t('records.assistant.schemaFactAllowedInside')}: {parentsText}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.referenceDefinition}>
      <div>
        <strong>&lt;{name}&gt;</strong> — {t('records.assistant.schemaFactCommonToAll', { count: entry.variants.length })}
      </div>
      {summary.anyUnresolved && <div className={styles.vocabWarning}>{t('records.assistant.schemaFactUnresolved')}</div>}
      <div>
        {t('records.assistant.schemaFactAttributes')}: {formatSchemaFactAttributeListUi(summary.common.attributes, t)}
      </div>
      <div>
        {t('records.assistant.schemaFactChildren')}: {formatSchemaFactNameListUi(summary.common.children, false, 0, t)}
      </div>
      <div>
        {t('records.assistant.schemaFactAllowedInside')}: {parentsText}
      </div>
      <div className={styles.schemaFactDifferencesHeading}>{t('records.assistant.schemaFactDifferences')}</div>
      {summary.perVariant.map((pv, idx) => (
        <div key={idx} className={styles.schemaFactVariant}>
          <div>({t('records.assistant.schemaFactSchemas')}: {pv.schemas.join(', ')})</div>
          {!pv.resolved && <div className={styles.vocabWarning}>{t('records.assistant.schemaFactUnresolved')}</div>}
          <div>
            {t('records.assistant.schemaFactAttributes')}:{' '}
            {pv.diffAttributes.length > 0
              ? formatSchemaFactAttributeListUi(pv.diffAttributes, t) + (pv.attributes_truncated ? `, +${pv.attributes_omitted}` : '')
              : t('records.assistant.schemaFactNoneBeyondCommon')}
          </div>
          <div>
            {t('records.assistant.schemaFactChildren')}:{' '}
            {pv.diffChildren.length > 0
              ? formatSchemaFactNameListUi(pv.diffChildren, pv.children_truncated, pv.children_omitted, t)
              : t('records.assistant.schemaFactNoneBeyondCommon')}
          </div>
        </div>
      ))}
    </div>
  );
}
