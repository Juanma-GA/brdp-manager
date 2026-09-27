// Prompt-refactor round ("Refactor del asistente, juego fijo de pruebas de
// prompts y pulido de fichas"): pure, framework-free building blocks shared
// by Ask/Suggest Definition/Suggest Proposal's system prompts -- moved out
// of RecordsPage.jsx verbatim (no behavior change; see
// scripts/verify-prompts-byte-identical.mjs for the before/after proof).
// Importable from plain Node (no React, no browser globals), same
// convention already established by src/utils/vocabularyCheck.js.
import { formatWrongTypeMessage, summarizeSchemaFactEntry } from '../utils/vocabularyCheck.js';

// Same local map as ProjectConfigPage.jsx/GenerateBREXdocPage.jsx (not
// centralized -- established convention in this codebase, see CLAUDE.md).
export const RULE_STATUS_LABELS = { todo: 'To Do', draft: 'Draft', verified: 'Verified' };

// "Ajustes al juego de pruebas de prompts" round: the single source of
// truth for the temperature each assistant flow calls the provider with --
// useAskAssistant.js/useSuggestions.js pass these explicitly instead of
// leaving Ask on sendMessage()'s implicit default or hardcoding Suggest's
// 0.3 inline, and scripts/run-prompt-eval.mjs imports the SAME constants
// so it measures the app's real behavior, never a copied number that could
// drift from it. Ask stays conversational (default sampling); Suggest
// writes directly into a BRDP field, where a drifting/inventive text is
// worse than a slightly-repetitive one.
export const ASK_TEMPERATURE = 1;
export const SUGGEST_TEMPERATURE = 0.3;

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
    block += `\n\nThe following names do NOT exist in the ${standard} schema: ${notFound.join(', ')}. Point this out explicitly; do not treat them as valid elements or attributes.`;
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
    const values = attr.enum.join('|') + (attr.enum_truncated ? `, +${attr.enum_omitted} more` : '');
    text += ` [${values}]`;
  }
  return text;
}

export function formatSchemaFactNameList(names, truncated, omitted) {
  if (!names || names.length === 0) return 'none';
  return names.join(', ') + (truncated ? `, +${omitted} more` : '');
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
export function buildSchemaFactsBlock(standard, schemaFacts) {
  if (!schemaFacts || schemaFacts.length === 0) return '';
  let block = `\n\nSCHEMA FACTS — extracted from the official ${standard} schema. These are
authoritative: for questions about which attributes, values, child
elements or parent elements are allowed, rely on these facts over your
own knowledge. If the facts do not cover what is asked, say so plainly
instead of guessing.`;
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
          ? formatSchemaFactAttributeList(v.attributes) + (v.attributes_truncated ? `, +${v.attributes_omitted} more` : '')
          : 'none';
      block += `\n  attributes: ${attrsText}`;
      block += `\n  children: ${formatSchemaFactNameList(v.children, v.children_truncated, v.children_omitted)}`;
      block += `\n  allowed inside: ${parentsText}`;
      continue;
    }

    block += `\n<${name}> — common to all ${entry.variants.length} schema variants:`;
    if (summary.anyUnresolved) {
      block += `\n  note: not every variant's content model was fully resolved — the common set below may be incomplete.`;
    }
    block += `\n  attributes: ${formatSchemaFactAttributeList(summary.common.attributes)}`;
    block += `\n  children: ${formatSchemaFactNameList(summary.common.children, false, 0)}`;
    block += `\n  allowed inside: ${parentsText}`;
    block += `\n  Differences by schema:`;
    // "Pulido de fichas" round, points 2-3: a variant with nothing to add
    // beyond the common set used to still print an "attributes: none
    // beyond the common set" / "children: none beyond the common set"
    // line -- pure noise for the overwhelmingly common case (most
    // variants of most elements differ in at most one of the two). Now
    // that line is OMITTED ENTIRELY when there is genuinely nothing to
    // add; a variant whose raw list was itself truncated (so a real
    // difference could be hiding past the cutoff) still gets a line, but
    // reworded away from "none beyond the common set" -- that phrase
    // claimed certainty ("nothing more") the truncation doesn't actually
    // have (HR7: never silently claim completeness that isn't there). The
    // two labels that DO print are "additional attributes"/"additional
    // children" (clearer than the old bare "attributes"/"children", which
    // read as if it were the variant's FULL list rather than a diff).
    // `parents` has no per-variant diff to label "additional parents" for
    // -- it's a single, always-common list (see summarizeSchemaFactEntry's
    // own docstring) -- so that third label never has a call site here.
    for (const pv of summary.perVariant) {
      let variantBlock = `\n  [${pv.schemas.join(', ')}]`;
      if (!pv.resolved) {
        variantBlock += `\n    content model not fully resolved for this schema — do not assume this list is complete.`;
      }
      if (pv.diffAttributes.length > 0) {
        variantBlock += `\n    additional attributes: ${formatSchemaFactAttributeList(pv.diffAttributes)}${pv.attributes_truncated ? `, +${pv.attributes_omitted} more` : ''}`;
      } else if (pv.attributes_truncated) {
        variantBlock += `\n    additional attributes: not confirmed — this variant's attribute list was cut off before comparison (+${pv.attributes_omitted} more not shown)`;
      }
      if (pv.diffChildren.length > 0) {
        variantBlock += `\n    additional children: ${formatSchemaFactNameList(pv.diffChildren, pv.children_truncated, pv.children_omitted)}`;
      } else if (pv.children_truncated) {
        variantBlock += `\n    additional children: not confirmed — this variant's children list was cut off before comparison (+${pv.children_omitted} more not shown)`;
      }
      block += variantBlock;
    }
  }
  return block;
}
