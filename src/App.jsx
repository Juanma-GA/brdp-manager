import { useState, useEffect } from 'react';
import { useToast } from './hooks/useToast';
import { useAPIKey } from './hooks/useAPIKey';
import { useChat } from './hooks/useChat';
import { useProjectConfig } from './hooks/useProjectConfig';
import { BRDPProvider, useBRDPContext } from './context/BRDPContext';
import Header from './components/Header';
import Sidebar from './components/Sidebar';
import ToastContainer from './components/ToastContainer';
import BRDPPage from './pages/BRDPPage';
import SettingsPage from './pages/SettingsPage';
import ChatPanel from './components/ChatPanel';
import GenerateModal from './components/GenerateModal';
import BREXdocModal from './components/BREXdocModal/BREXdocModal';
import AIExtractModal from './components/AIExtractModal/AIExtractModal';
import './index.css';
import './App.css';

// Access BRDPContext inside AppContent
function useSelectedBRDP() {
  const { selectedBRDPs } = useBRDPContext();
  return selectedBRDPs.length > 0 ? selectedBRDPs[0] : null;
}

/**
 * Main App component
 * Manages page routing between BRDP and Settings pages
 * @returns {JSX.Element} Application layout with header, sidebar, and main content
 */
function AppContent() {
  const [currentPage, setCurrentPage] = useState('brdp');
  const [chatOpen, setChatOpen] = useState(false);
  const [showGenerateModal, setShowGenerateModal] = useState(false);
  const [showBREXdocModal, setShowBREXdocModal] = useState(false);
  const [showAIExtractModal, setShowAIExtractModal] = useState(false);
  // Bumped after every Generate attempt so BRDPTable's Rule Approval column
  // (each RuleApprovalCell fetches its own approval independently) refetches
  // instead of staying stale until a manual page reload -- see Issue #15.
  const [approvalsRefreshToken, setApprovalsRefreshToken] = useState(0);
  const [chatPanelWidth, setChatPanelWidth] = useState(() => {
    const saved = localStorage.getItem('chatPanelWidth');
    return saved ? parseInt(saved) : 340;
  });
  const { brdps, setBrdps, selectedBRDPs, setSelectedBRDPs } = useBRDPContext();
  const { toasts, showToast } = useToast();
  const { apiKey, modelName, provider, customEndpoint, isConfigured } = useAPIKey();
  const { projectConfig } = useProjectConfig();

  const { messages, sendUserMessage, clearHistory, stopStreaming, isLoading, error } = useChat({
    apiKey,
    modelName,
    provider,
    customEndpoint,
    selectedBRDPs,
  });

  // Save chat panel width to localStorage
  useEffect(() => {
    localStorage.setItem('chatPanelWidth', chatPanelWidth.toString());
  }, [chatPanelWidth]);

  /**
   * Handle opening generate modal
   */
  const openGenerateModal = () => {
    setShowGenerateModal(true);
  };

  const openAIExtractModal = () => {
    setShowAIExtractModal(true);
  };

  const handleImportBRDPs = (newBrdps, mergeMode) => {
    if (mergeMode === 'replace') {
      setBrdps(newBrdps);
    } else {
      setBrdps([...brdps, ...newBrdps]);
    }
  };

  /**
   * Handle opening chat from header
   */
  const handleHeaderChatClick = () => {
    if (currentPage === 'brdp') {
      setChatOpen(!chatOpen);
    }
  };

  const handleCloseChat = () => {
    setChatOpen(false);
  };

  const handleNavigateSettings = () => {
    handleCloseChat();
  };

  return (
    <div className="appContainer">
      <Header onChatClick={handleHeaderChatClick} chatOpen={chatOpen && currentPage === 'brdp'} onOpenGenerateModal={openGenerateModal} onOpenBREXdocModal={() => setShowBREXdocModal(true)} onOpenAIExtractModal={openAIExtractModal} showToast={showToast} />
      <div className="workspaceRow">
        <Sidebar currentPage={currentPage} onNavigate={setCurrentPage} />
        <main className="mainContent">
          {currentPage === 'brdp' && (
            <BRDPPage showToast={showToast} onNavigate={setCurrentPage} approvalsRefreshToken={approvalsRefreshToken} />
          )}
          {currentPage === 'settings' && <SettingsPage showToast={showToast} />}
        </main>
        {currentPage === 'brdp' && chatOpen && (
          <ChatPanel
            messages={messages}
            onSendMessage={sendUserMessage}
            onClearHistory={clearHistory}
            onStopStreaming={stopStreaming}
            isLoading={isLoading}
            error={error}
            isConfigured={isConfigured}
            onNavigateSettings={handleNavigateSettings}
            onClose={handleCloseChat}
            detailPanelOpen={selectedBRDPs.length > 0}
            selectedBRDPs={selectedBRDPs}
            onDeselectBrdp={() => setSelectedBRDPs([])}
            onOpenGenerateModal={openGenerateModal}
            width={chatPanelWidth}
            onWidthChange={setChatPanelWidth}
          />
        )}
      </div>
      {showGenerateModal && (
        <GenerateModal
          brdps={brdps}
          onClose={() => setShowGenerateModal(false)}
          onGenerateComplete={() => setApprovalsRefreshToken((t) => t + 1)}
        />
      )}
      {showBREXdocModal && (
        <BREXdocModal
          brdps={brdps}
          projectConfig={projectConfig}
          onClose={() => setShowBREXdocModal(false)}
        />
      )}
      {showAIExtractModal && (
        <AIExtractModal
          onClose={() => setShowAIExtractModal(false)}
          existingBRDPs={brdps}
          onImport={handleImportBRDPs}
        />
      )}
      <ToastContainer toasts={toasts} />
    </div>
  );
}

function App() {
  return (
    <BRDPProvider>
      <AppContent />
    </BRDPProvider>
  );
}

export default App;
