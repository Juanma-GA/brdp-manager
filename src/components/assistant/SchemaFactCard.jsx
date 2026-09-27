import { useTranslation } from 'react-i18next';
import { summarizeSchemaFactEntry } from '../../utils/vocabularyCheck.js';
import styles from '../../pages/RecordsPage.module.css';

// Docs request ("Servicio de fichas de esquema y su uso en Ask"): renders
// one expanded schema-fact card -- exactly the same data
// buildSchemaFactsBlock (src/prompts/shared.js) formatted into the prompt
// (the entry object is used as-is, never reformatted a second, possibly-
// diverging way).
// "Did you mean con marcado a medias y listas de padres cortadas" round,
// Part 2: the UI card shows the same "partial list" wording as the prompt
// (src/prompts/shared.js's truncationMarker) -- one exact, verifiable
// total wherever shown+omitted genuinely adds up to it, never a bare
// "+N" fragment.
function formatSchemaFactAttributeUi(attr, t) {
  let text = attr.required ? `@${attr.name} (${t('records.assistant.schemaFactRequired')})` : `@${attr.name}`;
  if (attr.enum && attr.enum.length > 0) {
    text += ` [${attr.enum.join(' | ')}]`;
    if (attr.enum_truncated) {
      text += ` (${t('records.assistant.schemaFactPartialList', { shown: attr.enum.length, total: attr.enum.length + attr.enum_omitted })})`;
    }
  }
  return text;
}

function formatSchemaFactNameListUi(names, truncated, omitted, t) {
  if (!names || names.length === 0) return t('records.assistant.schemaFactNone');
  const list = names.join(', ');
  if (!truncated) return list;
  return `${list} (${t('records.assistant.schemaFactPartialList', { shown: names.length, total: names.length + omitted })})`;
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
            ? formatSchemaFactAttributeListUi(v.attributes, t) +
              (v.attributes_truncated
                ? ` (${t('records.assistant.schemaFactPartialList', { shown: v.attributes.length, total: v.attributes.length + v.attributes_omitted })})`
                : '')
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
      {/* "Pulido de fichas" round, points 2-3: a variant with nothing to
          add beyond the common set no longer renders an "attributes:
          none beyond the common set" / "children: none beyond the common
          set" row at all -- pure noise for the common case where a
          variant differs in at most one of the two. A variant whose raw
          list was itself truncated still gets a row (a real difference
          could be hiding past the cutoff, so silence would overclaim
          completeness -- HR7), reworded away from "none beyond the
          common set" since that phrase implied certainty the truncation
          doesn't have. Labels renamed to "additional attributes"/
          "additional children" (clearer than the bare "attributes"/
          "children" this diff section used to share with the common-set
          block above, which reads like a full list, not a diff). No
          "additional parents" here -- parents has no per-variant diff at
          all (summarizeSchemaFactEntry never splits it), same as the
          prompt's buildSchemaFactsBlock. */}
      {summary.perVariant.map((pv, idx) => (
        <div key={idx} className={styles.schemaFactVariant}>
          <div>({t('records.assistant.schemaFactSchemas')}: {pv.schemas.join(', ')})</div>
          {!pv.resolved && <div className={styles.vocabWarning}>{t('records.assistant.schemaFactUnresolved')}</div>}
          {pv.diffAttributes.length > 0 ? (
            <div>
              {t('records.assistant.schemaFactAdditionalAttributes')}:{' '}
              {formatSchemaFactAttributeListUi(pv.diffAttributes, t)}
              {pv.attributes_truncated ? ` (${t('records.assistant.schemaFactPartialDiffNote')})` : ''}
            </div>
          ) : pv.attributes_truncated ? (
            <div>
              {t('records.assistant.schemaFactAdditionalAttributes')}:{' '}
              {t('records.assistant.schemaFactDiffTruncated')}
            </div>
          ) : null}
          {pv.diffChildren.length > 0 ? (
            <div>
              {t('records.assistant.schemaFactAdditionalChildren')}:{' '}
              {formatSchemaFactNameListUi(pv.diffChildren, false, 0, t)}
              {pv.children_truncated ? ` (${t('records.assistant.schemaFactPartialDiffNote')})` : ''}
            </div>
          ) : pv.children_truncated ? (
            <div>
              {t('records.assistant.schemaFactAdditionalChildren')}:{' '}
              {t('records.assistant.schemaFactDiffTruncated')}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
