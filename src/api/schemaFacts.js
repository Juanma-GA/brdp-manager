import { authFetchJson } from '../services/apiClient';
import { selectSchemaFactNames } from '../utils/vocabularyCheck.js';

// Real structural facts from GET /api/schema-cards for the element names
// mentioned in `orderedTexts` (priority order, capped at `max`) -- shared by
// Ask and Suggest Rule. A fetch failure resolves to [] rather than failing
// the caller: schema facts improve the prompt, they are never required for
// it.
export async function fetchSchemaFacts(standard, vocabulary, orderedTexts, max = 6) {
  const names = selectSchemaFactNames(orderedTexts, vocabulary, max).map((c) => c.name);
  if (names.length === 0) return [];
  try {
    const res = await authFetchJson(
      `/api/schema-cards?standard=${encodeURIComponent(standard)}&names=${encodeURIComponent(names.join(','))}`
    );
    if (!res.available) return [];
    return names.filter((name) => res.cards[name]).map((name) => ({ name, entry: res.cards[name] }));
  } catch {
    return [];
  }
}

// Suggest Rule part 2 (schema context): the raw GET /api/schema-cards answer
// for `names` -- { available, cards, unknown, document_schemas }. Unlike
// fetchSchemaFacts, errors propagate: the schema-choice decision depends on
// it, and it must never silently fall back to "general rule" (HR7).
export async function fetchSchemaCards(standard, names) {
  const unique = [...new Set(names)];
  // With no names the endpoint still answers document_schemas.
  const query = unique.length > 0 ? unique.join(',') : '_';
  return authFetchJson(
    `/api/schema-cards?standard=${encodeURIComponent(standard)}&names=${encodeURIComponent(query)}`
  );
}
