import { useState, useEffect, useCallback } from 'react';
import { mockBRDPs } from '../data/mockBRDPs';
import { fetchBRDPs, saveBRDPs, updateBRDPApi, deleteAllBRDPs } from '../services/api';

const STORAGE_KEY = 'brdp_data';

export function useBRDPs() {
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

  const updateBRDP = useCallback((id, changes) => {
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

      return { ...b, ...changes, history };
    });
    setBrdps(updated);
  }, [brdps, setBrdps]);

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

  return {
    brdps,
    setBrdps,
    stats,
    resetToMock,
    updateBRDP,
    isLoading,
    error,
  };
}
