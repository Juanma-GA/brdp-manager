// The request body of one chat call and the text of its answer, by
// provider. Pure (no browser API client), so the Node scripts that run the
// app's own flows against the backend send exactly what the app sends
// (scripts/run-project-rule-tests.mjs). llmAPI.js uses the same functions.

// The output limit of an answer, unless the use sets its own (the rule
// test's examples need more: src/prompts/shared.js RULE_TEST_MAX_TOKENS).
export const DEFAULT_MAX_TOKENS = 4000;

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
export function buildRequestBody(provider, messages, systemPrompt, temperature, maxTokens = DEFAULT_MAX_TOKENS) {
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

// The text of an answer, by provider's response format.
export function answerContent(provider, data) {
  if (provider === 'Anthropic') return data.content[0].text;
  // OpenAI and Custom
  return data.choices[0].message.content;
}
