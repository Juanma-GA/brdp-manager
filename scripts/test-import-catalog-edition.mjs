// Texts of the Excel import's "from another edition's catalog" warning and
// History entry, in English and Spanish, with the real translations.
//     node scripts/test-import-catalog-edition.mjs
import i18n from '../src/i18n/index.js';

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

console.log(failures ? `\n${failures} FAILED` : '\nALL OK');
process.exit(failures ? 1 : 0);
