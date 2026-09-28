import { useTranslation } from 'react-i18next';
import { summarizeSchemaFactEntry } from '../../utils/schemaFactSummary.js';
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

// One kind (attributes or children) of a multi-variant card.
function KindRows({ kind, mode, common, perVariant, t }) {
  const isAttr = kind === 'attributes';
  const label = isAttr ? 'records.assistant.schemaFactAttributes' : 'records.assistant.schemaFactChildren';
  if (mode === 'none') {
    return (
      <div>
        {t(label)}: {t('records.assistant.schemaFactNone')}
      </div>
    );
  }
  if (mode === 'common') {
    return (
      <div>
        {t(isAttr ? 'records.assistant.schemaFactAttributesCommon' : 'records.assistant.schemaFactChildrenCommon')}:{' '}
        {isAttr ? formatSchemaFactAttributeListUi(common, t) : formatSchemaFactNameListUi(common, false, 0, t)}
      </div>
    );
  }
  return (
    <div>
      <div>{t(isAttr ? 'records.assistant.schemaFactAttributesBySchema' : 'records.assistant.schemaFactChildrenBySchema')}:</div>
      {perVariant.map((pv, idx) => {
        const list = isAttr ? pv.diffAttributes : pv.diffChildren;
        const truncated = isAttr ? pv.attributes_truncated : pv.children_truncated;
        const omitted = isAttr ? pv.attributes_omitted : pv.children_omitted;
        return (
          <div key={idx} className={styles.schemaFactVariant}>
            [{pv.schemas.join(', ')}]:{' '}
            {isAttr
              ? list.length === 0 && truncated
                ? t('records.assistant.schemaFactPartialList', { shown: 0, total: omitted })
                : formatSchemaFactAttributeListUi(list, t) +
                (truncated && list.length > 0
                  ? ` (${t('records.assistant.schemaFactPartialList', { shown: list.length, total: list.length + omitted })})`
                  : '')
              : list.length === 0 && truncated
                ? t('records.assistant.schemaFactPartialList', { shown: 0, total: omitted })
                : formatSchemaFactNameListUi(list, truncated, omitted, t)}
            {!pv.resolved && <span className={styles.vocabWarning}> {t('records.assistant.schemaFactUnresolved')}</span>}
          </div>
        );
      })}
    </div>
  );
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

  // "Fichas sin hijos comunes" round: same three modes as the prompt's
  // kindLines()/variantDiffLines() (src/prompts/shared.js) -- "none" only
  // when no schema has any, per-schema lists (no "additional") when
  // nothing is common, and the header counts schemas, not variant groups.
  const diffs = summary.attributesMode === 'common' || summary.childrenMode === 'common' ? summary.perVariant : [];
  return (
    <div className={styles.referenceDefinition}>
      <div>
        <strong>&lt;{name}&gt;</strong> — {t('records.assistant.schemaFactDefinedIn', { count: summary.schemaCount })}
      </div>
      {summary.anyUnresolved && <div className={styles.vocabWarning}>{t('records.assistant.schemaFactUnresolved')}</div>}
      <KindRows kind="attributes" mode={summary.attributesMode} common={summary.common.attributes} perVariant={summary.perVariant} t={t} />
      <KindRows kind="children" mode={summary.childrenMode} common={summary.common.children} perVariant={summary.perVariant} t={t} />
      <div>
        {t('records.assistant.schemaFactAllowedInside')}: {parentsText}
      </div>
      {diffs.length > 0 && <div className={styles.schemaFactDifferencesHeading}>{t('records.assistant.schemaFactDifferences')}</div>}
      {/* "Pulido de fichas" round, points 2-3 (kept): a variant with
          nothing to add beyond the common set renders no row; a truncated
          one still does, worded without claiming "nothing more" (HR7).
          Only kinds in 'common' mode have a diff here. */}
      {diffs.map((pv, idx) => (
        <div key={idx} className={styles.schemaFactVariant}>
          <div>({t('records.assistant.schemaFactSchemas')}: {pv.schemas.join(', ')})</div>
          {!pv.resolved && <div className={styles.vocabWarning}>{t('records.assistant.schemaFactUnresolved')}</div>}
          {summary.attributesMode === 'common' &&
            (pv.diffAttributes.length > 0 ? (
              <div>
                {t('records.assistant.schemaFactAdditionalAttributes')}:{' '}
                {formatSchemaFactAttributeListUi(pv.diffAttributes, t)}
                {pv.attributes_truncated ? ` (${t('records.assistant.schemaFactPartialDiffNote')})` : ''}
              </div>
            ) : pv.attributes_truncated ? (
              <div>
                {t('records.assistant.schemaFactAdditionalAttributes')}: {t('records.assistant.schemaFactDiffTruncated')}
              </div>
            ) : null)}
          {summary.childrenMode === 'common' &&
            (pv.diffChildren.length > 0 ? (
              <div>
                {t('records.assistant.schemaFactAdditionalChildren')}:{' '}
                {formatSchemaFactNameListUi(pv.diffChildren, false, 0, t)}
                {pv.children_truncated ? ` (${t('records.assistant.schemaFactPartialDiffNote')})` : ''}
              </div>
            ) : pv.children_truncated ? (
              <div>
                {t('records.assistant.schemaFactAdditionalChildren')}: {t('records.assistant.schemaFactDiffTruncated')}
              </div>
            ) : null)}
        </div>
      ))}
    </div>
  );
}
