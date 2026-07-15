import { useState, useCallback, useRef } from 'react';
import { sendMessage, sendMessageStream } from '../api/llmAPI';
import { useBRDPContext } from '../context/BRDPContext';

/**
 * Build a compact summary of the BRDP dataset
 * @param {Array} brdps - Array of BRDP records
 * @returns {string} Summary with total, breakdown, and compact JSON index
 */
function buildDatasetSummary(brdps) {
  if (!brdps || brdps.length === 0) {
    return 'No hay datos BRDP disponibles.';
  }

  // Calculate total and breakdown by validation status
  const breakdown = {
    Validated: 0,
    Refused: 0,
    Pending: 0,
  };

  brdps.forEach((brdp) => {
    if (breakdown.hasOwnProperty(brdp.validation)) {
      breakdown[brdp.validation]++;
    }
  });

  // Build compact JSON index with only: id, title (max 40 chars), and status
  const compactIndex = brdps.map((brdp) => ({
    id: brdp.id,
    title: (brdp.title || '').slice(0, 40),
    status: brdp.validation,
  }));

  // Format the summary string
  const breakdownStr = Object.entries(breakdown)
    .map(([status, count]) => `${status}: ${count}`)
    .join(', ');

  return `Total de BRDPs: ${brdps.length}
Desglose: ${breakdownStr}

Índice compacto:
${JSON.stringify(compactIndex, null, 0)}`;
}

/**
 * Build enhanced system prompt with dataset context
 * @param {Array} brdps - All BRDP records from context
 * @param {Array} [selectedBRDPs] - Currently selected BRDPs
 * @returns {string} Enhanced system prompt with dataset and optional BRDP context
 */
function buildEnhancedSystemPrompt(brdps, selectedBRDPs = []) {
  const basePrompt = `You are an S1000D / DITA and BRDP expert assistant.
You help users understand business rules, validate decisions,
and answer questions about S1000D, DITA, and technical publications.
RESTRICTION: Never change, suggest changing, or help justify changing the validation status (Validated/Refused/Pending) of any BRDP. If asked, respond in 2 sentences maximum: say you cannot do this through chat, and offer to analyse the BRDP content instead.`;

  const datasetSummary = buildDatasetSummary(brdps);

  if (!selectedBRDPs || selectedBRDPs.length === 0) {
    return `${basePrompt}

BRDP Dataset Context:
${datasetSummary}

Use the complete dataset above to answer questions about business rules, validate proposals, and provide insights across all BRDP records.`;
  }

  // If BRDPs are selected, include their full details
  return `${basePrompt}

BRDP Dataset Context:
${datasetSummary}

Current BRDP Focus (selected for detailed analysis):
${JSON.stringify(selectedBRDPs, null, 2)}

Provide answers focusing on the selected BRDP${selectedBRDPs.length > 1 ? 's' : ''} while leveraging the complete dataset for comparison and validation.

SUGGESTION FORMAT INSTRUCTIONS:
If the user asks you to improve, rewrite, or suggest a new version of the Proposal or Comment field, respond with your explanation followed by a special block in this exact format:

For proposal field:
[SUGGESTION:proposal]
Your suggested text here
[/SUGGESTION]

For comment field:
[SUGGESTION:comment]
Your suggested text here
[/SUGGESTION]

Always include the suggestion block at the end of your response when rewriting a field.`;
}


/**
 * Custom hook for managing chat conversation
 * Handles message history and LLM communication
 * @param {Object} options - Hook options
 * @param {Object} options.apiKey - API key from useAPIKey
 * @param {string} options.modelName - Model name from useAPIKey
 * @param {string} options.provider - Provider from useAPIKey
 * @param {Array} [options.selectedBRDPs] - Currently selected BRDPs
 * @returns {Object} Chat management object
 * @property {Array} messages - Conversation history
 * @property {Function} sendUserMessage - Send a message and get response
 * @property {Function} clearHistory - Clear conversation
 * @property {boolean} isLoading - Whether waiting for response
 * @property {string|null} error - Error message if any
 */
