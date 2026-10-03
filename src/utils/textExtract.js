// AI Extract (2/2): free text -- the word count and step 1 (the AI finds
// the decisions). Pure apart from the injected `ask`, so the page and
// scripts/run-prompt-eval.mjs run exactly the same steps:
//   ask({ system, user }) → the LLM's answer text; throws on failure (an
//   answer cut by max_tokens throws an error with code LLM_TRUNCATED).
import { LLM_TRUNCATED } from '../api/llmTruncation.js';
import { buildFindDecisionsPrompt, FIND_DECISIONS_USER_MESSAGE, parseFindDecisionsResponse } from '../prompts/extractFromTextPrompt.js';

// The whitespace between words -- the same characters as the server
// (backend/app/services/text_extract.py's count_words; keep in sync).
const WORD_RE = /[^\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+/g;

export function countWords(text) {
  return (String(text ?? '').match(WORD_RE) || []).length;
}

// "1 240" / "1,240": the counter's numbers, grouped from 1 000 up.
export function formatCount(n, lang) {
  const sep = String(lang || '').startsWith('es') ? '\u00a0' : ',';
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}

// Splits a text in two halves of about the same number of words, at a
// paragraph break (a blank line); with a single paragraph, at a line break;
// with a single line, at a sentence end. Never inside a sentence when a
// boundary exists; the two halves together are the whole text.
export function splitInHalves(text) {
  const source = String(text ?? '');
  const boundaries = (re) => [...source.matchAll(re)].map((m) => m.index + m[0].length);
  let cuts = boundaries(/\n[ \t]*\n/g);
  if (!cuts.length) cuts = boundaries(/\n/g);
  if (!cuts.length) cuts = boundaries(/[.!?]\s+/g);
  if (!cuts.length) {
    const words = source.split(/(\s+)/);
    const half = Math.ceil(words.length / 2);
    return [words.slice(0, half).join(''), words.slice(half).join('')];
  }
  const total = countWords(source);
  let best = cuts[0];
  let bestDiff = Infinity;
  for (const cut of cuts) {
    const diff = Math.abs(countWords(source.slice(0, cut)) * 2 - total);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = cut;
    }
  }
  return [source.slice(0, best), source.slice(best)];
}

async function askOnce(text, { standard, ask }) {
  const answer = await ask({ system: buildFindDecisionsPrompt({ standard, text }), user: FIND_DECISIONS_USER_MESSAGE });
  return parseFindDecisionsResponse(answer);
}

export const FIND_TRUNCATED = 'FIND_TRUNCATED';

// Step 1 → [{ quote, title }]. If the answer is cut by its length, the
// text is split in two halves at a paragraph break and each half is asked
// once; if a half is cut again, an error with code FIND_TRUNCATED (the page
// shows a readable message). Any other error is thrown as it is.
export async function findDecisions({ text, standard, ask }) {
  try {
    return await askOnce(text, { standard, ask });
  } catch (err) {
    if (err?.code !== LLM_TRUNCATED) throw err;
  }
  const out = [];
  for (const half of splitInHalves(text)) {
    if (!half.trim()) continue;
    try {
      out.push(...(await askOnce(half, { standard, ask })));
    } catch (err) {
      if (err?.code !== LLM_TRUNCATED) throw err;
      const error = new Error('The AI answer was cut by its length even for half of the text');
      error.code = FIND_TRUNCATED;
      throw error;
    }
  }
  return out;
}
