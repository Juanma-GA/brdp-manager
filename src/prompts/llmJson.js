// Barrido final 3, Part 2: one reader for every LLM answer that must be a
// JSON object (rule-test examples, Proposal check, rule-test review, AI
// Extract drafting, AI Extract "find the decisions").
//
// A model sometimes writes a raw line break or tab INSIDE a string value
// (an XML example spread over several lines), which JSON forbids: the real
// case was "Bad control character in string literal in JSON" in two
// rule-test runs (template-4-2-assycode, 4-1-boolean-tool-cir, 2 of 3).
// The reader parses the answer as it is first; only when that fails does it
// escape the control characters that sit inside string literals (\n, \r,
// \t, \b, \f, the rest as \u00XX) and try once more. Anything outside the
// strings is never touched -- line breaks between members are plain JSON
// whitespace already -- and nothing else is "repaired": an answer still
// invalid after that fails with the error of the first attempt, as before.
//
// Tolerated around the object, as every parser did on its own until now: a
// ```json fence and text before or after it.

const CONTROL_ESCAPES = { '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f' };

// Escapes the control characters (U+0000-U+001F) that are inside JSON string
// literals; returns the text unchanged when there are none. A character right
// after a backslash belongs to an escape sequence and is copied as it is.
export function escapeControlCharsInStrings(text) {
  let out = '';
  let inString = false;
  let escaped = false;
  let changed = false;
  for (const ch of text) {
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (escaped) {
      escaped = false;
      out += ch;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      out += ch;
      continue;
    }
    if (ch === '"') {
      inString = false;
      out += ch;
      continue;
    }
    const code = ch.charCodeAt(0);
    if (code < 0x20) {
      out += CONTROL_ESCAPES[ch] || `\\u${code.toString(16).padStart(4, '0')}`;
      changed = true;
      continue;
    }
    out += ch;
  }
  return changed ? out : text;
}

// → { ok: true, data, repaired } | { ok: false, reason: 'no_object' | 'invalid', message }
// options.allowUnclosed (default true): with no closing brace after the
// opening one (a truncated answer), still try the text up to its end so the
// error says what is wrong; false reports it as 'no_object'.
export function readLlmJson(raw, { allowUnclosed = true } = {}) {
  const text = String(raw ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || (!allowUnclosed && end <= start)) {
    return { ok: false, reason: 'no_object', message: 'no JSON object' };
  }
  const body = end > start ? text.slice(start, end + 1) : text.slice(start);
  let firstError;
  try {
    return { ok: true, data: JSON.parse(body), repaired: false };
  } catch (err) {
    firstError = err;
  }
  const escaped = escapeControlCharsInStrings(body);
  if (escaped !== body) {
    try {
      return { ok: true, data: JSON.parse(escaped), repaired: true };
    } catch {
      // The original error is the one that says what the model wrote.
    }
  }
  return { ok: false, reason: 'invalid', message: firstError.message, error: firstError };
}
