import { authFetch } from '../services/apiClient.js';
import { LLM_TRUNCATED, isTruncatedAnswer, truncatedAnswerError } from './llmTruncation.js';

// The output limit of an answer, unless the use sets its own (the rule
// test's examples need more: src/prompts/shared.js RULE_TEST_MAX_TOKENS).
export const DEFAULT_MAX_TOKENS = 4000;

/**
 * Build request body based on provider
 * @param {string} provider - Provider name
 * @param {string} modelName - Model name
 * @param {Array} messages - Message history
 * @param {string} systemPrompt - System prompt
 * @param {number} temperature - Temperature parameter for sampling
 * @returns {Object} Request body
 */
function buildRequestBody(provider, modelName, messages, systemPrompt, temperature, maxTokens = DEFAULT_MAX_TOKENS) {
  const baseBody = {
    model: modelName,
    max_tokens: maxTokens,
    temperature,
  };

  if (provider === 'Anthropic') {
    return {
      ...baseBody,
      system: systemPrompt,
      messages,
    };
  }

  // OpenAI and Custom providers include system in messages
  return {
    ...baseBody,
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages,
    ],
  };
}

/**
 * Build system prompt with optional BRDP context
 * @param {Object} [selectedBrdp] - Selected BRDP record
 * @returns {string} System prompt
 */
function buildSystemPrompt(selectedBrdp) {
  const basePrompt = `You are an S1000D / DITA and BRDP expert assistant.
You help users understand business rules, validate decisions,
and answer questions about S1000D and DITA, and technical
publications. If a BRDP record is provided, use it as
context for your answers.`;

  if (!selectedBrdp) {
    return basePrompt;
  }

  return `${basePrompt}

Current BRDP context:
ID: ${selectedBrdp.id}
Definition: ${selectedBrdp.definition}
Proposal: ${selectedBrdp.proposal}
Validation: ${selectedBrdp.validation}
Comment: ${selectedBrdp.comment}`;
}

/**
 * Send a message to the configured LLM provider
 * @param {Array} messages - Message history
 * @param {string} apiKey - API key
 * @param {string} modelName - Model name
 * @param {string} provider - LLM provider
 * @param {string} [systemPrompt=""] - System prompt (optional, defaults to empty string)
 * @param {Object} [options={}] - Optional parameters
 * @param {number} [options.temperature=1] - Temperature parameter for sampling
 * @param {string} [options.customEndpoint=""] - Custom endpoint override
 * @returns {Promise<Object>} Response from LLM
 * @throws {Error} If the request fails
 */
export async function sendMessage(
  messages,
  apiKey,
  modelName,
  provider,
  systemPrompt = "",
  options = {}
) {
  const { temperature = 1, maxTokens = DEFAULT_MAX_TOKENS } = options;

  if (!modelName || !provider) {
    throw new Error('Missing model configuration.');
  }

  // v2: the backend resolves the real provider endpoint + API key from its
  // own server-side config (docs/v2 §4.2 -- closes the SSRF finding by
  // construction, since targetEndpoint/apiKey never travel from the
  // client). This is the ONLY thing that changed here versus v1 -- prompt
  // construction (buildRequestBody/buildSystemPrompt) is untouched.
  const payload = buildRequestBody(provider, modelName, messages, systemPrompt, temperature, maxTokens);

  try {
    const response = await authFetch('/api/llm-proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload }),
    });

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error('Invalid API key. Please check your Settings.');
      }
      throw new Error('Connection error. Please try again.');
    }

    const data = await response.json();
    if (isTruncatedAnswer(provider, data)) throw truncatedAnswerError();

    // Extract message content based on provider response format
    if (provider === 'Anthropic') {
      return {
        role: 'assistant',
        content: data.content[0].text,
      };
    }

    // OpenAI and Custom
    return {
      role: 'assistant',
      content: data.choices[0].message.content,
    };
  } catch (error) {
    if (error.code === LLM_TRUNCATED ||
        error.message.includes('Invalid API key') ||
        error.message.includes('Connection error')) {
      throw error;
    }
    throw new Error('Connection error. Please try again.', { cause: error });
  }
}

/**
 * Stream a message from the configured LLM provider
 * @param {Array} messages - Message history
 * @param {string} apiKey - API key
 * @param {string} modelName - Model name
 * @param {string} provider - LLM provider
 * @param {string} [systemPrompt=""] - System prompt
 * @param {Function} onChunk - Callback for each token received
 * @param {AbortController} abortController - Controller to cancel request
 * @param {Object} [options={}] - Optional parameters
 * @param {number} [options.temperature=1] - Temperature parameter for sampling
 * @param {string} [options.customEndpoint=""] - Custom endpoint override
 * @returns {Promise<string>} Complete response text
 * @throws {Error} If the request fails
 */
export async function sendMessageStream(
  messages,
  apiKey,
  modelName,
  provider,
  systemPrompt = "",
  onChunk,
  abortController,
  options = {}
) {
  const { temperature = 1 } = options;

  if (!modelName || !provider) {
    throw new Error('Missing model configuration.');
  }

  const payload = buildRequestBody(provider, modelName, messages, systemPrompt, temperature);

  try {
    const response = await authFetch('/api/llm-proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: { ...payload, stream: true } }),
      signal: abortController?.signal,
    });

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error('Invalid API key. Please check your Settings.');
      }
      throw new Error('Connection error. Please try again.');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (!line.trim()) continue;

        // Parse streaming response based on provider
        if (provider === 'Anthropic') {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.type === 'content_block_delta' && data.delta?.type === 'text_delta') {
                const text = data.delta.text;
                fullContent += text;
                onChunk?.(text);
              }
            } catch {
              // Skip parsing errors
            }
          }
        } else {
          // OpenAI and Custom providers
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') continue;

            try {
              const parsed = JSON.parse(data);
              const content = parsed.choices?.[0]?.delta?.content;
              if (content) {
                fullContent += content;
                onChunk?.(content);
              }
            } catch {
              // Skip parsing errors
            }
          }
        }
      }
    }

    return fullContent;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Request cancelled by user.', { cause: error });
    }
    if (error.message.includes('Invalid API key') ||
        error.message.includes('Connection error')) {
      throw error;
    }
    throw new Error('Connection error. Please try again.', { cause: error });
  }
}

/**
 * Export system prompt builder for external use
 */
export { buildSystemPrompt };
