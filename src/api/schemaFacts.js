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
