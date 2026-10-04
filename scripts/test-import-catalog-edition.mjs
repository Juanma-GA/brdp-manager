// Texts of the Excel import's "from another edition's catalog" warning and
// History entry, in English and Spanish, with the real translations.
//     node scripts/test-import-catalog-edition.mjs
import i18n from '../src/i18n/index.js';
import { catalogEditionLabel, catalogEditionRetired, catalogEditionTitle } from '../src/utils/catalogEdition.js';
import { buildHTML, buildMarkdown } from '../src/api/buildBREXdocReport.js';

let failures = 0;
function check(label, actual, expected) {
  if (actual === expected) console.log(`  ok  ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}\n       got:      ${JSON.stringify(actual)}\n       expected: ${JSON.stringify(expected)}`);
  }
}

const en = i18n.getFixedT('en');
const es = i18n.getFixedT('es');
const row = { row: 12, identifier: 'BRDP-S1-00012', standard: 'S1000D 4.2', edition: 'S1000D 4.1', version: '4.2' };

check('row ES, older edition', es('config.dataManagement.catalogEditionRowRetired', row),
  'Fila 12: BRDP-S1-00012 no está en el catálogo S1000D 4.2; está en S1000D 4.1 (obsoleta en 4.2)');
check('row EN, older edition', en('config.dataManagement.catalogEditionRowRetired', row),
  'Row 12: BRDP-S1-00012 is not in the S1000D 4.2 catalog; it is in S1000D 4.1 (retired in 4.2)');
const newer = { row: 3, identifier: 'BRDP-S1-00499', standard: 'S1000D 4.1', edition: 'S1000D 4.2' };
check('row ES, newer edition', es('config.dataManagement.catalogEditionRow', newer),
  'Fila 3: BRDP-S1-00499 no está en el catálogo S1000D 4.1; está en S1000D 4.2');
check('row EN, newer edition', en('config.dataManagement.catalogEditionRow', newer),
  'Row 3: BRDP-S1-00499 is not in the S1000D 4.1 catalog; it is in S1000D 4.2');
check('counter ES', es('config.dataManagement.summaryCatalogEdition', { count: 116 }), 'De catálogo de otra edición: 116');
check('counter EN', en('config.dataManagement.summaryCatalogEdition', { count: 116 }), "From another edition's catalog: 116");
check('substitution ES', es('config.dataManagement.catalogOverrideRowEdition', { row: 12, identifier: 'BRDP-S1-00012', edition: 'S1000D 4.1' }),
  'Fila 12 (BRDP-S1-00012): Title y Definition usarán los valores del catálogo S1000D 4.1, no los del fichero');
// History: the same text AI Extract's event ends with.
check('History ES', es('records.history.extractedFromCatalogEdition', { edition: 'S1000D 4.1', standard: 'S1000D 4.2' }),
  'catálogo S1000D 4.1, no existe en S1000D 4.2');
check('History field ES', es('records.history.fields.catalog_edition'), 'Catálogo');
check('History field EN', en('records.history.fields.catalog_edition'), 'Catalog');
for (const key of ['catalogEditionListTitle', 'catalogEditionShow', 'catalogEditionHide', 'catalogEditionHint']) {
  for (const [lang, t] of [['en', en], ['es', es]]) {
    const text = t(`config.dataManagement.${key}`, { count: 2 });
    check(`${key} ${lang} translated`, text.startsWith('config.') || text.includes('{{'), false);
  }
}

// The "4.1" label next to the identifier (Records, the BRDP panel, Compare).
check('label', catalogEditionLabel('S1000D 4.1'), '4.1');
check('label 3.0.1', catalogEditionLabel('S1000D 3.0.1'), '3.0.1');
check('retired: 4.1 in a 4.2 project', catalogEditionRetired('S1000D 4.1', 'S1000D 4.2'), true);
check('not retired: 4.2 in a 4.1 project', catalogEditionRetired('S1000D 4.2', 'S1000D 4.1'), false);
check('retired: 3.0.1 in a 4.1 project', catalogEditionRetired('S1000D 3.0.1', 'S1000D 4.1'), true);
check('tooltip ES, older', catalogEditionTitle(es, 'S1000D 4.1', 'S1000D 4.2'), 'Del catálogo S1000D 4.1. No existe en S1000D 4.2 (obsoleta).');
check('tooltip ES, newer', catalogEditionTitle(es, 'S1000D 4.2', 'S1000D 4.1'), 'Del catálogo S1000D 4.2. No existe en S1000D 4.1.');
check('tooltip EN, older', catalogEditionTitle(en, 'S1000D 4.1', 'S1000D 4.2'), 'From the S1000D 4.1 catalog. Not in S1000D 4.2 (retired).');
check('tooltip EN, newer', catalogEditionTitle(en, 'S1000D 4.2', 'S1000D 4.1'), 'From the S1000D 4.2 catalog. Not in S1000D 4.1.');

// Report: "Catalog Edition" column, "S1000D 4.1" in those rows, empty in the rest.
const reportRows = [
  { id: 'BRDP-S1-00036', title: 'T', definition: 'D', proposal: 'P', validation: 'Pending', ruleStatus: 'To Do', catalogEdition: 'S1000D 4.1' },
  { id: 'BRDP-S1-00052', title: 'T', definition: 'D', proposal: 'P', validation: 'Pending', ruleStatus: 'To Do' },
];
const html = buildHTML(reportRows, { projectName: 'P' });
check('report HTML: column header', html.includes('<th>Catalog Edition</th>'), true);
check('report HTML: data carries the edition', html.includes('"catalogEdition":"S1000D 4.1"'), true);
check('report HTML: empty for the rest', html.includes('"id":"BRDP-S1-00052","title":"T","definition":"D","proposal":"P","validation":"Pending","ruleStatus":"To Do","catalogEdition":""'), true);
const md = buildMarkdown(reportRows, { projectName: 'P' });
check('report Markdown: header', md.includes('| ID | Title | Definition | Proposal | Status | Rule Status | Catalog Edition |'), true);
check('report Markdown: row with the edition', md.includes('| `BRDP-S1-00036` | T | D | P | Pending | To Do | S1000D 4.1 |'), true);
check('report Markdown: row without', md.includes('| `BRDP-S1-00052` | T | D | P | Pending | To Do |  |'), true);

console.log(failures ? `\n${failures} FAILED` : '\nALL OK');
process.exit(failures ? 1 : 0);
