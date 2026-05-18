/**
 * Build headers based on LLM provider
 * @param {string} provider - Provider name ('Anthropic', 'OpenAI', 'Custom')
 * @param {string} apiKey - API key
 * @returns {Object} Headers object
 */
function buildHeaders(provider, apiKey) {
  const baseHeaders = {
    'content-type': 'application/json',
  };

  if (provider === 'Anthropic') {
    return {
      ...baseHeaders,
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    };
  }

  // OpenAI and Custom providers use Bearer token
  return {
    ...baseHeaders,
    'Authorization': `Bearer ${apiKey}`,
  };
}

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
  const { temperature = 1, customEndpoint = "" } = options;

  if (!apiKey || !modelName || !provider) {
    throw new Error('Missing API configuration. Please configure in Settings.');
  }

  let endpoint = 'https://api.anthropic.com/v1/messages';
  if (provider === 'OpenAI') {
    endpoint = 'https://api.openai.com/v1/chat/completions';
  }
  if (provider === 'Mistral') {
    endpoint = 'https://api.mistral.ai/v1/chat/completions';
  }
  if (provider === 'Custom') {
    endpoint = 'https://api.example.com/v1/messages';
  }

  // In production, route all calls through the local Express proxy
  // In development, use Vite proxy only for custom endpoints to avoid CORS
  if (import.meta.env.PROD) {
    endpoint = '/api/proxy';
  } else if (import.meta.env.DEV && customEndpoint && customEndpoint.trim()) {
    endpoint = '/mistral-proxy/chat/completions';
  }

  const headers = buildHeaders(provider, apiKey);
  const body = buildRequestBody(provider, modelName, messages, systemPrompt, temperature);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
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
  const { temperature = 1, customEndpoint = "" } = options;

  if (!apiKey || !modelName || !provider) {
    throw new Error('Missing API configuration. Please configure in Settings.');
  }

  let endpoint = 'https://api.anthropic.com/v1/messages';
  if (provider === 'OpenAI') {
    endpoint = 'https://api.openai.com/v1/chat/completions';
  }
  if (provider === 'Mistral') {
    endpoint = 'https://api.mistral.ai/v1/chat/completions';
  }
  if (provider === 'Custom') {
    endpoint = 'https://api.example.com/v1/messages';
  }

  // In production, route all calls through the local Express proxy
  // In development, use Vite proxy only for custom endpoints to avoid CORS
  if (import.meta.env.PROD) {
    endpoint = '/api/proxy';
  } else if (import.meta.env.DEV && customEndpoint && customEndpoint.trim()) {
    endpoint = '/mistral-proxy/chat/completions';
  }

  const headers = buildHeaders(provider, apiKey);
  const body = buildRequestBody(provider, modelName, messages, systemPrompt, temperature);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...body, stream: true }),
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
