// AI Extract review table: the "Show" filter options and the i18n key of
// each label. Pure, so scripts/test-rule-extract.mjs can check that every
// option has its text in both languages.
//   - all / warnings / blocking: config.ruleExtract.filters.*
//   - a classification: config.ruleExtract.classes.* (the page adds the
//     specification / edition when every row of it shares one).
export const EXTRACT_CLASSES = [
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
