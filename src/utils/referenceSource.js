// AACF 3, Part 3: the origin comes as structured data (source_type +
// source_project) and is translated here; the prompts say it in English
// from the same data (src/prompts/shared.js referenceSourceText).
export function referenceSourceLabel(t, candidate) {
  switch (candidate.source_type) {
    case 'records':
      return t('records.assistant.referenceSource.records', { project: candidate.source_project });
    case 'catalog':
      return t('records.assistant.referenceSource.catalog');
    case 'template':
      return t('records.assistant.referenceSource.template');
    case 'project':
      return candidate.source_project;
    default:
      return '';
  }
}
