// AI Extract: writes, in batches, the texts the file cannot give (see
// src/prompts/extractFromRulesPrompt.js; for a free text,
// src/prompts/extractFromTextPrompt.js). Pure apart from the injected
// `ask`, so the review page and scripts/run-prompt-eval.mjs run exactly the
// same steps:
//   ask({ system, user }) → the LLM's answer text, at SUGGEST_TEMPERATURE;
//     throws on failure (an answer cut by max_tokens throws LLM_TRUNCATED).
// A batch whose answer fails or is not the expected JSON is sent once more;
// if it fails again, its candidates come back "failed" (left to write by
// hand -- HR7: never invented, never silently empty). A candidate the
// answer leaves out is "failed" too, without retrying the whole batch.
import { aiFieldsOf, buildExtractFromRulesPrompt, EXTRACT_USER_MESSAGE, parseExtractFromRulesResponse } from '../prompts/extractFromRulesPrompt.js';
import { buildExtractFromTextPrompt, EXTRACT_TEXT_USER_MESSAGE } from '../prompts/extractFromTextPrompt.js';

const DRAFT_BATCH_SIZE = 10;
const DRAFT_CONCURRENCY = 3;
export const DRAFTED_CLASSES = new Set(['new_ext', 'catalog', 'catalog_edition', 'other_spec', 'default_rule']);

// Same rule as the backend's text_state (rule_extract_jobs.py): from the
// candidate's data alone, so it survives a page reload or a server restart.
//   'complete' -- nothing left to write, or every field the AI writes has
//                 text (by the AI or by hand);
//   'failed'   -- the AI could not write it (retry, write by hand, uncheck);
//   'pending'  -- not written yet.
// An existing BRDP (same / changed) and "No content" are always complete.
export function extractTextState(c) {
  if (['same', 'changed', 'empty'].includes(c.classification)) return 'complete';
  if (aiFieldsOf(c).every((f) => (c[f] || '').trim())) return 'complete';
  return c.draft_status === 'failed' ? 'failed' : 'pending';
}

// The candidates that still need texts: the classes the AI writes for, with
// something left to write (texts in the file or the catalog are never
// sent), not written yet (by the AI or by hand) -- checked or not: an
// unchecked row (a default-BREX rule) gets its texts too, so checking it
// later never waits for the AI and the import never has a row without
// texts. The checked rows come first, in file order, then the unchecked
// ones. includeFailed: also the rows whose texts failed ("Retry the failed").
export function candidatesToDraft(candidates, { includeFailed = false } = {}) {
  const todo = candidates.filter((c) => {
    if (!DRAFTED_CLASSES.has(c.classification) || aiFieldsOf(c).length === 0) return false;
    // A row with a field written by hand and another still empty is drafted
    // too: the backend never lets the AI overwrite a hand-written text.
    const state = extractTextState(c);
    return state === 'pending' || (includeFailed && state === 'failed');
  });
  return [...todo.filter((c) => c.selected), ...todo.filter((c) => !c.selected)];
}

// A free-text extraction (AI Extract 2/2) writes from the quote and its
// paragraph; a BREX / Schematron one from the rules' summary. Same JSON.
function batchPrompt(batch, { standard, ruleFormat }) {
  if (batch[0]?.source === 'text') {
    return { system: buildExtractFromTextPrompt({ standard, candidates: batch }), user: EXTRACT_TEXT_USER_MESSAGE };
  }
  return { system: buildExtractFromRulesPrompt({ standard, ruleFormat, candidates: batch }), user: EXTRACT_USER_MESSAGE };
}

async function draftBatch(batch, { standard, ruleFormat, ask }) {
  const { system, user } = batchPrompt(batch, { standard, ruleFormat });
  const keys = batch.map((c) => c.key);
  const fieldsByKey = new Map(batch.map((c) => [c.key, aiFieldsOf(c)]));
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const text = await ask({ system, user });
      const { items } = parseExtractFromRulesResponse(text, keys, fieldsByKey);
      return batch.map((c) => {
        const item = items.get(c.key);
        if (!item) return { key: c.key, draft_status: 'failed', error: 'missing from the answer' };
        const written = Object.fromEntries(fieldsByKey.get(c.key).map((f) => [f, item[f]]));
        return { key: c.key, ...written, draft_status: 'drafted' };
      });
    } catch (err) {
      lastError = err;
    }
  }
  return batch.map((c) => ({ key: c.key, draft_status: 'failed', error: lastError?.code || lastError?.message || 'failed' }));
}

// → resolves when every batch is done. onBatch(results) is called after
// each batch (the page saves them right away and moves the progress bar).
export async function draftCandidates(candidates, { standard, ruleFormat, ask, onBatch, batchSize = DRAFT_BATCH_SIZE, concurrency = DRAFT_CONCURRENCY, shouldStop }) {
  const batches = [];
  for (let i = 0; i < candidates.length; i += batchSize) batches.push(candidates.slice(i, i + batchSize));
  const all = [];
  let next = 0;
  async function worker() {
    while (next < batches.length) {
      if (shouldStop?.()) return;
      const batch = batches[next];
      next += 1;
      const results = await draftBatch(batch, { standard, ruleFormat, ask });
      all.push(...results);
      if (onBatch) await onBatch(results);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
  return all;
}
