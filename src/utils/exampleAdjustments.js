// La revisión sabe qué ajustó la app: the notes the rule test panel shows
// under an example about what the APPLICATION changed in it (a container
// around loose content, colspecs, morerows, required attributes, values, a
// relocation, the identification section, the topic's title…), as plain
// text -- the same i18n keys and the same values as the panel
// (RuleTestPanel.jsx's DocumentFixNotes and the notes around it), so the
// "Review with the assistant" prompt (called with the English `t`) carries
// exactly what the user sees. A dossier example also gets each file's
// notes, prefixed with the file's path.
import { sectionValuesLabel } from './ownSectionValues.js';

const listOf = (names, t) =>
  names.length > 1 ? `${names.slice(0, -1).join(', ')} ${t('records.assistant.listAnd')} ${names[names.length - 1]}` : names[0];

// One document's own fixes (the content, or one file of a dossier).
function documentNotes(doc, t) {
  const out = [];
  if (doc.relocated?.length) {
    out.push(t('records.ruleTest.relocated', { moves: doc.relocated.map((m) => `<${m.element}> → ${m.path.slice(0, -1).join('/')}`).join('; ') }));
  }
  if (doc.namespacesRemoved?.length) out.push(t('records.ruleTest.namespaceRemoved', { namespace: doc.namespacesRemoved.join('", "') }));
  for (const l of doc.nestedLifted || []) {
    out.push(t('records.ruleTest.nestedTopicLifted', { element: `<${l.element}>`, body: `<${l.body}>`, parent: `<${l.parent}>` }));
  }
  for (const w of doc.wrapped || []) {
    out.push(
      t('records.ruleTest.wrappedLoose', {
        count: w.elements.length,
        elements: listOf(w.elements.map((n) => `<${n}>`), t),
        container: `<${w.container}>`,
        parent: `<${w.parent}>`,
      })
    );
  }
  if (doc.colspecsAdded > 0) out.push(t('records.ruleTest.colspecsAdded', { count: doc.colspecsAdded }));
  const added = doc.requiredAttributesAdded || [];
  const count = added.reduce((n, g) => n + g.attributes.length, 0);
  if (count > 0) {
    out.push(
      t('records.ruleTest.requiredAttributesAdded', {
        count,
        items: added.map((g) => t('records.ruleTest.schemaFixItem', { attributes: g.attributes.map((a) => `@${a}`).join(', '), element: g.element })).join('; '),
      })
    );
  }
  if (doc.textRemoved?.length) out.push(t('records.ruleTest.textRemoved', { elements: doc.textRemoved.map((e) => `<${e}>`).join(', ') }));
  const values = [];
  for (const v of doc.valuesReplaced || []) {
    if (!values.some((w) => w.attribute === v.attribute && w.from === v.from && w.to === v.to)) values.push(v);
  }
  if (values.length) {
    out.push(t('records.ruleTest.valuesReplaced', { count: values.length, items: values.map((v) => t('records.ruleTest.valueReplacedItem', v)).join('; ') }));
  }
  if (doc.spannedEntriesRemoved?.length) {
    const distinct = [...new Set(doc.spannedEntriesRemoved)].sort((a, b) => a - b);
    const key = distinct.length === 1 ? 'spannedEntriesRemovedRow' : 'spannedEntriesRemovedRows';
    out.push(t(`records.ruleTest.${key}`, { count: doc.spannedEntriesRemoved.length, rows: distinct.join(', ') }));
  }
  if (doc.colsRaised?.length) out.push(t('records.ruleTest.colsRaised', { count: doc.colsRaised.length, values: doc.colsRaised.map((c) => `${c.from} → ${c.to}`).join(', ') }));
  if (doc.morerowsLowered?.length) out.push(t('records.ruleTest.morerowsLowered', { count: doc.morerowsLowered.length, rows: [...new Set(doc.morerowsLowered)].join(', ') }));
  if (doc.emptyRowsRemoved?.length) out.push(t('records.ruleTest.emptyRowsRemoved', { count: doc.emptyRowsRemoved.length, rows: doc.emptyRowsRemoved.join(', ') }));
  if (doc.topicTitleSet) out.push(t('records.ruleTest.topicTitleSet', { title: doc.topicTitleSet }));
  return out;
}

// → [text] -- empty when the application changed nothing.
export function exampleAdjustmentNotes(example, t) {
  if (!example) return [];
  const out = documentNotes(example, t);
  if (example.sectionBuilt?.length) out.push(t('records.ruleTest.sectionBuilt', { values: sectionValuesLabel(example.sectionBuilt) }));
  if (example.sectionValuesSet?.length) out.push(t('records.ruleTest.sectionValuesSet', { values: sectionValuesLabel(example.sectionValuesSet) }));
  if (example.brexReferenceNormalized) out.push(t('records.ruleTest.brexReferenceNormalized'));
  if (example.brexModelIdentFollowed) out.push(t('records.ruleTest.brexModelIdentFollowed'));
  for (const f of example.files || []) {
    for (const note of documentNotes(f, t)) out.push(`${f.path}: ${note}`);
  }
  return out;
}
