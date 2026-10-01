// AI Extract (1/2): writes, in batches, the texts the file cannot give
// (see src/prompts/extractFromRulesPrompt.js). Pure apart from the injected
// `ask`, so the review page and scripts/run-prompt-eval.mjs run exactly the
// same steps:
//   ask({ system, user }) → the LLM's answer text, at SUGGEST_TEMPERATURE;
//     throws on failure (an answer cut by max_tokens throws LLM_TRUNCATED).
// A batch whose answer fails or is not the expected JSON is sent once more;
// if it fails again, its candidates come back "failed" (left to write by
// hand -- HR7: never invented, never silently empty). A candidate the
// answer leaves out is "failed" too, without retrying the whole batch.
import { aiFieldsOf, buildExtractFromRulesPrompt, EXTRACT_USER_MESSAGE, parseExtractFromRulesResponse } from '../prompts/extractFromRulesPrompt.js';

export const DRAFT_BATCH_SIZE = 10;
export const DRAFT_CONCURRENCY = 3;
const DRAFTED_CLASSES = new Set(['new_ext', 'catalog', 'other_spec', 'default_rule']);

// The candidates that still need texts: the classes the AI writes for, with
// something left to write (texts in the file or the catalog are never
// sent), not written yet (by the AI or by hand). A default-BREX rule is
// only written once checked: 243 of them come unchecked in a BREX that
// carries the default rules.
export function candidatesToDraft(candidates) {
  return candidates.filter(
    (c) =>
      DRAFTED_CLASSES.has(c.classification) &&
      (c.classification !== 'default_rule' || c.selected) &&
      aiFieldsOf(c).length > 0 &&
      (c.draft_status === 'pending' || !c.draft_status)
  );
}

async function draftBatch(batch, { standard, ruleFormat, ask }) {
  const system = buildExtractFromRulesPrompt({ standard, ruleFormat, candidates: batch });
  const keys = batch.map((c) => c.key);
  const fieldsByKey = new Map(batch.map((c) => [c.key, aiFieldsOf(c)]));
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const text = await ask({ system, user: EXTRACT_USER_MESSAGE });
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
