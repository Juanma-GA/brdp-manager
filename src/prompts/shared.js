// Prompt-refactor round ("Refactor del asistente, juego fijo de pruebas de
// prompts y pulido de fichas"): pure, framework-free building blocks shared
// by Ask/Suggest Definition/Suggest Proposal's system prompts -- moved out
// of RecordsPage.jsx verbatim (no behavior change; see
// scripts/verify-prompts-byte-identical.mjs for the before/after proof).
// Importable from plain Node (no React, no browser globals), same
// convention already established by src/validation/schemaValidation.js.
import { formatWrongTypeMessage } from '../validation/schemaValidation.js';
import { summarizeSchemaFactEntry } from '../utils/schemaFactSummary.js';

// Same local map as ProjectConfigPage.jsx/GenerateBREXdocPage.jsx (not
// centralized -- established convention in this codebase, see CLAUDE.md).
export const RULE_STATUS_LABELS = { todo: 'To Do', draft: 'Draft', verified: 'Verified' };

// "Ajustes al juego de pruebas de prompts" round: the single source of
// truth for the temperature each assistant flow calls the provider with --
// useAskAssistant.js/useSuggestions.js pass these explicitly instead of
// leaving Ask on sendMessage()'s implicit default or hardcoding Suggest's
// 0.3 inline, and scripts/run-prompt-eval.mjs imports the SAME constants
// so it measures the app's real behavior, never a copied number that could
// drift from it. Ask stays conversational but below the default 1 -- a
// real Mistral run at 1 slipped a German word into a Spanish answer
// (ask-para-placement); Suggest writes directly into a BRDP field, where a
// drifting/inventive text is worse than a slightly-repetitive one.
export const ASK_TEMPERATURE = 0.7;
export const SUGGEST_TEMPERATURE = 0.3;
// Test rule (T2): the examples must vary between regenerations to be
// useful, but stay plain and on-topic.
export const RULE_TEST_TEMPERATURE = 0.5;
// Test de reglas T3b: "Review with the assistant" -- a diagnosis, not a
// creative text: as steady as Suggest.
export const RULE_TEST_REVIEW_TEMPERATURE = 0.3;

// A hand-authored Rule can be very long (Navantia's Xpath3.0 few-shot
// examples with inline function expressions run well past this) -- rather
// than risk silently blowing max_tokens/context on a huge prompt (HR7:
// never degrade silently), cut it and say so explicitly IN the prompt
// itself, never just drop it.
export const ASK_RULE_MAX_CHARS = 6000;

export function ruleTextForAsk(state, ruleXml) {
  if (state === 'todo' || !ruleXml) return 'Not yet defined';
  if (ruleXml.length <= ASK_RULE_MAX_CHARS) return ruleXml;
  return `${ruleXml.slice(0, ASK_RULE_MAX_CHARS)}\n[Rule truncated at ${ASK_RULE_MAX_CHARS} characters]`;
}

// Docs request (schema vocabulary check round), 3.5. Shared by all three
// prompts that get this block (Ask, Suggest Definition, Suggest Proposal
// -- never Suggest Rule, unchanged). `vocabCheck` is
// checkAgainstVocabulary()'s own output (notFound/wrongType) -- already
// deduped and formatted, appended verbatim, never reformatted a second
// way. "Solo determinista" round: the LLM-guess path (and the hedged
// "possibly not in" paragraph it fed) is gone entirely -- every name here
// has real evidence in the text (`<x>`/`@x` markup, or an explicit
// "element .../attribute ..." introduction), so there is only one
// confidence level left.
export function buildUnknownNamesBlock(standard, vocabCheck) {
  if (!vocabCheck) return '';
  const { notFound, wrongType } = vocabCheck;
  let block = '';
  if (notFound && notFound.length > 0) {
    // "Ask: comprobar los nombres de la respuesta", Part 2: a real answer
    // turned `@ncage` (listed here) into "ncage es un atributo del
    // elemento <identAndStatusSection>" -- the name written bare and with
    // other capitalisation, placed inside an element. The example uses
    // the first listed name so it is always about a name actually at hand.
    const bare = notFound[0].replace(/^[<@]|>$/g, '');
    const capitalised = bare.charAt(0).toUpperCase() + bare.slice(1);
    block += `\n\nThe following names do NOT exist in the ${standard} schema: ${notFound.join(', ')}. Point this out explicitly; do not treat them as valid elements or attributes. Never describe any of them as existing in any form — not written without "@" or angle brackets, and not with a different capitalisation (for example "${capitalised}" for ${notFound[0]}) — and never say which element they belong to or where they can go.`;
  }
  if (wrongType && wrongType.length > 0) {
    const lines = wrongType.map((w) => formatWrongTypeMessage(standard, w));
    block += `\n\nThe following names were used as the wrong kind in the text: ${lines.join(' ')}`;
  }
  return block;
}

