import { useMemo } from 'react';

const ROWS_PER_PAGE = 25;

/**
 * Filter BRDPs by validation status
 * @param {Array} brdps - Array of BRDP records
 * @param {string} filter - Filter value: 'All', 'Validated', 'Refused', or 'Pending'
 * @returns {Array} Filtered BRDPs
 */
function applyFilter(brdps, filter) {
  if (filter === 'All') return brdps;
  return brdps.filter((brdp) => brdp.validation === filter);
}

/**
 * Search BRDPs across all text fields
 * @param {Array} brdps - Array of BRDP records
 * @param {string} search - Search term
 * @returns {Array} Filtered BRDPs matching search
 */
function applySearch(brdps, search) {
  if (!search.trim()) return brdps;

  const term = search.toLowerCase();
  return brdps.filter((brdp) =>
    brdp.id.toLowerCase().includes(term) ||
    brdp.definition.toLowerCase().includes(term) ||
    brdp.proposal.toLowerCase().includes(term) ||
    brdp.validation.toLowerCase().includes(term)
  );
}

/**
 * Sort BRDPs by specified field
 * @param {Array} brdps - Array of BRDP records
 * @param {string} sortField - Field to sort by ('id' or 'validation')
 * @param {string} sortDir - Sort direction ('asc', 'desc', or '')
 * @returns {Array} Sorted BRDPs
 */
function applySort(brdps, sortField, sortDir) {
  if (!sortDir || !sortField) return brdps;

  const sorted = [...brdps].sort((a, b) => {
    const aVal = a[sortField];
    const bVal = b[sortField];

    if (typeof aVal === 'string') {
      return sortDir === 'asc'
        ? aVal.localeCompare(bVal)
        : bVal.localeCompare(aVal);
    }

    return sortDir === 'asc' ? aVal - bVal : bVal - aVal;
  });

  return sorted;
}

/**
 * Apply pagination to BRDPs
 * @param {Array} brdps - Array of BRDP records
 * @param {number} page - Current page (1-indexed)
 * @returns {Array} BRDPs for current page
 */
function applyPagination(brdps, page) {
  const start = (page - 1) * ROWS_PER_PAGE;
  const end = start + ROWS_PER_PAGE;
  return brdps.slice(start, end);
}

/**
 * @typedef {Object} UseTableLogicReturn
 * @property {Array} rows - Paginated and processed BRDP records
 * @property {number} totalPages - Total number of pages
 * @property {number} total - Total number of records after filter and search
 */

/**
 * Custom hook for table logic handling filter, search, sort, and pagination
 * All operations are chained: filter → search → sort → paginate
 * Uses useMemo for efficient re-rendering
 * @param {Object} params - Hook parameters
 * @param {Array} params.brdps - Array of BRDP records
 * @param {string} params.search - Search term
 * @param {string} params.filter - Filter value ('All', 'Validated', 'Refused', 'Pending')
 * @param {string} params.sortField - Field to sort by ('id' or 'validation')
 * @param {string} params.sortDir - Sort direction ('asc', 'desc', or '')
 * @param {number} params.page - Current page (1-indexed)
 * @returns {UseTableLogicReturn} Processed rows and pagination info
 */
export function useTableLogic({ brdps, search, filter, sortField, sortDir, page }) {
  const processed = useMemo(() => {
    // Chain operations: filter → search → sort → paginate
    let result = applyFilter(brdps, filter);
    result = applySearch(result, search);
    const total = result.length;
    result = applySort(result, sortField, sortDir);
    const rows = applyPagination(result, page);

    const totalPages = Math.max(1, Math.ceil(total / ROWS_PER_PAGE));

    return { rows, totalPages, total };
  }, [brdps, search, filter, sortField, sortDir, page]);

  return processed;
}
