import { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { mockBRDPs } from '../data/mockBRDPs';
import { fetchBRDPs, saveBRDPs, createBRDP, updateBRDPApi, deleteAllBRDPs } from '../services/api';

const BRDPContext = createContext();

const STORAGE_KEY = 'brdp_data';

export function BRDPProvider({ children }) {
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

  const setBrdps = useCallback(async (newBrdps) => {
    setBrdpsState(newBrdps);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(newBrdps));
    try {
      await saveBRDPs(newBrdps);
    } catch (err) {
      console.error('Failed to save BRDPs to server:', err);
    }
  }, []);

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
      });
    }
  }, [brdps]);

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

    for (const brdp of newRows) {
      try {
        await createBRDP(brdp);
      } catch (err) {
        console.error('Failed to save imported BRDP to server:', err);
      }
    }
  }, [brdps]);

  const resetToMock = useCallback(async () => {
    setBrdpsState(mockBRDPs);
    localStorage.removeItem(STORAGE_KEY);
    try {
      await deleteAllBRDPs();
    } catch (err) {
      console.error('Failed to reset BRDPs on server:', err);
    }
  }, []);

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
