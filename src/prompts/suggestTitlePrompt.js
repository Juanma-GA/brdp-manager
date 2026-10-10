// Suggest Title's system prompt: rewrites the Title the BRDP already has as
// the name of its decision point. Same construction as Suggest Definition
// (buildSuggestDefinitionPrompt): built only from the BRDP, /similar's
// structured arrays (the Definition corpus: their titles, used as style
// only), the schema facts of the names in the BRDP and its rule, and the
// vocabulary check -- never from LLM text.
import { buildSchemaFactsBlock, buildSuggestUnknownNamesBlock, referenceSourceText } from './shared.js';

export const SUGGEST_TITLE_USER_MESSAGE = 'Write the Title for this BRDP.';

export function buildSuggestTitlePrompt(brdp, standard, { similar = [], styleReferences = [], schemaFacts = [], ruleXml = '', vocabCheck = null } = {}) {
  let prompt = `You are an expert in ${standard} business rules (BRDPs — Business Rule
Decision Points), assisting in BRDP Manager.

TASK: rewrite the BRDP's current Title as the name of its decision point.
Keep the same decision: do not invent a new one, do not widen or narrow it.

A Title names WHAT is decided, never the outcome. Usual forms:
- "Decide whether …" / "Decidir si …"
- "Define the list of allowed values for …" / "Definir la lista de valores permitidos para …"
- "Allowed format for …" / "Formato permitido para …"
- "Decide on the attribute @x for the element <y>" / "Decidir sobre el atributo @x para el elemento <y>"
A Title that states the outcome ("Prohibit …", "Prohibir …", "… must not …")
is rewritten as the decision it comes from. Examples (before -> after):
- "Prohibir avee con orden de hijos incorrecto"
  -> "Definir el orden de los elementos hijos de <avee>"
- "Prohibir hotspot sin apsname o con apsname vacio"
  -> "Decidir sobre el atributo @apsname para el elemento <hotspot>"
- "Prohibit randomList inside a step"
  -> "Decide whether <randomList> is allowed inside <step>"

Write element names as <element> and attribute names as @attribute.
If the current Title starts with a reference prefix in brackets (for
example "(SOPTE BREX 3.9.5.2.1.9-2.2)"), keep it exactly as it is, at the
start. If the current Title already follows these rules, return it
unchanged.

Use this project's standard only: ${standard}.`;

  // No "say so plainly" line: the answer is only a Title.
  prompt += buildSchemaFactsBlock(standard, schemaFacts, { coverageNote: false });
  const hasFacts = schemaFacts && schemaFacts.length > 0;
  const sources = [
    'the BRDP itself (Title, Definition, Proposal)',
    ruleXml && 'its Rule',
    hasFacts && 'the SCHEMA FACTS above',
  ].filter(Boolean);
  const sourceText = sources.length === 1 ? sources[0] : `${sources.slice(0, -1).join(', ')} or ${sources.at(-1)}`;
  prompt += `

NAMES: use only element and attribute names that appear in ${sourceText}.
Never invent a plausible-sounding name.`;

  const references = [...similar, ...styleReferences].filter((c) => c.title);
  if (references.length > 0) {
    prompt += `

TITLES OF OTHER DECISION POINTS — only to see how Titles are written in
this standard; never take their content:
${references.map((c) => `[${c.identifier} | ${referenceSourceText(c)}] ${c.title}`).join('\n')}`;
  }

  prompt += `

LANGUAGE: write the Title in the language of the current Title
("${brdp.title}"), whatever the language of the other Titles.

Return ONLY the Title: one line, no final full stop, no quotes, no
markdown, no explanation.

BRDP:
ID: ${brdp.identifier}
Current Title: ${brdp.title}
Definition: ${brdp.definition || 'empty'}
Proposal: ${brdp.proposal || 'empty'}`;
  if (ruleXml) prompt += `\nRule:\n${ruleXml}`;

  prompt += buildSuggestUnknownNamesBlock(standard, vocabCheck);
  return prompt;
}

// Upper bound for a suggested Title (characters): a decision point's name,
// never a paragraph. The real long titles of the decision points Juanma
// corrected stay under 200.
export const SUGGESTED_TITLE_MAX_CHARS = 300;

// The LLM's answer as a Title, checked before it is shown: one line, no
// surrounding quotes or final full stop, within SUGGESTED_TITLE_MAX_CHARS.
// { title } or { problem: 'empty' | 'multiline' | 'too_long', title }.
export function readSuggestedTitle(raw) {
  let text = String(raw ?? '').trim();
  // A code fence or quotes around the whole answer are packaging, not text.
  text = text.replace(/^```[a-z]*\n?|```$/g, '').trim();
  text = text.replace(/^(["“«'])(.*)(["”»'])$/s, '$2').trim();
  text = text.replace(/^title:\s*/i, '').replace(/^título:\s*/i, '').trim();
  if (!text) return { problem: 'empty', title: '' };
  if (/\r|\n/.test(text)) return { problem: 'multiline', title: text };
  text = text.replace(/\.+$/, '').trim();
  if (text.length > SUGGESTED_TITLE_MAX_CHARS) return { problem: 'too_long', title: text };
  return { title: text };
}

// Same Title once spaces are collapsed: "already follows the criterion".
export function sameTitle(a, b) {
  const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  return norm(a) === norm(b);
}
