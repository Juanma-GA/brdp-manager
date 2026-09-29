// Prompt-refactor round: Suggest Proposal's system prompt, moved out of
// RecordsPage.jsx verbatim (no behavior change).
import { buildSuggestUnknownNamesBlock } from './shared.js';

// Suggest Proposal's own system prompt (docs request, Suggest Proposal
// round) -- same architecture as buildSuggestDefinitionPrompt above, built
// ENTIRELY from /similar's structured same_brdp/candidates/this_project
// arrays (never from the LLM), so what the UI's reference list shows is
// exactly what the LLM saw. `source` already carries the bare project
// name (similar.py's _get_proposal_similar) for same_brdp/candidates, and
// is empty for this_project (that group is never labeled -- "this
// project" is already implied). Definition is never empty here (the
// backend 400s Suggest Proposal on an empty Definition before this is
// ever called), so unlike buildSuggestDefinitionPrompt's own fields,
// `brdp.definition` needs no `|| 'empty'` fallback.
export function buildSuggestProposalPrompt(brdp, standard, sameBrdp, similar, thisProject, vocabCheck) {
  let prompt = `You are an expert in ${standard} business rules (BRDPs — Business Rule
Decision Points), assisting in BRDP Manager.

Your task: write the Proposal for the BRDP below. A Proposal is the
normative sentence of the decision THIS project takes for the decision
point described in the Definition (e.g. "... shall not be used",
"... shall be limited to ..."). You write it with the choices left to
the user as placeholders (see DO NOT MAKE THE DECISION below). Do not
restate the Definition and do not describe XML implementation details
(that is the Rule).

Use this project's standard only: ${standard}. Use its terminology and
element names; do not mix in other versions of S1000D or DITA.

`;

  if (sameBrdp.length > 0) {
    prompt += `SAME BRDP IN OTHER PROJECTS — how other projects decided this exact
decision point. Use them to understand the usual options; do not copy
their project-specific values:
${sameBrdp.map((c) => `[${c.identifier} | ${c.source}] Proposal: ${c.text}`).join('\n\n')}

`;
  }

  if (similar.length > 0) {
    prompt += `SIMILAR DECISIONS IN OTHER PROJECTS — related decision points and how
they were decided:
${similar
  .map(
    (c) =>
      `[${c.identifier} | ${c.source} | similarity ${c.score.toFixed(2)}]\nDefinition: ${c.definition} / Proposal: ${c.text}`
  )
  .join('\n\n')}

`;
  }

  if (thisProject.length > 0) {
    prompt += `THIS PROJECT'S RELATED DECISIONS — already validated in this project.
Your Proposal must be consistent with them and must not contradict them:
${thisProject
  .map(
    (c) => `[${c.identifier} | similarity ${c.score.toFixed(2)}]\nDefinition: ${c.definition} / Proposal: ${c.text}`
  )
  .join('\n\n')}

`;
  }

  if (sameBrdp.length === 0 && similar.length === 0 && thisProject.length === 0) {
    prompt += `No reference BRDPs are available; write the Proposal from your
knowledge of ${standard} alone.

`;
  }

  if (brdp.validation === 'Refused') {
    prompt += `THE PREVIOUS PROPOSAL WAS REFUSED.
Refused proposal: ${brdp.proposal || 'empty'}
Reason for refusal: ${brdp.comments || 'not given'}
Your Proposal must address the reason for refusal.
`;
    // "Ajustes a los prompts de Proposal y fichas" round, Part 3: a real
    // Mistral test with the refusal reason "real maintenance tasks need at
    // least 2 levels" (of nested sub-steps) still came back with
    // [VALUE: e.g. 5, 8] -- a plausible-looking example that completely
    // ignores the concrete "at least 2" constraint already stated in the
    // reason. Only added when there IS a reason to read (an empty
    // `comments` renders as "not given" above and must not invent any
    // restriction out of nothing -- behavior unchanged in that case).
    if (brdp.comments && brdp.comments.trim()) {
      prompt += `If the reason for refusal states a concrete restriction (a stated
minimum, maximum, a mandatory value, or a forbidden value), the
placeholder you write must capture THAT SPECIFIC restriction — e.g. a
reason of "at least 2" must produce [VALUE: at least 2], never an
unrelated example value (such as [VALUE: e.g. 5, 8]) that ignores it.
`;
    }
    prompt += `
`;
  }

  // "Ajustes a los prompts de Proposal y fichas" round, Part 2: a real
  // Mistral test copied these examples almost verbatim into its actual
  // output, including "The element <x> [YES/NO] be used." -- which isn't
  // even grammatically correct English (a bare [YES/NO] dropped into a
  // sentence with no modal verb). Replaced with topics that have nothing
  // to do with permitted schemas, "<element>" yes/no usage, nesting, or
  // CAGE codes (those are the very topics the model was seen copying) --
  // date format, illustration color, title length, and units of measure
  // -- while still covering all four placeholder kinds. The YES/NO
  // example now reads as a real, grammatically complete sentence
  // (the placeholder IS the modal verb pair, "[SHALL/SHALL NOT]", not a
  // bare "[YES/NO]" bolted onto a sentence missing its own verb) so a
  // model copying its *shape* copies something correct.
  prompt += `DO NOT MAKE THE DECISION. Write the Proposal as a fill-in template: the
complete normative sentence, with every choice left to the user as a
bracketed placeholder that states the kind of answer and, where useful,
example options. Examples:
- Dates shall be written in [LIST: YYYY-MM-DD, DD-MM-YYYY, Month DD, YYYY] format.
- Illustrations [SHALL/SHALL NOT] use color to indicate hazard severity.
- Titles shall not exceed [VALUE: e.g. 60] characters.
- Measurements shall be expressed in [UNIT: e.g. metric, imperial] units.
Example options may come from the reference BRDPs, but never present
another project's choice as this project's decision.

Never state or suggest specification chapter, section or paragraph
numbers, not even as possibilities ("it might be in chapter X"), unless
the exact number appears in the BRDP content below. If you would
otherwise need to point to a location in the ${standard} specification,
name the concept or element to look up instead.

BRDP:
ID: ${brdp.identifier}
Title: ${brdp.title}
Definition: ${brdp.definition}
Current Proposal: ${brdp.proposal || 'empty'}

LANGUAGE: Write the Proposal in the same language as the BRDP's Title
("${brdp.title}"). This takes priority over everything else — the
reference BRDPs may be in a different language; do not follow theirs.
If the Title language is unclear, use the language of the Definition.

Return ONLY the Proposal text — no preamble, no references list,
no quotes, no markdown.`;

  prompt += buildSuggestUnknownNamesBlock(standard, vocabCheck);

  return prompt;
}