// "Aviso ligado al texto" round, point 3: Suggest Definition/Proposal get
// a DIFFERENT unknown-names block from Ask's buildUnknownNamesBlock above
// -- real-Mistral feedback showed the model, given the Ask-style "point
// this out explicitly" instruction, wrote user-facing commentary INTO the
// Proposal text itself ("The element <pokemon> does not exist... and will
// not be used.") and, worse, decided the outcome -- exactly what "DO NOT
// MAKE THE DECISION" (buildSuggestProposalPrompt's own template block)
// already forbids for everything else. Ask is a conversation where
// pointing out an unknown name is the point; a Suggest's OUTPUT becomes
// the BRDP's own Title/Definition/Proposal field verbatim, where a stray
// comment or a snuck-in decision would corrupt the record. Regardless of
// whether a name is notFound/wrongType, the instruction is identical: say
// nothing about it, decide nothing, just write the text as instructed.
export function buildSuggestUnknownNamesBlock(standard, vocabCheck) {
  if (!vocabCheck) return '';
  const names = [
    ...new Set([
      ...(vocabCheck.notFound || []),
      ...(vocabCheck.wrongType || []).map((w) => (w.usedAs === 'element' ? `<${w.name}>` : `@${w.name}`)),
    ]),
  ];
  if (names.length === 0) return '';
  return `\n\nThe BRDP mentions names that may not exist in the ${standard} schema: ${names.join(', ')}. The user has already been warned in the interface. Do NOT mention their validity in your output, do not add comments or notes, and do not take any decision about them -- write the text exactly as instructed above.`;
}

// "Did you mean con marcado a medias y listas de padres cortadas" round,
// Part 2: a truncated list used to end with a bare ", +3 more" -- a real
// production run against Mistral for "Where can <para> go?" showed the
// model answering with the 40 shown names AND a literal "+3 more" tacked
// on, as if that fragment were itself a fact to report rather than
// metadata about the PROMPT's own (necessarily capped) list. This marker
// is deliberately worded as a parenthetical the model has to paraphrase --
// buildAskSystemPrompt tells it explicitly never to invent or state how
// many more there are -- never a bare number it could lift verbatim into
// a sentence. Used only where `shownCount + omitted` is an honest, exact
// total (a name list or an enum, both counted directly against the
// server's own truncation) -- see PARTIAL_DIFF_NOTE below for the
// per-variant-diff case, where no such exact total exists.
function truncationMarker(shownCount, omitted) {
  const total = shownCount + omitted;
  return ` (partial list: ${shownCount} of ${total} shown)`;
}

// Docs request ("Servicio de fichas de esquema y su uso en Ask"): formats
// the real structural facts fetched from GET /api/schema-cards into the
// literal block shape the encargo specifies. `schemaFacts` is an array of
// {name, entry} in the SAME priority order selectSchemaFactNames returned
// (question's own names first, then Title/Definition/Proposal) -- `entry`
// is the endpoint's own per-name shape ({variants, parents, ...}), used
// here EXACTLY as returned, never reformatted a second, possibly-
// diverging way from what the "Schema facts used" UI line renders.
export function formatSchemaFactAttribute(attr) {
  let text = attr.required ? `@${attr.name} (required)` : `@${attr.name}`;
  if (attr.enum && attr.enum.length > 0) {
    text += ` [${attr.enum.join('|')}]`;
    if (attr.enum_truncated) text += truncationMarker(attr.enum.length, attr.enum_omitted);
  }
  return text;
}

