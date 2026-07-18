import { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { useBRDPContext } from '../context/BRDPContext';
import { getApproval, proposeApproval } from '../api/approvals';
import TypingDots from './TypingDots';
import styles from './ChatPanel.module.css';

// Same format-code -> friendly-label map as RuleApprovalCell.jsx (see that
// file's FORMAT_LABELS) -- kept local since it's a 5-entry display lookup,
// not shared app logic.
const FORMAT_LABELS = {
  'BREX-3.0.1': 'BREX 3.0.1',
  'BREX-4.1': 'BREX 4.1',
  'BREX-4.2': 'BREX 4.2',
  'SCH-S1000D': 'Schematron S1000D',
  'SCH-DITA': 'Schematron DITA',
};

const MODES = [
  { id: 'generic', label: 'Generic Questions' },
  { id: 'specific', label: 'Specific BRDP Question' },
  { id: 'suggest-definition', label: 'Suggest Definition' },
  { id: 'suggest-proposal', label: 'Suggest Proposal' },
  { id: 'suggest-rule', label: 'Suggest Rule' },
];

const SUGGESTION_LABELS = {
  definition: 'Suggested Definition:',
  proposal: 'Suggested Proposal:',
  comment: 'Suggested Comment:',
  rule: 'Suggested Rule:',
};

const MODE_PLACEHOLDERS = {
  'generic': 'Ask about S1000D, DITA, or this BRDP...',
  'specific': 'Ask a question about the selected BRDP(s)...',
  'suggest-definition': 'Ask for a new definition, or just hit Send...',
  'suggest-proposal': 'Ask for a new proposal, or just hit Send...',
  'suggest-rule': 'Optional note (not sent to the generator) — hit Send to generate the rule...',
};

/**
 * Determine why sending is blocked for the given mode/selection state, or
 * null if allowed. Each mode has its own selection requirement (see
 * CLAUDE.md's BRDP Assistant modes design) enforced here, before the
 * message ever reaches useChat.
 * @param {string} mode
 * @param {number} count - selectedBRDPs.length
 * @param {string} primaryFormat
 * @returns {string|null}
 */
function getBlockReason(mode, count, primaryFormat) {
  if (mode === 'specific' && count === 0) {
    return 'Select at least one BRDP to ask a specific question.';
  }
  if ((mode === 'suggest-definition' || mode === 'suggest-proposal' || mode === 'suggest-rule') && count !== 1) {
    return count === 0
      ? 'Select exactly one BRDP for this mode.'
      : 'This mode works with exactly one BRDP — you have multiple selected.';
  }
  if (mode === 'suggest-rule' && !primaryFormat) {
    return 'Set a Primary Format in Settings before suggesting a rule.';
  }
  return null;
}

/**
 * Parse message content for [SUGGESTION:field]...[/SUGGESTION] blocks
 * @param {string} content - Message content
 * @returns {Array} Array of {type, content, field} objects
 */
function parseSuggestions(content) {
  const parts = [];
  const suggestionRegex = /\[SUGGESTION:(proposal|comment|definition|rule)\]([\s\S]*?)\[\/SUGGESTION\]/g;
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
 * @param {string} props.primaryFormat - Project's active rule format, required by Suggest Rule mode
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
  primaryFormat = '',
  onDeselectBrdp,
  width = 340,
  onWidthChange,
}) {
  const { brdps, updateBRDP, appendHistoryEntry } = useBRDPContext();
  const [input, setInput] = useState('');
  const [mode, setMode] = useState('generic');
  const [isResizing, setIsResizing] = useState(false);
  const [activeContext, setActiveContext] = useState(selectedBRDPs);
  const [appliedSuggestions, setAppliedSuggestions] = useState({});
  const [ruleApplyBusy, setRuleApplyBusy] = useState({});
  const messagesEndRef = useRef(null);
  const textareaRef = useRef(null);
  const blockReason = getBlockReason(mode, activeContext.length, primaryFormat);

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
    if (input.trim() && !isLoading && !blockReason) {
      onSendMessage(input, mode);
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
   * Handle applying a suggestion to the first selected BRDP. A 'rule'
   * suggestion (from Suggest Rule mode) doesn't update a BRDP field -- it
   * saves the XML fragment as a pending_review candidate in rule_approvals
   * (proposeApproval, source='llm'), reviewable via the existing
   * Approve/Discard/Edit UI in DetailPanel/BRDPTable (see RuleApprovalCell).
   */
  const handleApplySuggestion = async (field, content) => {
    if (!activeContext || activeContext.length === 0) {
      // Show warning message to user
      alert('Please select a BRDP first to apply this suggestion');
      return;
    }

    const targetBrdp = activeContext[0];
    const suggestionKey = `${field}-${content.substring(0, 20)}`;

    if (field === 'rule') {
      setRuleApplyBusy(prev => ({ ...prev, [suggestionKey]: true }));
      try {
        const prevApproval = await getApproval(targetBrdp.id, primaryFormat);
        await proposeApproval(targetBrdp.id, primaryFormat, content, 'llm');
        setAppliedSuggestions(prev => ({ ...prev, [suggestionKey]: true }));
        const oldLabel = prevApproval ? (prevApproval.status === 'approved' ? 'Approved' : 'Pending review') : '';
        appendHistoryEntry(targetBrdp.id, `rule_approval (${FORMAT_LABELS[primaryFormat] || primaryFormat})`, oldLabel, 'Proposed (LLM)');
      } finally {
        setRuleApplyBusy(prev => ({ ...prev, [suggestionKey]: false }));
      }
      return;
    }

    updateBRDP(targetBrdp.id, { [field]: content });
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
                              {SUGGESTION_LABELS[part.field] || 'Suggestion:'}
                            </div>
                            {part.field === 'rule' ? (
                              <pre className={styles.suggestionCode}>{part.content}</pre>
                            ) : (
                              <div className={styles.suggestionText}>
                                {part.content}
                              </div>
                            )}
                            {(() => {
                              const suggestionKey = `${part.field}-${part.content.substring(0, 20)}`;
                              const isApplied = appliedSuggestions[suggestionKey];
                              const isBusy = ruleApplyBusy[suggestionKey];
                              return isApplied ? (
                                <div className={styles.appliedIndicator}>
                                  ✓ Applied
                                </div>
                              ) : (
                                <button
                                  className={styles.applySuggestionBtn}
                                  onClick={() => handleApplySuggestion(part.field, part.content)}
                                  disabled={!activeContext || activeContext.length === 0 || isBusy}
                                >
                                  {isBusy ? 'Saving…' : 'Apply'}
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
          <div className={styles.modeSelector} role="radiogroup" aria-label="Assistant mode">
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={mode === m.id}
                className={`${styles.modeBtn} ${mode === m.id ? styles.modeBtnActive : ''}`}
                onClick={() => setMode(m.id)}
              >
                {m.label}
              </button>
            ))}
          </div>
          {blockReason && (
            <div className={styles.blockReason}>{blockReason}</div>
          )}
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
            placeholder={MODE_PLACEHOLDERS[mode]}
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
                disabled={!input.trim() || !!blockReason}
                className={styles.sendBtn}
                title={blockReason || undefined}
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