export function useChat({ apiKey, modelName, provider, customEndpoint = "", selectedBRDPs = [] }) {
  const [messages, setMessages] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const { brdps } = useBRDPContext();
  const abortControllerRef = useRef(null);

  /**
   * Send a user message and get AI response with streaming
   * @param {string} content - User message content
   */
  const sendUserMessage = useCallback(
    async (content) => {
      if (!content.trim()) return;

      // Frontend guard: block any attempt to change validation status
      const validationTriggers = [
        'change status', 'cambiar estado', 'cambiar validación', 'cambiar validacion',
        'cambia estado', 'cambia validación', 'cambia validacion',
        'set status', 'as validated', 'as refused', 'as pending',
        'to validated', 'to refused', 'to pending',
        'a validated', 'a refused', 'a pending',
        'update status', 'actualizar estado', 'actualiza estado', 'set validated', 'set refused',
        'validate this', 'valida esto', 'valídate', 'validate all', 'valida todos',
        'status to validated', 'status to refused', 'status to pending',
        'estado a validated', 'estado a refused', 'estado a pending',
        'ponlo como', 'ponla como', 'marcalo como', 'márcalo como', 'márcala como',
        'aprueba este', 'aprueba esta', 'aprueba los', 'aprueba las',
        'marca como validado', 'marca como rechazado', 'marca como pendiente',
        'pasar a validado', 'pasar a rechazado', 'pasar a pendiente',
        'pasa a validado', 'pasa a rechazado', 'pasa a pendiente',
      ];
      const lowerContent = content.toLowerCase();
      const isValidationRequest = validationTriggers.some(trigger => lowerContent.includes(trigger));

      if (isValidationRequest) {
        const blockedMessage = {
          role: 'assistant',
          content: 'Changing the validation status of a BRDP is not something I can do through this chat — not for one, not for many.\n\nValidation is an individual human review process that must be performed through the UI controls for each BRDP separately. This ensures the quality and traceability of every decision.\n\nI can help you analyse the content of any BRDP — its definition, proposal, or comments — to support your review.',
        };
        setMessages(prev => [...prev, { role: 'user', content }, blockedMessage]);
        return;
      }

      // Add user message to history
      const userMessage = { role: 'user', content };
      const updatedMessages = [...messages, userMessage];
      setMessages(updatedMessages);
      setIsLoading(true);
      setError(null);

      // Create abort controller for this request
      abortControllerRef.current = new AbortController();

      try {
        // Build system prompt with dataset and BRDP context
        const systemPrompt = buildEnhancedSystemPrompt(brdps, selectedBRDPs);

        // Initialize assistant message with empty content
        let assistantMessage = { role: 'assistant', content: '' };
        setMessages([...updatedMessages, assistantMessage]);

        // Stream the response
        const completeContent = await sendMessageStream(
          updatedMessages,
          apiKey,
          modelName,
          provider,
          systemPrompt,
          (chunk) => {
            // Update assistant message with partial content
            assistantMessage.content += chunk;
            setMessages([...updatedMessages, { ...assistantMessage }]);
          },
          abortControllerRef.current,
          {
            customEndpoint,
          }
        );

        // Final update with complete content
        assistantMessage.content = completeContent;
        setMessages([...updatedMessages, { ...assistantMessage }]);
      } catch (err) {
        setError(err.message);
      } finally {
        setIsLoading(false);
        abortControllerRef.current = null;
      }
    },
    [messages, apiKey, modelName, provider, customEndpoint, selectedBRDPs, brdps]
  );

  /**
   * Stop the current streaming request
   */
  const stopStreaming = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      setIsLoading(false);
    }
  }, []);

  /**
   * Clear conversation history
   */
  const clearHistory = useCallback(() => {
    setMessages([]);
    setError(null);
  }, []);

  return {
    messages,
    sendUserMessage,
    clearHistory,
    stopStreaming,
    isLoading,
    error,
  };
}
