import { authFetch } from '../services/apiClient.js';
import { ApiError, apiErrorFromResponse, networkError } from '../services/apiErrors.js';
import i18n from '../i18n/index.js';
import { LLM_TRUNCATED, isTruncatedAnswer, truncatedAnswerError } from './llmTruncation.js';
import { LLM_CANCELLED, sendWithRateLimitRetry } from './llmRateLimit.js';

export { LLM_CANCELLED };

// The output limit of an answer, unless the use sets its own (the rule
// test's examples need more: src/prompts/shared.js RULE_TEST_MAX_TOKENS).
const DEFAULT_MAX_TOKENS = 4000;

/**
 * Build request body based on provider. The model is never sent: the
 * server sets it from .env (AACF 1, Part 5 -- the proxy accepts only
 * messages, temperature and max_tokens and refuses anything else).
 * @param {string} provider - Provider name
 * @param {Array} messages - Message history
 * @param {string} systemPrompt - System prompt
 * @param {number} temperature - Temperature parameter for sampling
 * @returns {Object} Request body
 */
function buildRequestBody(provider, messages, systemPrompt, temperature, maxTokens = DEFAULT_MAX_TOKENS) {
  const baseBody = {
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
 * @param {number} [options.maxTokens] - Output limit of the answer
 * @param {Function} [options.shouldCancel] - () => true once the operation
 *   was cancelled: ends a wait for the per-minute limit with LLM_CANCELLED
 *   and sends nothing more (Protecciones 2a, llmRateLimit.js)
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
  const { temperature = 1, maxTokens = DEFAULT_MAX_TOKENS, shouldCancel } = options;

  if (!modelName || !provider) {
    throw new Error(i18n.t('errors.llmMissingModel'));
  }

  // v2: the backend resolves the real provider endpoint + API key from its
  // own server-side config (docs/v2 §4.2 -- closes the SSRF finding by
  // construction, since targetEndpoint/apiKey never travel from the
  // client). This is the ONLY thing that changed here versus v1 -- prompt
  // construction (buildRequestBody) is untouched.
  const payload = buildRequestBody(provider, messages, systemPrompt, temperature, maxTokens);

  // Over the per-minute limit of AI requests the request waits and is sent
  // again by itself; over the per-day limit its error is thrown, with the
  // limit and when to try again (Protecciones 2a). The only place in the
  // app that sends to the LLM, so every use gets the same behaviour.
  return sendWithRateLimitRetry(() => sendOnce(provider, payload), { shouldCancel });
}

async function sendOnce(provider, payload) {
  try {
    let response;
    try {
      response = await authFetch('/api/llm-proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload }),
      });
    } catch (err) {
      throw networkError(err);
    }

    // The server's reason as a sentence (a parameter it refuses, the
    // provider unavailable, ...), with its reference -- never its text.
    if (!response.ok) throw await apiErrorFromResponse(response);

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
    if (error.code === LLM_TRUNCATED || error instanceof ApiError) {
      throw error;
    }
    throw new Error(i18n.t('errors.network'), { cause: error });
  }
}
