import { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { mockBRDPs } from '../data/mockBRDPs';
import { fetchBRDPs, saveBRDPs, createBRDP, updateBRDPApi, deleteBRDP, deleteAllBRDPs } from '../services/api';
import { useToastContext } from './ToastContext';

const BRDPContext = createContext();

const STORAGE_KEY = 'brdp_data';

export function BRDPProvider({ children }) {
  const { showToast } = useToastContext();
  const [brdps, setBrdpsState] = useState(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      try {
        return JSON.parse(stored);
      } catch {
        return mockBRDPs;
      }
    }
    return mockBRDPs;
  });

  const [selectedBRDPs, setSelectedBRDPs] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const loadBRDPs = async () => {
      try {
        const data = await fetchBRDPs();
        setBrdpsState(data);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        setError(null);
      } catch (err) {
        console.error('Failed to fetch BRDPs from server:', err);
        setError(err.message);
      } finally {
        setIsLoading(false);
      }
    };

    loadBRDPs();
  }, []);

  // Defense in depth: setBrdps() replaces the whole dataset (saveBRDPs()
  // deletes every BRDP + cascades to rule_approvals, then recreates each
  // row from this array). A caller passing a functional updater instead of
  // a plain array (React's useState-style API, but NOT supported here) has
  // caused real, total data loss before: setBrdpsState(fn) applies it
  // correctly via React's own updater support, but saveBRDPs(fn) then
  // deletes everything and immediately throws on "for (const brdp of fn)"
  // (a function is not iterable) -- after the delete already happened, so
  // nothing gets recreated. Reject non-arrays outright, before any of that
  // runs, rather than relying on every call site getting this right.
  const setBrdps = useCallback(async (newBrdps) => {
    if (!Array.isArray(newBrdps)) {
      console.error('setBrdps() called with a non-array value -- refusing to save. This is a programming error (did you pass a functional updater instead of an array?):', newBrdps);
      showToast('Internal error: invalid data, changes not saved.', 'error');
      return;
    }
    setBrdpsState(newBrdps);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(newBrdps));
    try {
      await saveBRDPs(newBrdps);
    } catch (err) {
      console.error('Failed to save BRDPs to server:', err);
      showToast('Failed to save BRDPs to the server. Your changes are only stored locally and may be lost.', 'error');
    }
  }, [showToast]);

  // Single-row edit path (DetailPanel/ChatPanel). Deliberately does NOT go
  // through setBrdps()/saveBRDPs() -- that helper deletes+recreates the
  // entire brdps table (needed for bulk import), which cascades to
  // rule_approvals and wipes every approval in the project, including ones
  // belonging to BRDPs untouched by this edit. PUT /api/brdps/:id updates
  // only this row.
  const updateBRDP = useCallback((id, changes) => {
    let updatedBrdp = null;
    const updated = brdps.map(b => {
      if (b.id !== id) return b;

      const history = b.history || [];
      const fieldsToTrack = ['proposal', 'comment', 'validation'];

      Object.keys(changes).forEach(field => {
        if (fieldsToTrack.includes(field) && changes[field] !== b[field]) {
          history.push({
            date: new Date().toISOString(),
            field,
            oldValue: b[field] || '',
            newValue: changes[field] || '',
          });
        }
      });

      updatedBrdp = { ...b, ...changes, history };
      return updatedBrdp;
    });

    setBrdpsState(updated);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));

    if (updatedBrdp) {
      updateBRDPApi(id, updatedBrdp).catch(err => {
        console.error('Failed to save BRDP to server:', err);
        showToast('Failed to save your changes to the server. Your edit is only stored locally and may be lost.', 'error');
      });
    }
  }, [brdps, showToast]);

  // Bulk-add path for Merge import (DataManagementSection.handleMerge).
  // Only ever called with rows guaranteed not to collide with existing ids
  // (see the collision-abort validation in handleMerge). Does NOT go
  // through setBrdps()/saveBRDPs() -- unlike Replace, Merge never touches
  // existing rows, so there's no reason to delete+recreate the whole table
  // (and cascade-wipe rule_approvals for every untouched BRDP in the process).
  const addBRDPs = useCallback(async (newRows) => {
    const updated = [...brdps, ...newRows];
    setBrdpsState(updated);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));

    let failedCount = 0;
    for (const brdp of newRows) {
      try {
        await createBRDP(brdp);
      } catch (err) {
        console.error('Failed to save imported BRDP to server:', err);
        failedCount += 1;
      }
    }
    if (failedCount > 0) {
      showToast(`Failed to save ${failedCount} of ${newRows.length} imported BRDP(s) to the server. They are only stored locally and may be lost.`, 'error');
    }
  }, [brdps, showToast]);

  // Targeted delete path (BRDPPage's single-row and bulk "Delete selected").
  // Deliberately does NOT go through setBrdps()/saveBRDPs() -- deleting one
  // or a few rows never needs to destroy+recreate the whole table (and
  // cascade-wipe rule_approvals for every BRDP that ISN'T being deleted).
  // DELETE /api/brdps/:id (deleteBRDP) already only removes that one row
  // and its own rule_approvals row server-side -- it just wasn't wired up
  // to this UI flow before.
  const deleteBRDPs = useCallback(async (ids) => {
    const idSet = new Set(ids);
    const updated = brdps.filter(b => !idSet.has(b.id));
    setBrdpsState(updated);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));

    let failedCount = 0;
    for (const id of ids) {
      try {
        await deleteBRDP(id);
      } catch (err) {
        console.error(`Failed to delete BRDP ${id} on server:`, err);
        failedCount += 1;
      }
    }
    if (failedCount > 0) {
      showToast(`Failed to delete ${failedCount} of ${ids.length} BRDP(s) on the server. They may reappear after reload.`, 'error');
    }
  }, [brdps, showToast]);

  const resetToMock = useCallback(async () => {
    setBrdpsState(mockBRDPs);
    localStorage.removeItem(STORAGE_KEY);
    try {
      await deleteAllBRDPs();
    } catch (err) {
      console.error('Failed to reset BRDPs on server:', err);
      showToast('Failed to reset BRDPs on the server. The reset is only applied locally and may not persist.', 'error');
    }
  }, [showToast]);

  const stats = {
    total: brdps.length,
    validated: brdps.filter((brdp) => brdp.validation === 'Validated').length,
    refused: brdps.filter((brdp) => brdp.validation === 'Refused').length,
    pending: brdps.filter((brdp) => brdp.validation === 'Pending').length,
  };

  const value = {
    brdps,
    setBrdps,
    updateBRDP,
    addBRDPs,
    deleteBRDPs,
    resetToMock,
    stats,
    selectedBRDPs,
    setSelectedBRDPs,
    isLoading,
    error,
    get selectedBRDP() {
      return selectedBRDPs.length > 0 ? selectedBRDPs[0] : null;
    },
    setSelectedBRDP: (brdp) => {
      setSelectedBRDPs(brdp ? [brdp] : []);
    },
  };

  return (
    <BRDPContext.Provider value={value}>
      {children}
    </BRDPContext.Provider>
  );
}

export function useBRDPContext() {
  const context = useContext(BRDPContext);
  if (!context) {
    throw new Error('useBRDPContext must be used within BRDPProvider');
  }
  return context;
}
