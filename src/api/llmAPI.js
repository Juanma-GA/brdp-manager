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
  // construction (buildRequestBody) is untouched.
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
