// Prompt-refactor round: Suggest Definition's system prompt, moved out of
// RecordsPage.jsx verbatim (no behavior change).
import { buildSuggestUnknownNamesBlock, referenceSourceText } from './shared.js';

// Suggest Definition's own system prompt (docs request, Suggest Definition
// corpus round) -- a dedicated function, not inline in requestSuggestion,
// same precedent as buildAskSystemPrompt above. Built ENTIRELY from
// /similar's structured `candidates`/`style_references` arrays (never from
// the LLM) -- the reference list the UI renders under the suggestion comes
// from those exact same arrays, so what the user sees always matches what
// the LLM actually saw. `similar`/`styleReferences` entries carry `source`
// already formatted by the backend ("Records: <project name>" / "Catalog"
// -- similar.py's _get_definition_similar), reused verbatim here and in
// the UI rather than reformatted a second, possibly-diverging way.
export function buildSuggestDefinitionPrompt(brdp, standard, similar, styleReferences, vocabCheck) {
  const referenceBlock = (c) => `Title: ${c.title}\nDefinition: ${c.text}`;

  let prompt = `You are an expert in ${standard} business rules (BRDPs — Business Rule
Decision Points), assisting in BRDP Manager.

Your task: write the Definition for the BRDP below. A Definition states
the decision point — WHAT must be decided and its scope — in neutral,
concise terms. It does not state the chosen answer (that is the
Proposal) and does not describe XML implementation details (that is
the Rule).

Use this project's standard only: ${standard}. Use its terminology and
element names; do not mix in other versions of S1000D or DITA.

`;

  if (similar.length > 0) {
    prompt += `SIMILAR BRDPs — validated decision points closest in meaning to this
one. Follow their style, length and level of detail:
${similar
  .map((c) => `[${c.identifier} | ${referenceSourceText(c)} | similarity ${c.score.toFixed(2)}]\n${referenceBlock(c)}`)
  .join('\n\n')}

`;
  }

  if (styleReferences.length > 0) {
    prompt += `STYLE REFERENCES — validated decision points that are DIFFERENT in
content. Use them only to see how Definitions are written in this
standard; do not copy or reuse their content:
${styleReferences.map((c) => `[${c.identifier} | ${referenceSourceText(c)}]\n${referenceBlock(c)}`).join('\n\n')}

`;
  }

  if (similar.length === 0 && styleReferences.length === 0) {
    prompt += `No reference BRDPs are available; write the Definition from your
knowledge of ${standard} alone.

`;
  }

  prompt += `Never state or suggest specification chapter, section or paragraph
numbers, not even as possibilities ("it might be in chapter X"), unless
the exact number appears in the BRDP content below. If you would
otherwise need to point to a location in the ${standard} specification,
name the concept or element to look up instead.

LANGUAGE: Write the Definition in the same language as the BRDP's
Title ("${brdp.title}"). This takes priority over everything else — the
reference BRDPs may be in a different language; do not follow theirs.
If the Title language is unclear, use the language of the Proposal.

Return ONLY the Definition text — no preamble, no references list,
no quotes, no markdown.

BRDP to define:
ID: ${brdp.identifier}
Title: ${brdp.title}
Current Definition: ${brdp.definition || 'empty'}
Proposal: ${brdp.proposal || 'empty'}`;

  prompt += buildSuggestUnknownNamesBlock(standard, vocabCheck);

  return prompt;
}
