// Respuestas cortadas por el límite de tokens: an answer the provider cut
// at max_tokens is never passed on as if it were whole (HR7) -- llmAPI.js
// throws this error, so the caller can say "the AI's answer was cut off by
// its length" instead of reporting the broken text (e.g. "not valid JSON").
// OpenAI-compatible providers (Mistral, Qwen, OpenAI) say so with
// finish_reason "length" (Mistral also "model_length"); Anthropic with
// stop_reason "max_tokens". Pure (the eval harness and the Node tests
// import it; llmAPI.js pulls in the browser's API client).
import i18n from '../i18n/index.js';

export const LLM_TRUNCATED = 'llm_truncated';

export function isTruncatedAnswer(provider, data) {
  if (provider === 'Anthropic') return data?.stop_reason === 'max_tokens';
  const reason = data?.choices?.[0]?.finish_reason;
  return reason === 'length' || reason === 'model_length';
}

export function truncatedAnswerError() {
  // AACF 3, Part 3: shown as is by Ask and Suggest, so in the interface
  // language; callers that need to tell it apart use `code`.
  const error = new Error(i18n.t('errors.llmTruncated'));
  error.code = LLM_TRUNCATED;
  return error;
}
