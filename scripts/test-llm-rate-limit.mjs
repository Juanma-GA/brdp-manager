// Protecciones 2a, Part 2: waiting out the per-user limit on AI requests.
// - src/api/llmRateLimit.js: the per-minute 429 waits and retries (what
//   llmAPI.js's sendMessage uses for every AI request of the app), the
//   per-day 429 and the spent retries throw, cancelling ends a wait with
//   no request after it;
// - src/services/apiErrors.js: the EN/ES sentence of llm_rate_limited;
// - src/utils/ruleExtractDraft.js: a cancelled wait leaves the rows pending;
// - scripts/prompt-eval/session.mjs: the prompt eval waits the same way and
//   stops the pass on the per-day limit.
// Plain Node, the real modules and the real i18n; the clock is faked.
// Run: node scripts/test-llm-rate-limit.mjs
import i18n from '../src/i18n/index.js';
import { apiErrorFromResponse, describeErrorDetail, retryInText } from '../src/services/apiErrors.js';
import { LLM_CANCELLED, RATE_LIMIT_MAX_RETRIES, sendWithRateLimitRetry } from '../src/api/llmRateLimit.js';
import { draftCandidates } from '../src/utils/ruleExtractDraft.js';
import { createEvalClient, LlmLimitError, SessionLostError } from './prompt-eval/session.mjs';