export function formatSchemaFactNameList(names, truncated, omitted) {
  if (!names || names.length === 0) return 'none';
  const list = names.join(', ');
  return truncated ? list + truncationMarker(names.length, omitted) : list;
}

export function formatSchemaFactAttributeList(attrs) {
  if (!attrs || attrs.length === 0) return 'none';
  return attrs.map(formatSchemaFactAttribute).join(', ');
}

// Ask-with-schema-cards follow-up round, point 4: for an element with a
// single schema variant (the common case), render exactly as before. For
// one with several, render what summarizeSchemaFactEntry found common to
// ALL of them first (attributes, children, and the always-single `parents`
// list), then a "Differences by schema" section listing, per variant,
// ONLY what that variant adds beyond the common set -- never repeating
// the full attribute/children list once per variant. Truncation markers
// stay attached to whichever per-variant list they actually describe
// (never claimed for the computed common set, which is exact given the
// data available).
// `coverageNote: false` leaves out the header's last sentence ("If the facts
// do not cover what is asked…") for a prompt that already says it in its
// own words (Ask).
export function buildSchemaFactsBlock(standard, schemaFacts, { coverageNote = true } = {}) {
  if (!schemaFacts || schemaFacts.length === 0) return '';
  let block = `\n\nSCHEMA FACTS — extracted from the official ${standard} schema. These are
authoritative: for questions about which attributes, values, child
elements or parent elements are allowed, rely on these facts over your
own knowledge.${coverageNote ? ` If the facts do not cover what is asked, say so plainly
instead of guessing.` : ''}`;
  for (const { name, entry } of schemaFacts) {
    const summary = summarizeSchemaFactEntry(entry);
    const parentsText = formatSchemaFactNameList(entry.parents, entry.parents_truncated, entry.parents_omitted);

    if (!summary.common) {
      const v = entry.variants[0];
      block += `\n<${name}> (schemas: ${v.schemas.join(', ')})`;
      if (!v.resolved) {
        block += `\n  content model not fully resolved for this schema — do not assume the lists below are complete.`;
      }
      const attrsText =
        v.attributes.length > 0
          ? formatSchemaFactAttributeList(v.attributes) + (v.attributes_truncated ? truncationMarker(v.attributes.length, v.attributes_omitted) : '')
          : 'none';
      block += `\n  attributes: ${attrsText}`;
      block += `\n  children: ${formatSchemaFactNameList(v.children, v.children_truncated, v.children_omitted)}`;
      block += `\n  allowed inside: ${parentsText}`;
      continue;
    }

    // "Fichas sin hijos comunes" round: the header counts the schemas the
    // card covers (26 for <identAndStatusSection> in 4.2), never the
    // number of variant groups (6) -- "all 6 schema variants" read as if
    // the element existed in only six schemas.
    block += `\n<${name}> — defined in ${summary.schemaCount} schemas:`;
    if (summary.anyUnresolved) {
      block += `\n  note: not every schema's content model was fully resolved — the lists below may be incomplete.`;
    }
    block += kindLines('attributes', summary.attributesMode, summary.common.attributes, summary.perVariant);
    block += kindLines('children', summary.childrenMode, summary.common.children, summary.perVariant);
    // "Ajustes a los prompts de Proposal y fichas" round, Part 4: a real
    // Mistral test answered that <para>'s schema variants "differ in
    // additional allowed parents (e.g. footnote)" -- factually wrong on
    // two counts at once (footnote is a CHILDREN difference, and parents
    // never vary per variant in this data model at all -- there is only
    // ever one parents list per element, see summarizeSchemaFactEntry's
    // own docstring). Said in words on both ends: where "allowed inside"
    // is stated, and where "Differences by schema" is introduced.
    block += `\n  allowed inside: ${parentsText} (this is the same for every schema listed above — allowed-inside parents never differ by schema)`;
    // Every variant group is still named here (the only place the schemas
    // of a 'common'-mode card are listed); a 'bySchema' kind is already
    // listed per group by kindLines(), so with no 'common' kind there is
    // no section at all.
    if (summary.attributesMode === 'common' || summary.childrenMode === 'common') {
      block += `\n  Differences by schema (beyond what is common to all — attributes and children ONLY; parents are never part of this comparison, see "allowed inside" above):`;
      block += summary.perVariant.map((pv) => variantDiffLines(pv, summary)).join('');
    }
  }
  return block;
}

