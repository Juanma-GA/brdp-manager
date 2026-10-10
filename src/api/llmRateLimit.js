/**
 * Waiting out the per-user limit on AI requests (Protecciones 2a).
 *
 * The server refuses a chat request over a user's limit with a 429
 * llm_rate_limited {limit, window: "minute" | "day", retry_after_seconds}
 * (backend app/services/llm_usage.py). Over the per-MINUTE limit, the
 * request is sent again by itself after the wait the server gives, up to
 * RATE_LIMIT_MAX_RETRIES times, so the operation in progress (AI Extract
 * writing texts, a rule test) carries on instead of failing. Over the
 * per-DAY limit, or once the retries are spent, the error is thrown as it
 * is: its sentence says the limit and when to try again.
 *
 * `shouldCancel()` is checked before and during each wait: when the user
 * cancels the operation (Stop, close, another BRDP), the wait ends at once
 * with LLM_CANCELLED and no request is sent after it. A request already
 * sent is never cut.
 *
 * Pure (the request itself and the clock are injected), so it runs in Node.
 */
export const LLM_CANCELLED = 'LLM_CANCELLED';

// ~5 minutes at most: each per-minute wait is under 60 s.
export const RATE_LIMIT_MAX_RETRIES = 5;

// How often a wait checks whether the operation was cancelled.
const CANCEL_POLL_MS = 250;

export function llmCancelledError() {
  const err = new Error('The AI request was cancelled.');
  err.code = LLM_CANCELLED;
  return err;
}

export function isRateLimitedPerMinute(err) {
  return err?.code === 'llm_rate_limited' && err?.detail?.window === 'minute';
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitOrCancel(seconds, shouldCancel, sleep) {
  let left = Math.max(1, Number(seconds) || 1) * 1000;
  while (left > 0) {
    if (shouldCancel?.()) throw llmCancelledError();
    const step = Math.min(CANCEL_POLL_MS, left);
    await sleep(step);
    left -= step;
  }
  if (shouldCancel?.()) throw llmCancelledError();
}

/**
 * Runs `send()` (one request) and, while it fails with the per-minute
 * limit, waits and runs it again. `onWait({seconds, attempt})` is told
 * before each wait.
 */
export async function sendWithRateLimitRetry(
  send,
  { shouldCancel, onWait, sleep = realSleep, maxRetries = RATE_LIMIT_MAX_RETRIES } = {}
) {
  for (let attempt = 0; ; attempt += 1) {
    if (shouldCancel?.()) throw llmCancelledError();
    try {
      return await send();
    } catch (err) {
      if (!isRateLimitedPerMinute(err) || attempt >= maxRetries) throw err;
      const seconds = err.detail.retry_after_seconds;
      onWait?.({ seconds, attempt: attempt + 1 });
      await waitOrCancel(seconds, shouldCancel, sleep);
    }
  }
}