let failures = 0;
let passes = 0;
function check(name, cond, detail) {
  if (cond) {
    passes += 1;
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail === undefined ? '' : ` -- ${JSON.stringify(detail)}`}`);
  }
}

const en = i18n.getFixedT('en');
const es = i18n.getFixedT('es');

function limited(window, retry, limit = 3) {
  return new Response(
    JSON.stringify({
      detail: { code: 'llm_rate_limited', limit, window, retry_after_seconds: retry, message: 'x' },
    }),
    { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': String(retry) } }
  );
}

function fakeClock() {
  const slept = [];
  return { slept, sleep: async (ms) => slept.push(ms), total: () => slept.reduce((a, b) => a + b, 0) };
}

// --- The sentence, EN/ES ----------------------------------------------------
check('retry in seconds', retryInText(45, en) === '45 s', retryInText(45, en));
check('retry in minutes (rounded up)', retryInText(61, en) === '2 min', retryInText(61, en));
check('retry in hours', retryInText(7200, en) === '2 h', retryInText(7200, en));
check('retry in hours and minutes', retryInText(7500, en) === '2 h 5 min', retryInText(7500, en));

const dayDetail = { code: 'llm_rate_limited', limit: 3000, window: 'day', retry_after_seconds: 7500, message: 'x' };
const minuteDetail = { code: 'llm_rate_limited', limit: 120, window: 'minute', retry_after_seconds: 12, message: 'x' };
check(
  'day sentence EN',
  describeErrorDetail(429, dayDetail, en) === 'You have reached the limit of 3000 AI requests per day. Try again in 2 h 5 min.',
  describeErrorDetail(429, dayDetail, en)
);
check(
  'day sentence ES',
  describeErrorDetail(429, dayDetail, es) === 'Has alcanzado el límite de 3000 peticiones a la IA por día. Vuelve a intentarlo en 2 h 5 min.',
  describeErrorDetail(429, dayDetail, es)
);
check(
  'minute sentence EN',
  describeErrorDetail(429, minuteDetail, en) === 'You have reached the limit of 120 AI requests per minute. Try again in 12 s.',
  describeErrorDetail(429, minuteDetail, en)
);
check(
  'minute sentence ES',
  describeErrorDetail(429, minuteDetail, es) === 'Has alcanzado el límite de 120 peticiones a la IA por minuto. Vuelve a intentarlo en 12 s.',
  describeErrorDetail(429, minuteDetail, es)
);

// --- Per minute: waits what the server says, then sends again ---------------
{
  const clock = fakeClock();
  const waits = [];
  let sent = 0;
  const result = await sendWithRateLimitRetry(
    async () => {
      sent += 1;
      if (sent <= 2) throw await apiErrorFromResponse(limited('minute', 7), en);
      return 'answer';
    },
    { sleep: clock.sleep, onWait: (w) => waits.push(w) }
  );
  check('minute: the operation ends well', result === 'answer', result);
  check('minute: sent three times', sent === 3, sent);
  check('minute: waited 7 s twice', clock.total() === 14000, clock.slept);
  check('minute: onWait told', waits.length === 2 && waits[0].seconds === 7 && waits[1].attempt === 2, waits);
}

// --- Per day: no wait, the error with its sentence --------------------------
{
  const clock = fakeClock();
  let sent = 0;
  let error = null;
  try {
    await sendWithRateLimitRetry(
      async () => {
        sent += 1;
        throw await apiErrorFromResponse(limited('day', 3600, 3000), es);
      },
      { sleep: clock.sleep }
    );
  } catch (err) {
    error = err;
  }
  check('day: sent once', sent === 1, sent);
  check('day: no wait', clock.slept.length === 0, clock.slept);
  check(
    'day: error sentence ES',
    error?.message === 'Has alcanzado el límite de 3000 peticiones a la IA por día. Vuelve a intentarlo en 1 h.',
    error?.message
  );
  check('day: error keeps its code', error?.code === 'llm_rate_limited', error?.code);
}

// --- Per minute, retries spent: the error, never a silent half result -------
{
  const clock = fakeClock();
  let sent = 0;
  let error = null;
  try {
    await sendWithRateLimitRetry(
      async () => {
        sent += 1;
        throw await apiErrorFromResponse(limited('minute', 5), en);
      },
      { sleep: clock.sleep }
    );
  } catch (err) {
    error = err;
  }
  check('spent: sent max+1 times', sent === RATE_LIMIT_MAX_RETRIES + 1, sent);
  check('spent: the error says it', error?.message?.startsWith('You have reached the limit of 3 AI requests per minute.'), error?.message);
}

// --- Other errors are never retried ------------------------------------------
{
  let sent = 0;
  try {
    await sendWithRateLimitRetry(async () => {
      sent += 1;
      throw await apiErrorFromResponse(new Response(JSON.stringify({ detail: { code: 'llm_request_failed', ref: 'abc' } }), { status: 500 }), en);
    });
  } catch {
    // expected
  }
  check('500 is not retried here', sent === 1, sent);
}

// --- Cancelled while waiting: clean, no request after it --------------------
{
  let cancelled = false;
  let sent = 0;
  let error = null;
  const sleep = async () => {
    cancelled = true; // the user cancels during the wait
  };
  try {
    await sendWithRateLimitRetry(
      async () => {
        sent += 1;
        throw await apiErrorFromResponse(limited('minute', 30), en);
      },
      { sleep, shouldCancel: () => cancelled }
    );
  } catch (err) {
    error = err;
  }
  check('cancel: no request after the wait', sent === 1, sent);
  check('cancel: LLM_CANCELLED', error?.code === LLM_CANCELLED, error?.code);
}
{
  let sent = 0;
  let error = null;
  try {
    await sendWithRateLimitRetry(async () => (sent += 1), { shouldCancel: () => true });
  } catch (err) {
    error = err;
  }
  check('cancelled before sending: nothing sent', sent === 0 && error?.code === LLM_CANCELLED, { sent, code: error?.code });
}

// --- AI Extract: a cancelled wait leaves the rows pending --------------------
{
  const candidates = Array.from({ length: 4 }, (_, i) => ({
    key: `c${i}`,
    classification: 'new_ext',
    ai_fields: ['title'],
    source_ids: [],
    decision_texts: ['x'],
    rule_preview: [],
    object_uses: [],
  }));
  const batches = [];
  let stop = false;
  await draftCandidates(candidates, {
    standard: 'S1000D 4.2',
    ruleFormat: 'BREX-4.2',
    batchSize: 2,
    concurrency: 1,
    shouldStop: () => stop,
    ask: async ({ shouldCancel }) => {
      stop = true; // "Stop" pressed while this request waits for the limit
      if (shouldCancel()) {
        const err = new Error('cancelled');
        err.code = LLM_CANCELLED;
        throw err;
      }
      return '{}';
    },
    onBatch: async (results) => batches.push(results),
  });
  check('extract: no batch saved (rows stay pending, never "failed")', batches.length === 0, batches);
}

// --- The prompt eval: same waits; the day limit stops the pass ---------------
{
  const replies = [
    () => new Response(JSON.stringify({ access_token: 't' }), { status: 200 }),
    () => limited('minute', 4),
    () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }),
    () => limited('day', 3600, 50),
  ];
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return replies[calls.length - 1]();
  };
  const clock = fakeClock();
  const logs = [];
  const client = createEvalClient({ api: 'http://x', email: 'a', password: 'b', fetchImpl, sleepImpl: clock.sleep, log: (l) => logs.push(l) });
  await client.login();
  const body = await client.llmProxy({ messages: [] });
  check('eval: waited and went on', body.choices[0].message.content === 'ok' && clock.total() === 4000, clock.slept);
  check('eval: wait logged', logs.some((l) => l.includes('waiting 4 s')), logs);
  check('eval: wait counted', client.rateLimitWaits === 1, client.rateLimitWaits);
  let error = null;
  try {
    await client.llmProxy({ messages: [] });
  } catch (err) {
    error = err;
  }
  check('eval: day limit stops the pass', error instanceof LlmLimitError && error instanceof SessionLostError, error?.name);
  check('eval: client.lost set (cases that swallow errors stop too)', client.lost === error);
  check('eval: message names the limit', /limit of 50 per day/.test(error?.message || ''), error?.message);
}

console.log(`${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
