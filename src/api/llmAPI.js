import { authFetch } from '../services/apiClient';

/**
 * Build request body based on provider
 * @param {string} provider - Provider name
 * @param {string} modelName - Model name
 * @param {Array} messages - Message history
 * @param {string} systemPrompt - System prompt
 * @param {number} temperature - Temperature parameter for sampling
 * @returns {Object} Request body
 */
function buildRequestBody(provider, modelName, messages, systemPrompt, temperature) {
  const baseBody = {
    model: modelName,
    max_tokens: 4000,
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
  const { temperature = 1 } = options;

  if (!modelName || !provider) {
    throw new Error('Missing model configuration.');
  }

  // v2: the backend resolves the real provider endpoint + API key from its
  // own server-side config (docs/v2 §4.2 -- closes the SSRF finding by
  // construction, since targetEndpoint/apiKey never travel from the
  // client). This is the ONLY thing that changed here versus v1 -- prompt
  // construction (buildRequestBody/buildSystemPrompt) is untouched.
  const payload = buildRequestBody(provider, modelName, messages, systemPrompt, temperature);

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
    if (error.message.includes('Invalid API key') ||
        error.message.includes('Connection error')) {
      throw error;
    }
    throw new Error('Connection error. Please try again.');
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
            } catch (e) {
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
            } catch (e) {
              // Skip parsing errors
            }
          }
        }
      }
    }

    return fullContent;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Request cancelled by user.');
    }
    if (error.message.includes('Invalid API key') ||
        error.message.includes('Connection error')) {
      throw error;
    }
    throw new Error('Connection error. Please try again.');
  }
}

/**
 * Export system prompt builder for external use
 */
export { buildSystemPrompt };
