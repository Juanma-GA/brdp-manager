// AI Extract review table: the "Show" filter options and the i18n key of
// each label. Pure, so scripts/test-rule-extract.mjs can check that every
// option has its text in both languages.
//   - all / warnings / blocking: config.ruleExtract.filters.*
//   - a classification: config.ruleExtract.classes.* (groupClassLabel adds
//     the specification / edition when every row of it shares one, and
//     uses config.ruleExtract.classesGeneric.* otherwise).
const EXTRACT_CLASSES = [
  'new_ext', 'catalog', 'catalog_edition', 'other_spec', 'default_rule', 'changed', 'same', 'empty',
];
export const EXTRACT_FILTERS = ['all', ...EXTRACT_CLASSES, 'warnings', 'blocking'];
const NON_CLASS_FILTERS = new Set(['all', 'warnings', 'blocking']);

export function isClassFilter(filter) {
  return !NON_CLASS_FILTERS.has(filter);
}

export function filterLabelKey(filter) {
  return isClassFilter(filter) ? `config.ruleExtract.classes.${filter}` : `config.ruleExtract.filters.${filter}`;
}

// One candidate's classification name (with its specification / edition).
export function classLabel(t, c, classification = c.classification, textJob = false) {
  // A free text never brings a rule: an identifier of the project is just
  // "Already exists".
  if (textJob && classification === 'same') return t('config.ruleExtract.classes.exists');
  if (classification === 'other_spec' || classification === 'default_rule') {
    return t(`config.ruleExtract.classes.${classification}`, { spec: c.specification || '' });
  }
  if (classification === 'catalog_edition') {
    return t(`config.ruleExtract.classes.${classification}`, { edition: c.catalog_edition || '' });
  }
  return t(`config.ruleExtract.classes.${classification}`);
}

// A classification's name for the filter and the counts. Remates B,
// Part 2: always distinguishable from the others -- with its specification
// / edition when every row of it shares one ("From catalog (S1000D 4.1)"),
// and a generic name of its own otherwise (no rows, or rows of several
// editions / specifications: "From catalog (another edition)"), never the
// bare "From catalog" of the project's own catalog.
const GROUP_FIELD = { catalog_edition: 'catalog_edition', other_spec: 'specification', default_rule: 'specification' };
export function groupClassLabel(t, candidates, k, textJob = false) {
  const field = GROUP_FIELD[k];
  if (!field) return classLabel(t, {}, k, textJob);
  const values = [
    ...new Set(
      candidates
        .filter((c) => c.classification === k || c.options?.includes(k))
        .map((c) => c[field])
        .filter(Boolean)
    ),
  ];
  if (values.length !== 1) return t(`config.ruleExtract.classesGeneric.${k}`);
  return classLabel(t, { [field]: values[0] }, k, textJob);
}

