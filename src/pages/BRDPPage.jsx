import { useState, useCallback } from 'react';
import { useBRDPContext } from '../context/BRDPContext';
import { useTableLogic } from '../hooks/useTableLogic';
import { useProjectConfig } from '../hooks/useProjectConfig';
import SearchBar from '../components/SearchBar';
import FilterPills from '../components/FilterPills';
import BRDPTable from '../components/BRDPTable';
import DetailPanel from '../components/DetailPanel';
import styles from './BRDPPage.module.css';

/**
 * BRDP Page component
 * Main page with search, filter, sort, pagination, and detail panel
 * Chain: filter → search → sort → paginate
 * @param {Object} props - Component props
 * @param {Object} props.selectedBrdp - Currently selected BRDP for detail panel
 * @param {Function} props.onSelectBrdp - Callback to select/deselect BRDP
 * @param {Function} props.showToast - Callback to show toast notifications
 * @param {Function} props.onNavigate - Callback to navigate to different page
 * @param {number} [props.approvalsRefreshToken] - Bumped after every Generate
 *   attempt so BRDPTable's Rule Approval column refetches (see Issue #15)
 * @returns {JSX.Element} Page with table and detail panel
 */
export default function BRDPPage({ showToast, onNavigate, approvalsRefreshToken }) {
  const { brdps, setBrdps, selectedBRDPs, setSelectedBRDPs, stats } = useBRDPContext();
  const { projectConfig } = useProjectConfig();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('All');
  const [sortField, setSortField] = useState('');
  const [sortDir, setSortDir] = useState('');
  const [page, setPage] = useState(1);
  const [detailBrdp, setDetailBrdp] = useState(null);
  const [isDirty, setIsDirty] = useState(false);

  // Reset to page 1 when search or filter changes
  const handleSearchChange = (newSearch) => {
    setSearch(newSearch);
    setPage(1);
  };

  const handleFilterChange = (newFilter) => {
    setFilter(newFilter);
    setPage(1);
  };

  /**
   * Handle sort change
   * @param {string} field - Field to sort by
   * @param {string} dir - Sort direction ('asc', 'desc', or '')
   */
  const handleSort = (field, dir) => {
    setSortField(field);
    setSortDir(dir);
  };

  /**
   * Handle page change
   * @param {number} newPage - New page number
   */
  const handlePageChange = (newPage) => {
    setPage(newPage);
  };


  /**
   * Handle edit button click: open detail/edit panel
   */
  const handleEditBrdp = (brdp) => {
    setDetailBrdp(brdp);
  };

  /**
   * Handle closing the detail panel
   */
  const handleClosePanel = () => {
    setDetailBrdp(null);
    setIsDirty(false);
  };

  /**
   * Handle BRDP updated in DetailPanel
   */
  const handleBrdpUpdate = (updatedBrdp) => {
    // Update the detail panel to show the new values
    setDetailBrdp(updatedBrdp);
    // Update the selected BRDP in the context if it's currently selected
    if (selectedBRDPs.some(b => b.id === updatedBrdp.id)) {
      const updated = selectedBRDPs.map(b =>
        b.id === updatedBrdp.id ? updatedBrdp : b
      );
      setSelectedBRDPs(updated);
    }
  };

  /**
   * Handle BRDP deletion
   */
  const handleDeleteBRDP = (id) => {
    setBrdps(prev => prev.filter(b => b.id !== id));
    setSelectedBRDPs(selectedBRDPs.filter(b => b.id !== id));
    setDetailBrdp(null);
  };

  /**
   * Handle deletion of multiple selected BRDPs
   */
  const handleDeleteSelected = (ids) => {
    setBrdps(prev => prev.filter(b => !ids.includes(b.id)));
    setSelectedBRDPs([]);
  };

  // Use table logic with all parameters
  const { rows, totalPages, total } = useTableLogic({
    brdps,
    search,
    filter,
    sortField,
    sortDir,
    page,
  });

  // Update callback dependency after rows is available
  const handleSelectBrdpWithRows = useCallback((brdp, options = {}) => {
    const { mode = 'single' } = options;
    const brdpId = brdp.id;

    if (mode === 'single') {
      setSelectedBRDPs([brdp]);
    } else if (mode === 'toggle') {
      if (selectedBRDPs.some(b => b.id === brdpId)) {
        setSelectedBRDPs(selectedBRDPs.filter(b => b.id !== brdpId));
      } else {
        setSelectedBRDPs([...selectedBRDPs, brdp]);
      }
    } else if (mode === 'range' && options.lastSelectedId) {
      const lastIdx = rows.findIndex(r => r.id === options.lastSelectedId);
      const currentIdx = rows.findIndex(r => r.id === brdpId);
      if (lastIdx !== -1 && currentIdx !== -1) {
        const [start, end] = lastIdx < currentIdx ? [lastIdx, currentIdx] : [currentIdx, lastIdx];
        const rangeRows = rows.slice(start, end + 1);
        setSelectedBRDPs(rangeRows);
      }
    }
  }, [selectedBRDPs, rows, setSelectedBRDPs]);

  const noResults = total === 0;

  return (
    <div className={styles.pageContainer}>
      <div className={styles.container}>
        <h2 className={styles.title}>BRDP Records</h2>
        <p className={styles.stats}>
          <span className={styles.statNumber + ' ' + styles.totalNumber}>{stats.total}</span> total ·{' '}
          <span className={styles.statNumber + ' ' + styles.validatedNumber}>{stats.validated}</span> validated ·{' '}
          <span className={styles.statNumber + ' ' + styles.refusedNumber}>{stats.refused}</span> refused ·{' '}
          <span className={styles.statNumber + ' ' + styles.pendingNumber}>{stats.pending}</span> pending
        </p>

        <div className={styles.controls}>
          <SearchBar value={search} onChange={handleSearchChange} />
          <FilterPills activeFilter={filter} onFilterChange={handleFilterChange} />
        </div>

        <div className={styles.tableWrapper}>
          <BRDPTable
            rows={rows}
            onSelect={handleSelectBrdpWithRows}
            onEdit={handleEditBrdp}
            selectedIds={selectedBRDPs.map(b => b.id)}
            onSort={handleSort}
            sortField={sortField}
            sortDir={sortDir}
            currentPage={page}
            totalPages={totalPages || 1}
            total={total}
            onPageChange={handlePageChange}
            noResults={noResults}
            noBrdps={brdps.length === 0}
            onGoToSettings={() => onNavigate('settings')}
            editingBrdpId={detailBrdp?.id}
            isDirtyEditing={isDirty}
            onDeleteSelected={handleDeleteSelected}
            primaryFormat={projectConfig.primaryFormat}
            approvalsRefreshToken={approvalsRefreshToken}
          />
        </div>
      </div>

      {/* Detail Panel */}
      {detailBrdp && (
        <DetailPanel
          brdp={detailBrdp}
          onClose={handleClosePanel}
          showToast={showToast}
          onUpdate={handleBrdpUpdate}
          onDirtyChange={setIsDirty}
          onDelete={handleDeleteBRDP}
        />
      )}
    </div>
  );
}
