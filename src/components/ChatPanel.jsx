import { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { useBRDPContext } from '../context/BRDPContext';
import TypingDots from './TypingDots';
import styles from './ChatPanel.module.css';

/**
 * Parse message content for [SUGGESTION:field]...[/SUGGESTION] blocks
 * @param {string} content - Message content
 * @returns {Array} Array of {type, content, field} objects
 */
function parseSuggestions(content) {
  const parts = [];
  const suggestionRegex = /\[SUGGESTION:(proposal|comment)\]([\s\S]*?)\[\/SUGGESTION\]/g;
  let lastIndex = 0;
  let match;

  while ((match = suggestionRegex.exec(content)) !== null) {
    // Add text before suggestion as markdown
    if (match.index > lastIndex) {
      parts.push({
        type: 'markdown',
        content: content.substring(lastIndex, match.index),
      });
    }

    // Add suggestion block
    parts.push({
      type: 'suggestion',
      field: match[1],
      content: match[2].trim(),
    });

    lastIndex = match.index + match[0].length;
  }

  // Add remaining text after last suggestion
  if (lastIndex < content.length) {
    parts.push({
      type: 'markdown',
      content: content.substring(lastIndex),
    });
  }

  // If no suggestions found, return entire content as markdown
  if (parts.length === 0) {
    return [{ type: 'markdown', content }];
  }

  return parts;
}

/**
 * Typing indicator component
 * Shows animated dots while waiting for response
 * @returns {JSX.Element} Typing indicator
 */
function TypingIndicator() {
  return (
    <div className={styles.typingIndicator}>
      <span></span>
      <span></span>
      <span></span>
    </div>
  );
}

/**
 * Chat panel component
 * Displays conversation history and input for AI assistant
 * @param {Object} props - Component props
 * @param {Array} props.messages - Message history
 * @param {Function} props.onSendMessage - Callback to send message
 * @param {Function} props.onClearHistory - Callback to clear history
 * @param {Function} props.onStopStreaming - Callback to stop streaming
 * @param {boolean} props.isLoading - Whether waiting for response
 * @param {string} props.error - Error message if any
 * @param {boolean} props.isConfigured - Whether API is configured
 * @param {Function} props.onNavigateSettings - Navigate to settings
 * @param {Function} props.onClose - Callback to close panel
 * @param {boolean} props.detailPanelOpen - Whether detail panel is open
 * @param {number} props.width - Panel width in pixels
 * @param {Function} props.onWidthChange - Callback to update width
 * @returns {JSX.Element} Chat panel
 */
export default function ChatPanel({
  messages,
  onSendMessage,
  onClearHistory,
  onStopStreaming,
  isLoading,
  error,
  isConfigured,
  onNavigateSettings,
  onClose,
  detailPanelOpen,
  selectedBRDPs = [],
  onDeselectBrdp,
  width = 340,
  onWidthChange,
}) {
  const { brdps, updateBRDP } = useBRDPContext();
  const [input, setInput] = useState('');
  const [isResizing, setIsResizing] = useState(false);
  const [activeContext, setActiveContext] = useState(selectedBRDPs);
  const [appliedSuggestions, setAppliedSuggestions] = useState({});
  const messagesEndRef = useRef(null);
  const textareaRef = useRef(null);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Focus input after response arrives
  useEffect(() => {
    if (!isLoading && messages.length > 0) {
      textareaRef.current?.focus();
    }
  }, [isLoading, messages.length]);

  // Update active context when selectedBRDPs changes
  useEffect(() => {
    setActiveContext(selectedBRDPs);
  }, [selectedBRDPs]);

  // Handle resize
  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e) => {
      const newWidth = window.innerWidth - e.clientX;
      const MIN_WIDTH = 280;
      const MAX_WIDTH = 600;

      if (newWidth >= MIN_WIDTH && newWidth <= MAX_WIDTH) {
        onWidthChange?.(newWidth);
      }
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing, onWidthChange]);

  /**
   * Handle send button click
   */
  const handleSend = () => {
    if (input.trim() && !isLoading) {
      onSendMessage(input);
      setInput('');
    }
  };

  /**
   * Handle key press in textarea
   * Enter sends, Shift+Enter creates new line
   */
  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  /**
   * Handle applying a suggestion to the first selected BRDP
   */
  const handleApplySuggestion = (field, content) => {
    if (!activeContext || activeContext.length === 0) {
      // Show warning message to user
      alert('Please select a BRDP first to apply this suggestion');
      return;
    }

    const targetBrdp = activeContext[0];
    updateBRDP(targetBrdp.id, { [field]: content });

    // Mark suggestion as applied
    const suggestionKey = `${field}-${content.substring(0, 20)}`;
    setAppliedSuggestions(prev => ({
      ...prev,
      [suggestionKey]: true,
    }));
  };

  return (
    <div
      className={`${styles.panel} ${detailPanelOpen ? styles.withDetail : ''}`}
      style={{ width: `${width}px` }}
    >
      {/* Resize Handle */}
      <div
        className={styles.resizeHandle}
        onMouseDown={() => setIsResizing(true)}
        title="Drag to resize panel"
      />

      {/* Header */}
      <div className={styles.header}>
        <h3 className={styles.title}>BRDP Assistant</h3>
        <button
          onClick={onClose}
          className={styles.closeBtn}
          aria-label="Close chat panel"
          title="Close"
        >
          ✕
        </button>
      </div>

      {/* Generate Button */}
      {/* Messages Area */}
      <div className={styles.messagesContainer}>
        {!isConfigured ? (
          <div className={styles.configBanner}>
            <p className={styles.bannerText}>
              Configure your API key in Settings to enable AI features
            </p>
            <button
              onClick={onNavigateSettings}
              className={styles.settingsLink}
            >
              Go to Settings
            </button>
          </div>
        ) : messages.length === 0 ? (
          <div className={styles.emptyState}>
            <p className={styles.emptyText}>
              Start a conversation about your BRDP records
            </p>
          </div>
        ) : (
          <>
            {messages.map((message, idx) => {
              const isLastMessage = idx === messages.length - 1;
              const isStreamingLastMessage = isLastMessage && isLoading && message.role === 'assistant';
              return (
                <div
                  key={idx}
                  className={`${styles.message} ${styles[message.role]}`}
                >
                  {message.role === 'assistant' ? (
                    <div className={styles.markdownContent}>
                      {parseSuggestions(message.content).map((part, partIdx) => (
                        part.type === 'markdown' ? (
                          <div key={partIdx}>
                            <ReactMarkdown>{part.content}</ReactMarkdown>
                          </div>
                        ) : (
                          <div key={partIdx} className={styles.suggestionBox}>
                            <div className={styles.suggestionLabel}>
                              {part.field === 'proposal' ? 'Suggested Proposal:' : 'Suggested Comment:'}
                            </div>
                            <div className={styles.suggestionText}>
                              {part.content}
                            </div>
                            {(() => {
                              const suggestionKey = `${part.field}-${part.content.substring(0, 20)}`;
                              const isApplied = appliedSuggestions[suggestionKey];
                              return isApplied ? (
                                <div className={styles.appliedIndicator}>
                                  ✓ Applied
                                </div>
                              ) : (
                                <button
                                  className={styles.applySuggestionBtn}
                                  onClick={() => handleApplySuggestion(part.field, part.content)}
                                  disabled={!activeContext || activeContext.length === 0}
                                >
                                  Apply
                                </button>
                              );
                            })()}
                          </div>
                        )
                      ))}
                      {isStreamingLastMessage && <TypingDots />}
                    </div>
                  ) : (
                    message.content
                  )}
                </div>
              );
            })}
          </>
        )}
        {error && (
          <div className={styles.errorMessage}>
            {error}
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      {isConfigured && (
        <div className={styles.inputContainer}>
          {activeContext && activeContext.length > 0 && (
            <div className={styles.contextPill}>
              <span className={styles.contextText}>
                📌 Context: {activeContext.length === 1 ? activeContext[0].id : `${activeContext.length} BRDPs selected`}
              </span>
              <button
                className={styles.contextClear}
                onClick={() => {
                  setActiveContext([]);
                  onDeselectBrdp?.();
                }}
                aria-label="Clear context"
                title="Clear context"
              >
                ✕
              </button>
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder="Ask about S1000D, DITA, or this BRDP..."
            disabled={isLoading}
            className={styles.textarea}
            rows="3"
          />
          <div className={styles.inputActions}>
            {isLoading ? (
              <button
                onClick={onStopStreaming}
                className={styles.sendBtn}
                style={{ background: '#ef4444' }}
                title="Stop streaming"
              >
                Stop
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={!input.trim()}
                className={styles.sendBtn}
              >
                Send
              </button>
            )}
            <button
              onClick={onClearHistory}
              disabled={isLoading || messages.length === 0}
              className={styles.clearBtn}
            >
              Clear
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
