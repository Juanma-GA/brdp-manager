import * as XLSX from 'xlsx';
import { mockBRDPs } from '../data/mockBRDPs';

// Same 7 columns, same order, Import and Export to Excel now agree on
// exactly (docs request) -- Import used to deliberately keep the old
// 6-column v1 shape so Rule/Rule Status could never be typed by hand into
// an Excel and imported, bypassing the well-formed-XML check and the
// Draft->Verified workflow. That constraint is explicitly lifted this
// round: the two-phase analyze/apply flow (ProjectConfigPage.jsx,
// POST .../brdps/import/analyze then /apply) now validates Rule/Rule
// Status server-side with the same rigor, so hand-authored rules are
// real, reviewed rules, not a bypass.
const FIELD_MAP = {
  ID: 'identifier',
  Title: 'title',
  Definition: 'definition',
  Proposal: 'proposal',
  'Proposal Status': 'proposal_status',
  'Rule Status': 'rule_status',
  Rule: 'rule',
};

// Real, curated per-standard templates (10 real BRDPs each, Rule Status
// Verified with a real Rule already filled in) -- public/ assets, same
// naming convention as the existing brex-schema-summary-*.json files (dots
// in a version number become dashes). ProjectConfigPage.jsx's
// handleDownloadTemplate is the one and only place that reads this map (see
// its own comment) -- do not duplicate this mapping anywhere else.
// S1000D 5.0/6.0 have no generation engine yet (GeneratePage.jsx's
// "Coming soon"), so there is nothing real to show for them -- they, and
// any future standard added here without a curated file yet, fall through
// to generateTemplate() below.
export const CURATED_TEMPLATE_BY_STANDARD = {
  'S1000D 3.0.1': '/brdp-template-3-0-1.xlsx',
  'S1000D 4.1': '/brdp-template-4-1.xlsx',
  'S1000D 4.2': '/brdp-template-4-2.xlsx',
  'DITA 1.3 Xpath2.0': '/brdp-template-dita-xpath2.xlsx',
  'DITA 1.3 Xpath3.0': '/brdp-template-dita-xpath3.xlsx',
};

/**
 * Generate a GENERIC Excel template with headers and mock data -- fallback
 * only, for a standard with no curated file in CURATED_TEMPLATE_BY_STANDARD
 * above (today: S1000D 5.0/6.0, "Coming soon", no generation engine to show
 * a real Rule for yet). Kept, not deleted, for exactly that fallback role
 * and for any future standard that ships before a curated template exists
 * for it.
 * @returns {Blob} Excel file blob
 */
export function generateTemplate() {
  // Every mock row ships as Rule Status "To Do" + empty Rule -- the only
  // combination guaranteed valid regardless of which project this
  // template ends up imported into (a project's rule format, or lack of
  // one for DITA, isn't known at template-download time).
  const data = mockBRDPs.map((brdp) => ({
    ID: brdp.id,
    Title: brdp.title,
    Definition: brdp.definition,
    Proposal: brdp.proposal,
    'Proposal Status': brdp.validation,
    'Rule Status': 'To Do',
    Rule: '',
  }));

  const worksheet = XLSX.utils.json_to_sheet(data);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'BRDPs');

  // Set column widths
  worksheet['!cols'] = [
    { wch: 20 }, // ID
    { wch: 30 }, // Title
    { wch: 40 }, // Definition
    { wch: 40 }, // Proposal
    { wch: 16 }, // Proposal Status
    { wch: 14 }, // Rule Status
    { wch: 60 }, // Rule
  ];

  return XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
}

/**
 * Parse an Excel file into raw rows for the two-phase import flow.
 * This function ONLY checks the file is structurally readable (right
 * sheet, right headers) -- it does NOT validate identifiers, Rule XML, or
 * Rule/Rule Status combinations at all. All of that business-rule
 * validation now lives server-side in POST .../brdps/import/analyze,
 * which is the single source of truth for row validity (avoids two
 * separate, potentially-drifting copies of the same rules).
 * @param {File} file - Excel file to import
 * @returns {Promise<{ rows: Array, errors: Array }>} rows carry a
 *   1-based row_number (header row is 1, so the first data row is 2),
 *   matching what a spreadsheet user would call that row.
 */
export function importFromExcel(file) {
  const errors = [];

  try {
    const reader = new FileReader();
    return new Promise((resolve) => {
      reader.onload = (e) => {
        try {
          const workbook = XLSX.read(e.target.result, { type: 'binary' });

          if (workbook.SheetNames.length === 0) {
            errors.push('Excel file is empty');
            resolve({ rows: [], errors });
            return;
          }

          const worksheet = workbook.Sheets[workbook.SheetNames[0]];
          const data = XLSX.utils.sheet_to_json(worksheet, { defval: '' });

          if (data.length === 0) {
            errors.push('No data rows found in Excel file');
            resolve({ rows: [], errors });
            return;
          }

          // Validate columns
          const headers = Object.keys(data[0]);
          const requiredColumns = Object.keys(FIELD_MAP);
          const missingColumns = requiredColumns.filter(
            (col) => !headers.includes(col)
          );

          if (missingColumns.length > 0) {
            errors.push(
              `Missing required columns: ${missingColumns.join(', ')}`
            );
            resolve({ rows: [], errors });
            return;
          }

          const rows = data.map((row, index) => {
            const mappedRow = { row_number: index + 2 };
            Object.entries(FIELD_MAP).forEach(([excelCol, internalKey]) => {
              mappedRow[internalKey] = row[excelCol] ?? '';
            });
            return mappedRow;
          });

          resolve({ rows, errors });
        } catch (parseError) {
          errors.push('Failed to parse Excel file');
          resolve({ rows: [], errors });
        }
      };

      reader.readAsBinaryString(file);
    });
  } catch (error) {
    errors.push('Error reading file');
    return Promise.resolve({ rows: [], errors });
  }
}

/**
 * Export BRDPs to Excel
 *
 * @param {Array} brdps - Array of rows already shaped by
 *   ProjectConfigPage's brdpToExportRow(): {id, title, definition,
 *   proposal, proposalStatus, ruleStatus, rule}.
 */
export function exportToExcel(brdps) {
  const data = brdps.map((brdp) => ({
    ID: brdp.id,
    Title: brdp.title,
    Definition: brdp.definition,
    Proposal: brdp.proposal,
    'Proposal Status': brdp.proposalStatus,
    'Rule Status': brdp.ruleStatus,
    Rule: brdp.rule,
  }));

  const worksheet = XLSX.utils.json_to_sheet(data);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'BRDPs');

  // Set column widths
  worksheet['!cols'] = [
    { wch: 20 }, // ID
    { wch: 30 }, // Title
    { wch: 40 }, // Definition
    { wch: 40 }, // Proposal
    { wch: 16 }, // Proposal Status
    { wch: 14 }, // Rule Status
    { wch: 60 }, // Rule
  ];

  XLSX.writeFile(workbook, 'brdps-export.xlsx');
}

/**
 * Export BRDPs to CSV
 * @param {Array} brdps - Array of BRDP records
 */
export function exportToCSV(brdps) {
  const data = brdps.map((brdp) => ({
    'BRDP Identifier': brdp.id,
    'BRDP Title': brdp.title,
    'BRDP Definition': brdp.definition,
    'ATX Decision Proposal': brdp.proposal,
    'Validation Status': brdp.validation,
    'Comment': brdp.comment,
  }));

  const worksheet = XLSX.utils.json_to_sheet(data);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'BRDPs');

  XLSX.writeFile(workbook, 'brdps-export.csv', { bookType: 'csv' });
}
