import { useState, useEffect, useCallback } from 'react';
import { fetchSettings, saveSettings } from '../services/api';

const API_KEY_STORAGE = 'brdp_api_key';
const MODEL_STORAGE = 'brdp_model';
const PROVIDER_STORAGE = 'brdp_provider';
const CUSTOM_ENDPOINT_STORAGE = 'brdp_custom_endpoint';

export function useAPIKey() {
  const [apiKey, setApiKey] = useState(() => {
    try {
      return localStorage.getItem(API_KEY_STORAGE) || '';
    } catch {
      return '';
    }
  });

  const [modelName, setModelName] = useState(() => {
    try {
      return localStorage.getItem(MODEL_STORAGE) || '';
    } catch {
      return '';
    }
  });

  const [provider, setProvider] = useState(() => {
    try {
      return localStorage.getItem(PROVIDER_STORAGE) || 'Anthropic';
    } catch {
      return 'Anthropic';
    }
  });

  const [customEndpoint, setCustomEndpoint] = useState(() => {
    try {
      return localStorage.getItem(CUSTOM_ENDPOINT_STORAGE) || '';
    } catch {
      return '';
    }
  });

  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const data = await fetchSettings();
        setApiKey(data.brdp_api_key || '');
        setModelName(data.brdp_model || '');
        setProvider(data.brdp_provider || 'Anthropic');
        setCustomEndpoint(data.brdp_custom_endpoint || '');
        localStorage.setItem(API_KEY_STORAGE, data.brdp_api_key || '');
        localStorage.setItem(MODEL_STORAGE, data.brdp_model || '');
        localStorage.setItem(PROVIDER_STORAGE, data.brdp_provider || 'Anthropic');
        localStorage.setItem(CUSTOM_ENDPOINT_STORAGE, data.brdp_custom_endpoint || '');
        setError(null);
      } catch (err) {
        console.error('Failed to fetch settings from server:', err);
        setError(err.message);
      } finally {
        setIsLoading(false);
      }
    };

    loadSettings();
  }, []);

  const saveKey = useCallback(async (key, model, prov, endpoint = '') => {
    try {
      setApiKey(key);
      setModelName(model);
      setProvider(prov);
      setCustomEndpoint(endpoint);
      localStorage.setItem(API_KEY_STORAGE, key);
      localStorage.setItem(MODEL_STORAGE, model);
      localStorage.setItem(PROVIDER_STORAGE, prov);
      localStorage.setItem(CUSTOM_ENDPOINT_STORAGE, endpoint);
      await saveSettings({
        brdp_api_key: key,
        brdp_model: model,
        brdp_provider: prov,
        brdp_custom_endpoint: endpoint,
      });
    } catch (err) {
      console.error('Failed to save API configuration:', err);
    }
  }, []);

  const clearKey = useCallback(async () => {
    try {
      setApiKey('');
      setModelName('');
      setProvider('Anthropic');
      setCustomEndpoint('');
      localStorage.removeItem(API_KEY_STORAGE);
      localStorage.removeItem(MODEL_STORAGE);
      localStorage.removeItem(PROVIDER_STORAGE);
      localStorage.removeItem(CUSTOM_ENDPOINT_STORAGE);
      await saveSettings({
        brdp_api_key: '',
        brdp_model: '',
        brdp_provider: 'Anthropic',
        brdp_custom_endpoint: '',
      });
    } catch (err) {
      console.error('Failed to clear API configuration:', err);
    }
  }, []);

  const isConfigured = apiKey.trim().length > 0;

  return {
    apiKey,
    modelName,
    provider,
    customEndpoint,
    setApiKey,
    setModelName,
    setProvider,
    setCustomEndpoint,
    saveKey,
    clearKey,
    isConfigured,
    isLoading,
    error,
  };
}
