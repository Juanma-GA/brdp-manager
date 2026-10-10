import { useTranslation } from 'react-i18next';
import styles from './SortableHeader.module.css';

/**
 * Shared sortable <th> -- first built for BRDP Records' table, reused
 * as-is for Settings > User Management (docs request: same visual and
 * behavioral pattern, not a second copy of it). aria-sort on the <th>
 * itself is the standard accessible way to expose a sortable column's
 * current direction; the ▲/▼ glyph is a purely visual echo of that same
 * state, carrying its own translated aria-label since a bare arrow
 * character isn't reliably announced by every screen reader.
 *
 * `field` identifies this column to the caller's own sort state -- the
 * caller owns sortField/sortDir/onSort entirely, this component only
 * renders based on whether `field` is the currently active one.
 *
 * `rowSpan` is optional passthrough for a two-level <thead> (ProjectsPage's
 * Proposal/Rule Status group headers) -- undefined by default, so every
 * existing single-row-header caller is unaffected.
 */
export default function SortableHeader({ field, sortField, sortDir, onSort, children, rowSpan }) {
  const { t } = useTranslation();
  const active = sortField === field;
  return (
    <th rowSpan={rowSpan} aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className={styles.sortHeaderBtn} onClick={() => onSort(field)}>
        {children}
        {active && (
          <span
            className={styles.sortIndicator}
            aria-label={t(sortDir === 'asc' ? 'sort.ascending' : 'sort.descending')}
          >
            {sortDir === 'asc' ? '▲' : '▼'}
          </span>
        )}
      </button>
    </th>
  );
}
