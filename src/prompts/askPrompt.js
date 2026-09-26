// Prompt-refactor round: Ask's system prompt, moved out of RecordsPage.jsx
// verbatim (no behavior change). Pure, framework-free -- see
// src/prompts/shared.js's own header comment for the general convention.
import { ruleStateOf } from '../utils/ruleState.js';
import { RULE_STATUS_LABELS, ruleTextForAsk, buildSchemaFactsBlock, buildUnknownNamesBlock } from './shared.js';

// Builds the "Ask a Question" system prompt: strictly scoped to the
// selected BRDP (docs request), with its full live context -- including
// Rule/Rule Status, which askGeneric previously never sent at all -- plus
// an optional second BRDP (from Records or the official catalog) when the
// user has picked one to compare against.
export function buildAskSystemPrompt(brdp, ruleApproval, compareBrdp, standard, vocabCheck, schemaFacts) {
  const ruleState = ruleStateOf(ruleApproval);
  // Ask-with-schema-cards follow-up round, points 2-3: a real report
  // against this app showed two symptoms of the SAME root cause -- the
  // old scope rule only ever mentioned "this specific BRDP", so a genuine
  // schema question ("Where can <para> go?") could get refused the first
  // time it was asked (the model reading "not about this specific BRDP"
  // literally) and, even when answered correctly, sometimes still tacked
  // on a leftover "if this isn't about this BRDP, rephrase" disclaimer
  // after a schema answer it had ALREADY given. SCOPE is now explicitly
  // widened to cover the schema facts this same prompt provides, and the
  // model is told point-blank never to hedge an answer it just gave.
  let prompt = `You are an S1000D and DITA business-rules expert assistant embedded in
BRDP Manager.

SCOPE: answer questions about the BRDP shown below AND questions about
the ${standard} schema elements and attributes covered by SCHEMA FACTS.
Only if the question has nothing to do with this BRDP, with ${standard}
or with its schema, say so briefly and ask the user to rephrase.
Never add scope reminders or disclaimers to an answer you have given.`;

  if (compareBrdp) {
    prompt += `\nThe BRDP being compared against (shown below) is also in scope.`;
  }

  prompt += `

Answer exactly what is asked: "where can X go / be used" -> its allowed
parents; "what can X contain" -> its children; "which attributes" ->
its attributes. Do not list other facts unless asked.
When the facts contain several schema variants, summarize: state what
is common to all of them and mention only the notable differences.
Keep the 3-paragraph limit even when the facts are long.

Answer in at most 3 short paragraphs — be direct, no padding, no
restating the question back to the user.

Never state or suggest specification chapter, section or paragraph
numbers, not even as possibilities ("it might be in chapter X"),
unless the exact number appears in the BRDP content above. If the user
asks where something is defined, say that you cannot give the exact
location, and name the concept or element to look up in the ${standard}
specification instead.

Answer in the same language as the question.

This project uses the standard: ${standard}.
Answer strictly in terms of this standard and version — use its element
names, rule vocabulary and conventions, and do not mix in other versions
of S1000D or DITA unless the user explicitly asks for a comparison.`;

  prompt += buildSchemaFactsBlock(standard, schemaFacts);

  prompt += `

Current BRDP context:
ID: ${brdp.identifier}
Title: ${brdp.title}
Definition: ${brdp.definition}
Proposal: ${brdp.proposal}
Proposal Status: ${brdp.validation}`;

  if (brdp.validation === 'Refused' && brdp.comments) {
    prompt += `\nRefusal reason: ${brdp.comments}`;
  }

  prompt += `
Rule Status: ${RULE_STATUS_LABELS[ruleState]}
Rule: ${ruleTextForAsk(ruleState, ruleApproval?.rule_xml)}`;

  if (compareBrdp) {
    prompt += `\n\nBRDP being compared against (source: ${
      compareBrdp.source === 'records' ? 'Records' : 'Catalog'
    }):
ID: ${compareBrdp.identifier}
Title: ${compareBrdp.title}
Definition: ${compareBrdp.definition}`;
    if (compareBrdp.source === 'records') {
      prompt += `
Proposal: ${compareBrdp.proposal}
Proposal Status: ${compareBrdp.validation}
Rule Status: ${RULE_STATUS_LABELS[compareBrdp.ruleState]}
Rule: ${ruleTextForAsk(compareBrdp.ruleState, compareBrdp.ruleXml)}`;
    }
    prompt += `\n\nThe user may ask you to compare the current BRDP with the one above; in that case both are in scope.`;
  }

  prompt += buildUnknownNamesBlock(standard, vocabCheck);

  return prompt;
}
