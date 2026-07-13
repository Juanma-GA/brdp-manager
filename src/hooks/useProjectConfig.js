import { useState, useEffect, useCallback } from 'react';
import { fetchConfig, saveConfig } from '../services/api';

const STORAGE_KEY = 'brdp_project_config';

const DEFAULT_CONFIG = {
  projectName: '',
  modelIdentCode: '',
  systemDiffCode: 'A',
  issueNumber: '001',
  inWork: '00',
  languageIsoCode: 'en',
  countryIsoCode: 'US',
  securityClassification: '01',
  enterpriseCode: '',
  primaryFormat: '',
};

export function useProjectConfig() {
  const [projectConfig, setProjectConfig] = useState(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      try {
        return JSON.parse(stored);
      } catch {
        return DEFAULT_CONFIG;
      }
    }
    return DEFAULT_CONFIG;
  });

  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const loadConfig = async () => {
      try {
        const data = await fetchConfig();
        const config = { ...DEFAULT_CONFIG, ...data };
        setProjectConfig(config);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
        setError(null);
      } catch (err) {
        console.error('Failed to fetch config from server:', err);
        setError(err.message);
      } finally {
        setIsLoading(false);
      }
    };

    loadConfig();
  }, []);

  const saveProjectConfig = useCallback(async (config) => {
    setProjectConfig(config);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    try {
      await saveConfig(config);
    } catch (err) {
      console.error('Failed to save config to server:', err);
    }
  }, []);

  return {
    projectConfig,
    saveProjectConfig,
    isLoading,
    error,
  };
}