// "Pulido de fichas" round, points 2-3 (kept): a variant with nothing to
// add beyond the common set prints no line at all; one whose raw list was
// truncated still gets a line, worded without claiming "nothing more"
// (HR7). The labels are "additional attributes"/"additional children"
// because they are a diff against the common set. Only kinds in 'common'
// mode have a diff -- a 'bySchema' kind is already listed per schema
// group in full by kindLines().
//
// "Did you mean con marcado a medias" round, Part 2: a per-variant diff is
// a SUBSET of that variant's raw list, so the raw omitted count cannot be
// attributed to it -- PARTIAL_DIFF_NOTE says so without a number.
const PARTIAL_DIFF_NOTE = ' (this variant’s own list was cut before comparison — further differences may exist beyond what is shown)';

function variantDiffLines(pv, summary) {
  let lines = '';
  if (summary.attributesMode === 'common') {
    if (pv.diffAttributes.length > 0) {
      lines += `\n    additional attributes: ${formatSchemaFactAttributeList(pv.diffAttributes)}${pv.attributes_truncated ? PARTIAL_DIFF_NOTE : ''}`;
    } else if (pv.attributes_truncated) {
      lines += `\n    additional attributes: not confirmed — this variant's attribute list was cut off before comparison, so a real difference could be hiding past the cutoff`;
    }
  }
  if (summary.childrenMode === 'common') {
    if (pv.diffChildren.length > 0) {
      lines += `\n    additional children: ${formatSchemaFactNameList(pv.diffChildren, false, 0)}${pv.children_truncated ? PARTIAL_DIFF_NOTE : ''}`;
    } else if (pv.children_truncated) {
      lines += `\n    additional children: not confirmed — this variant's children list was cut off before comparison, so a real difference could be hiding past the cutoff`;
    }
  }
  let head = `\n  [${pv.schemas.join(', ')}]`;
  if (!pv.resolved) head += `\n    content model not fully resolved for this schema — do not assume this list is complete.`;
  return head + lines;
}

// "Fichas sin hijos comunes" round: one kind (attributes or children) of a
// multi-variant card. 'none' is written only when no schema has any;
// 'bySchema' lists each variant group's full list (no "additional": there
// is no common set it would be added to).
function kindLines(kind, mode, commonList, perVariant) {
  const format = (list) => (kind === 'attributes' ? formatSchemaFactAttributeList(list) : formatSchemaFactNameList(list, false, 0));
  if (mode === 'none') return `\n  ${kind}: none`;
  if (mode === 'common') return `\n  ${kind} common to all: ${format(commonList)}`;
  let out = `\n  ${kind} depend on the schema (none common to all):`;
  for (const pv of perVariant) {
    const list = kind === 'attributes' ? pv.diffAttributes : pv.diffChildren;
    const truncated = kind === 'attributes' ? pv.attributes_truncated : pv.children_truncated;
    const omitted = kind === 'attributes' ? pv.attributes_omitted : pv.children_omitted;
    const text =
      list.length === 0
        ? truncated
          ? `none shown${truncationMarker(0, omitted)}`
          : 'none'
        : format(list) + (truncated ? truncationMarker(list.length, omitted) : '');
    out += `\n    [${pv.schemas.join(', ')}]: ${text}`;
    if (!pv.resolved) out += ' (content model not fully resolved for this schema)';
  }
  return out;
}

