import { useState } from 'react';
import { fetchNote, saveNote as apiSaveNote } from '../services/api';
import { useToastContext } from '../context/ToastContext';

const STORAGE_KEY = 'brdp_notes';

function getNote(id) {
  try {
    const notes = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return notes[id] || '';
  } catch {
    return '';
  }
}

export function useLocalNotes() {
  const { showToast } = useToastContext();
  const [loadingNotes, setLoadingNotes] = useState({});
  const [noteErrors, setNoteErrors] = useState({});

  const saveNote = (id, text) => {
    try {
      const notes = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      notes[id] = text;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
    } catch {
      console.error('Failed to save note to localStorage');
    }
    apiSaveNote(id, text).catch(err => {
      console.error('Failed to save note to server:', err);
      showToast('Failed to save your note to the server. It is only stored locally and may be lost.', 'error');
    });
  };

  const getNoteSynced = async (id) => {
    setLoadingNotes(prev => ({ ...prev, [id]: true }));
    try {
      const text = await fetchNote(id);
      const notes = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      notes[id] = text;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
      setNoteErrors(prev => {
        const updated = { ...prev };
        delete updated[id];
        return updated;
      });
      return text;
    } catch (err) {
      console.error(`Failed to fetch note ${id}:`, err);
      setNoteErrors(prev => ({ ...prev, [id]: err.message }));
      return getNote(id);
    } finally {
      setLoadingNotes(prev => ({ ...prev, [id]: false }));
    }
  };

  return {
    getNote,
    saveNote,
    getNoteSynced,
    loadingNotes,
    noteErrors,
  };
}
