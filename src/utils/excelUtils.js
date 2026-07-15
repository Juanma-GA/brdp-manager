import * as XLSX from 'xlsx';
import { mockBRDPs } from '../data/mockBRDPs';

const COLUMN_NAMES = [
  'BRDP Identifier',
  'BRDP Title',
  'BRDP Definition',
  'ATX Decision Proposal',
  'Validation Status',
  'Comment',
];

const FIELD_MAP = {
  'BRDP Identifier': 'id',
  'BRDP Title': 'title',
  'BRDP Definition': 'definition',
  'ATX Decision Proposal': 'proposal',
  'Validation Status': 'validation',
  'Comment': 'comment',
};

/**
 * Generate Excel template with headers and mock data
 * @returns {Blob} Excel file blob
 */
export function generateTemplate() {
  const data = mockBRDPs.map((brdp) => ({
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

  // Set column widths
  worksheet['!cols'] = [
    { wch: 20 }, // BRDP Identifier
    { wch: 30 }, // BRDP Title
    { wch: 40 }, // BRDP Definition
    { wch: 40 }, // ATX Decision Proposal
    { wch: 18 }, // Validation Status
    { wch: 30 }, // Comment
  ];

  return XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
}

/**
 * Import BRDPs from Excel file
 * @param {File} file - Excel file to import
 * @returns {Object} { rows: Array, errors: Array }
 */
export function importFromExcel(file) {
  const errors = [];
  const rows = [];

  try {
    const arrayBuffer = new Uint8Array(file.slice(0, 100));
    const bstr = String.fromCharCode.apply(null, arrayBuffer);

    // Read the entire file
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

          // Map rows to internal format
          data.forEach((row, index) => {
            const mappedRow = {};
            Object.entries(FIELD_MAP).forEach(([excelCol, internalKey]) => {
              mappedRow[internalKey] = row[excelCol] || '';
            });

            // Validate required fields
            if (!mappedRow.id) {
              errors.push(`Row ${index + 2}: Missing BRDP Identifier`);
              return;
            }

            rows.push(mappedRow);
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
 * @param {Array} brdps - Array of BRDP records
 */
export function exportToExcel(brdps) {
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

  // Set column widths
  worksheet['!cols'] = [
    { wch: 20 },
    { wch: 30 },
    { wch: 40 },
    { wch: 40 },
    { wch: 18 },
    { wch: 30 },
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
