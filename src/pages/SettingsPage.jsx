import { useAPIKey } from '../hooks/useAPIKey';
import { useBRDPContext } from '../context/BRDPContext';
import AIConfigSection from '../components/AIConfigSection';
import ProjectConfigSection from '../components/ProjectConfigSection';
import DataManagementSection from '../components/DataManagementSection';
import AboutSection from '../components/AboutSection';
import ResetDataSection from '../components/ResetDataSection';
import styles from './SettingsPage.module.css';

/**
 * Settings Page component
 * Manages AI configuration, data management, and displays app information
 * @param {Object} props - Component props
 * @param {Function} props.showToast - Callback to show toast notifications
 * @returns {JSX.Element} Settings page with configuration sections
 */
export default function SettingsPage({ showToast }) {
  const {
    apiKey,
    modelName,
    provider,
    customEndpoint,
    setApiKey,
    setModelName,
    setProvider,
    setCustomEndpoint,
    saveKey,
    isConfigured,
  } = useAPIKey();
  const { brdps, setBrdps } = useBRDPContext();

  /**
   * Handle save button click
   */
  const handleSave = () => {
    saveKey(apiKey, modelName, provider, customEndpoint);
  };

  return (
    <div className={styles.container}>
      <h2 className={styles.title}>Settings</h2>

      <div className={styles.settingsGrid}>
        <AIConfigSection
          apiKey={apiKey}
          modelName={modelName}
          provider={provider}
          customEndpoint={customEndpoint}
          onApiKeyChange={setApiKey}
          onModelChange={setModelName}
          onProviderChange={setProvider}
          onCustomEndpointChange={setCustomEndpoint}
          onSave={handleSave}
          isConfigured={isConfigured}
        />

        <ProjectConfigSection />

        <DataManagementSection brdps={brdps} onSetBrdps={setBrdps} showToast={showToast} />

        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <AboutSection />
          <ResetDataSection onSetBrdps={setBrdps} showToast={showToast} />
        </div>
      </div>
    </div>
  );
}
