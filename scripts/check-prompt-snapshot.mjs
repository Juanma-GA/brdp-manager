// "Ajustes al juego de pruebas de prompts" round, Part 5: permanent,
// committed byte-for-byte comparison of the real prompt builders
// (src/prompts/askPrompt.js/suggestDefinitionPrompt.js/
// suggestProposalPrompt.js) against a fixed set of expected outputs
// (expected-prompts.json), built from a fixed set of inputs
// (prompt-snapshot/cases.mjs). A future refactor of those builders, or of
// anything they call into (utils/schemaFactSummary.js's summarizeSchemaFactEntry, validation/schemaValidation.js's
// formatWrongTypeMessage), can be checked for accidental prompt drift with:
//
//     node scripts/check-prompt-snapshot.mjs
//
// This is the permanent version of what the "Refactor del asistente" round
// only ever built as scratch files under a session-local scratchpad
// directory -- never committed, so no later round could actually run it
// (see this round's own CLAUDE.md entry). No backend, Postgres, or LLM
// provider needed -- these are pure functions.
//
// Test rule T2b: the 4 ruleTestExamples prompts changed deliberately -- the
// LLM now writes only the content of an insertion point on an application
// skeleton (placements from scripts/rule-test-fixtures/structures.json),
// the explanation is read from the rule's XML, a "proposalMismatch" field
// and the no-text-in-references line were added; new case
// brex-4-2-proced-insertion-mainprocedure (insertion point other than
// <para>). The 19 other prompts are unchanged.
//
// AI Extract (1/2): new group extractFromRules (4 cases, real candidates
// read from the two BREX fixtures by backend/scripts/
// dump_rule_extract_fixture.py). No other prompt changes.
//
// AI Extract, "Propuesta del fichero": a BREX candidate whose rules all
// share one objectUse has it as its Proposal (from the file), so the AI
// is asked only for what is left. Changed on purpose: the three BREX cases
// of extractFromRules -- S1-00052 and S1-00007 now new EXT with the
// Proposal given (Title and Definition asked; an objectUse equal to the
// given Proposal is not repeated), S2-00002 and BREX-S1-00242 asked only
// Title and Definition. Nothing else changes.
//
// Barrido final 3: the Proposal check answers in three levels ("yes",
// "partly", "no") with criteria of what is NOT a "no" and four real
// examples; changed on purpose: the 2 ruleProposalCheck cases. New case
// brex-4-1-boolean-only-listed-elements ("only A, B, C" as a boolean
// prohibition of the others; its description now says that elements the
// condition does not name are never rejected). Nothing else changes.
//
// Mejoras A, Part 2: new case ruleTestExamples/brex-4-2-not-ancestor-commoninfo
// (//commonInfo[not(ancestor::procedure)]: the examples split between
// process and proced, each with its way down). Only rules with that kind of
// predicate get the new text; no other case changes.
//
// Mejoras A, Part 4: describeRule explains a threshold on the last step
// (count(ancestor::E), count(H), string-length(.)). Changed on purpose: the
// one case whose rule has such a predicate,
// ruleProposalCheck/brex-4-2-at-most-three-vs-exactly-one ("<proceduralStep>
// with exactly 1 <proceduralStep> child must not appear"). Nothing else.
//
// Mejoras F, Parts 1.5 and 2.2a: the BREX format rules of Suggest Rule gain
// rule 8 (the indentation between elements is text too; a rule on text
// looks at text() and never counts whitespace-only nodes -- BRDP-EXT-02719)
// and rule 9 ("every <X> must carry @a = v" is forbidden as the opposite
// with flag/objappl 0 on X[not(@a='v')], never flag 1 with values --
// BRDP-EXT-02636); 3.0.1's rule 5 no longer sends a mandatory node to
// objappl="1". The Schematron rules gain rule 13 (the same text line).
// Changed on purpose: the 9 suggestRule cases. Nothing else.
//
// Mejoras G: Suggest Rule's format rules gain one line (BREX rule 10,
// Schematron rule 14): a text function takes ONE node, never a path that
// can return several (BRDP-EXT-02792/-02642). Changed on purpose: the 9
// suggestRule cases. Two NEW ruleTestExamples cases:
// brex-3-0-1-at-most-one-evaluate (BRDP-EXT-02786: "at most one <evaluate>
// / <displaytext> inside <applic>", Part 1.4) and
// brex-3-0-1-several-p-requested (the corrected 02792: ask for examples
// with two or more <p>, Part 1.6). Every other case is unchanged.
//
// Remates de Mejoras G, Part 1.2: BREX rule 9 (mandatory value) splits one
// value (X[not(@a='v')], one rule) from several (two rules: {ID}-1 with the
// list, {ID}-2 forbidding X[not(@a)] unless SCHEMA FACTS make @a required);
// never the list as a condition. Changed on purpose: the 7 BREX suggestRule
// cases. Every other case (Schematron, Ask, Suggest Definition/Proposal,
// rule test) is unchanged.
//
// Dosier, Part 2: two new cases (ruleTestExamples/dita-xpath{3,2}-dossier-
// safety-topic): a DITA rule that reads the files of its ditamap gets the
// dossier block ("files" in the output). Every existing case is unchanged.

// A DELIBERATE change to a prompt's wording/structure (not this repo's
// day-to-day case, but it does happen -- see e.g. the "SCOPE:" rewrite a
// few rounds back) means expected-prompts.json is stale by design, not
// broken -- regenerate it with:
//
//     node scripts/check-prompt-snapshot.mjs --update
//
// and commit the new expected-prompts.json alongside the prompt change
// itself, in the same commit, so the diff shows reviewers exactly what
// changed in the prompt text.
//
// "Did you mean con marcado a medias y listas de padres cortadas" round:
// expected-prompts.json regenerated (via --update, after re-running
// backend/scripts/dump_schema_cards_fixture.py so its fixture reflects
// this round's own backend change too -- see below) for two DELIBERATE
// reasons, both real prompt-content changes, not accidental drift:
//   1. buildAskSystemPrompt (askPrompt.js) gained a new, unconditional
//      instruction paragraph ("If a schema-facts list is marked as a
//      partial list, say so... group or summarize lists over 15 names")
//      -- this changes ALL 5 Ask cases in cases.mjs, even the ones with no
//      schema facts at all, since the paragraph is static text next to
//      SCOPE, not something gated on schemaFacts being non-empty.
//   2. schema_cards.py's MAX_PARENTS (new, separate from MAX_CHILDREN,
//      raised to 60) means <para> in S1000D 4.2 -- used by the
//      multi-variant-para-refused-notfound case -- now has its full 43
//      real parents rendered untruncated, with no "(partial list: ...)"
//      marker at all (43 <= 60); before this round it was silently cut to
//      40 with the old ", +3 more" wording. The fixture dump had to be
//      re-run for this to show up here -- schema-cards-fixture.json is a
//      point-in-time capture of what the backend returns, not live data.
// None of the OTHER wording changes this round (formatSchemaFactNameList/
// formatSchemaFactAttribute's new "(partial list: N of M shown)" phrasing,
// the per-variant-diff PARTIAL_DIFF_NOTE) show up in any of the 11 fixed
// cases below, because none of them happens to hit a genuinely truncated
// list under MAX_PARENTS=60/MAX_CHILDREN=40/MAX_ATTRIBUTES=30/
// MAX_ENUM_VALUES=20 with real S1000D 4.2 data -- that machinery is
// exercised instead by scripts/test-schema-facts-formatting.mjs's
// synthetic fixtures and backend/tests/test_schema_cards.py's real
// `refs` (152 parents) case, not by this byte-for-byte comparison.
//
// "Falsos avisos del marcado a medias y ajustes de los prompts de
// Proposal y fichas" round: expected-prompts.json regenerated again (via
// --update, no fixture-dump re-run needed this time -- Parts 2-4 are pure
// prompt-text edits, no backend/schema-cards data changed) for THREE more
// DELIBERATE reasons, all real prompt-content changes:
//   1. Part 4 -- buildSchemaFactsBlock (shared.js) now says explicitly,
//      in TWO places, that "allowed inside" (parents) is the same for
//      every schema variant and that "Differences by schema" only ever
//      covers attributes/children. This changes ask/multi-variant-para-
//      refused-notfound (the only fixed case with a multi-variant
//      element) -- motivated by a real Mistral answer claiming <para>'s
//      variants "differ in additional allowed parents (e.g. footnote)",
//      which is wrong on two counts (footnote is a children diff; parents
//      never vary by variant at all in this data model).
//   2. Part 2 -- buildSuggestProposalPrompt's (suggestProposalPrompt.js)
//      four "DO NOT MAKE THE DECISION" template examples were replaced,
//      because a real Mistral run copied them almost verbatim into actual
//      output, including one that was not even grammatically correct
//      English. This changes BOTH suggestProposal cases that reach that
//      block (all-three-groups, no-references-notfound). Before/after:
//        BEFORE:
//          - The [LIST: Descriptive, Procedural, IPD, ...] schemas shall be used ...
//          - The element <x> [YES/NO] be used.
//          - Nesting shall be limited to [VALUE: e.g. 4] levels.
//          - Permitted characters: [CHARACTERS: ...].
//        AFTER:
//          - Dates shall be written in [LIST: YYYY-MM-DD, DD-MM-YYYY, Month DD, YYYY] format.
//          - Illustrations [SHALL/SHALL NOT] use color to indicate hazard severity.
//          - Titles shall not exceed [VALUE: e.g. 60] characters.
//          - Measurements shall be expressed in [UNIT: e.g. metric, imperial] units.
//      The old YES/NO example ("The element <x> [YES/NO] be used.") is
//      missing its own modal verb -- Mistral was seen copying it as-is.
//      The new one ("Illustrations [SHALL/SHALL NOT] use color to
//      indicate hazard severity.") is a complete, grammatical sentence
//      where the placeholder IS the modal verb pair, so copying its SHAPE
//      copies something correct. None of the four new examples mentions
//      permitted schemas, "<element>" yes/no usage, nesting, or CAGE
//      codes (the very topics the model was seen copying) -- the
//      sentence right after the list, permitting the caller's own
//      free-form markers (confirmed working in the real Mistral test via
//      a self-invented "[CONVENTION: ...]"), is untouched.
//   3. Part 3 -- the "THE PREVIOUS PROPOSAL WAS REFUSED" block gained a
//      new paragraph (only emitted when `comments` is non-empty) telling
//      the model that a concrete restriction stated in the refusal reason
//      (a minimum, maximum, mandatory or forbidden value) must be
//      captured faithfully in the placeholder it writes, never overridden
//      by an unrelated invented example -- motivated by a real Mistral
//      run where a refusal reason of "real maintenance tasks need at
//      least 2 levels" still produced "[VALUE: e.g. 5, 8]". This changes
//      suggestProposal/refused-with-comments-wrongtype (the only fixed
//      case with a non-empty `comments`); an empty `comments` still
//      renders as the literal "not given" with no new paragraph at all
//      (unchanged from before this round).
//
// Suggest Rule round: a fourth group, `suggestRule`, added (5 NEW cases --
// BREX-4.2 with all three precedent blocks + schema facts, BREX-4.1 and
// BREX-3.0.1 with format examples only, SCH-DITA under XPath 2.0 with no
// references and under XPath 3.0 with a format example, so the queryBinding
// line of both dialects is pinned). The 11 existing cases are unchanged.
//
// Suggest Rule adjustments round: expected-prompts.json regenerated for
// ONE deliberate reason -- ruleFormatRules.js's BREX blocks. Rule 4 now
// asks for attributes as @name (and elements as &lt;name&gt;) in
// objectUse/objuse, and rule 5 (value lists) says objectPath selects the
// attribute/element with allowedObjectFlag="2" plus one objectValue per
// value, never a [. != 'a' and . != 'b'] predicate, with a minimal
// example on an invented attribute (@acmeCode / @acmecode for 3.0.1,
// where objappl is left out unless the node is also mandatory). Changes
// the 3 existing BREX suggestRule cases; the SCH-DITA ones and every
// Ask/Definition/Proposal case are unchanged. One case added,
// suggestRule/brex-4-2-value-list-proposal (the docs request's
// "@emphasisType shall only take em01 and em02" edge case).
//
// Schema-location encargo, Part 3: expected-prompts.json regenerated for
// ONE deliberate reason -- rule 6 of the three BREX blocks
// (ruleFormatRules.js). The old wording ("a literal < or & must be escaped
// as &lt; / &amp;") produced <objectPath>//&lt;emphasis&gt;</objectPath>
// in all three passes of a real Mistral run; rule 6 now says names go bare
// in objectPath/objpath (//emphasis, //@emphasisType -- //@emph in 3.0.1),
// &lt;/&amp; only for a < or & of the expression itself, with a correct
// and a wrong example on an invented element (acmeElement). Changes the 5
// BREX suggestRule cases; SCH-DITA and every Ask/Definition/Proposal case
// are unchanged.
//
// Prompt adjustments after the 0c19b28 photo against real Mistral:
// expected-prompts.json regenerated for two deliberate reasons, plus one NEW
// case. (1) suggestRulePrompt.js: with schemas chosen, the TASK now says the
// application adds the schema context, so <objectPath>/<objpath> never
// filters by schema (correct //acmeElement, wrong
// //acmeElement[ancestor::acmeSchema] and //acmeSchema//acmeElement) -- a
// real 3.0.1 run wrote //emphasis[ancestor-or-self::descript]; the
// "<objectUse> may name the schema" line also names 3.0.1's own element
// (<objuse>). Changes suggestRule/brex-4-2-proced-context; the NEW case
// suggestRule/brex-3-0-1-descript-context covers 3.0.1. With no schema
// chosen the prompt is unchanged byte for byte (every other BREX case).
// (2) ruleFormatRules.js, SCH-DITA rule 4: @context selects the elements,
// @test states the condition, never the condition in @context with
// test="false()" (correct/wrong example on acmeElement/@acmeAttr, never
// note/@type); test="false()" stays only for an absolute prohibition. 2 of 3
// real runs of rule-dita-xpath2-schematron wrote
// context="note[not(@type)]" + test="false()". Changes the two SCH-DITA
// cases. ASK_TEMPERATURE 1 -> 0.7 is not part of any prompt text, so no Ask
// case changes.
//
// Rule test on DM metadata: 2 NEW ruleTestExamples cases, no existing case
// changes (a rule that only looks at the content gets the same prompt as
// before) -- brex-4-2-metadata-infocode (//dmIdent/dmCode/@infoCode, the
// LLM writes the whole identAndStatusSection starting from the minimal one
// quoted in the prompt, and no content) and
// brex-4-2-metadata-and-content-assycode (//@assyCode[…]: the section AND
// the content are insertion points).
//
// Plantillas, Part 4: 2 NEW ruleTestExamples cases, no existing case changes
// -- brex-4-1-boolean-condition-tool-cir (EXT-00019 as the 4.1 template had
// it: a boolean objectPath, flag 0, plus the valid way down inside <update>
// of Part 3) and brex-4-2-boolean-condition-applicref-or (S1-00316 written
// with "or"). Both carry the "THE RULE CHECKS A CONDITION ON THE WHOLE
// DOCUMENT" block; a node path gets the same prompt as before.
//
// Attribute-only rules: new case
// ruleTestExamples/brex-4-2-attribute-only-material-usage (Lufthansa
// S1-00151, //@materialUsage): the test schema is proced (an element there
// carries the attribute) with the content inside <procedure> and the way
// down to <supportEquipDescr>/<supplyDescr>/<spareDescr> through
// <preliminaryRqmts>. The 45 earlier cases are unchanged (no attribute-only
// rule among them).
//
// Mejoras E, Part 1.4: new case
// ruleTestExamples/brex-3-0-1-schema-covered-accept-only (BRDP-EXT-02802,
// the listed children of <avee>): the schema already rules out what the
// rule forbids, so the prompt asks for examples meant to be accepted only
// and says why. Every earlier case is unchanged.
//
// Test de reglas, progreso y causas, Part 1.5: the two dossier cases
// (ruleTestExamples/dita-xpath3-dossier-safety-topic and
// dita-xpath2-dossier-safety-topic) gain the "WHERE THE RULE LOOKS" block,
// quoting the rule's expressions on the dossier's files. Only these two
// change; every other prompt is identical.
//
// GMC (valores, atributos y casos no ejecutables): the four rules that check
// an attribute on its own (//@x) gain, on purpose, where that attribute goes
// -- "@x goes on: <a>, <b> (N)" and the valid way to the nearest carrier
// (Part 1.2): ruleTestExamples/brex-4-2-value-list and
// brex-4-2-value-list-previous-review (//@emphasisType), brex-4-2-metadata-
// and-content-assycode (//@assyCode[…]) and brex-4-2-attribute-only-material-
// usage (//@materialUsage). New cases with the real GMC rules: EXT-00022
// (VALUES block: the value is @valueAllowed, Part 1.1; also in
// ruleProposalCheck), EXT-00037 (84 carriers, cut at 20), EXT-00057
// ("rootAttributes", Part 1.3), EXT-00079 (carrier in the identification
// and status section) and EXT-00107 (X//@a, Part 1.4). Every other prompt
// is identical.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
//
// Mejoras D: Suggest Rule's BREX format rules gain rule 7 ("its X" →
// ancestor::X in the condition, never //X); changed on purpose: the 7 BREX
// suggestRule cases. New case ruleTestExamples/brex-3-0-1-figure-legend-def
// (BRDP-EXT-02816: the content goes in <para0>, which holds <figure>, with
// the whole way para0/figure/legend/deflist/def). No other prompt changes:
// no other snapshot case changes its insertion point.

import { buildAskSystemPrompt } from '../src/prompts/askPrompt.js';
import { buildSuggestDefinitionPrompt } from '../src/prompts/suggestDefinitionPrompt.js';
import { buildSuggestProposalPrompt } from '../src/prompts/suggestProposalPrompt.js';
// Suggest Rule part 2 (schema context): one NEW case,
// suggestRule/brex-4-2-proced-context -- the chosen-schema TASK wording, a
// precedent's "Applies to" line and the CONTEXT BLOCKS note. The 17
// existing prompts are unchanged (a general rule and precedents without
// context blocks keep the old wording byte for byte).
import { buildSuggestRulePrompt } from '../src/prompts/suggestRulePrompt.js';
// Test rule (T2): a new group, ruleTestExamples (4 cases), for the prompt
// that asks for the test examples. No existing prompt changes.
//
// "Ask: comprobar los nombres de la respuesta" round: buildAskSystemPrompt
// gains a static paragraph (an element/attribute named in the answer must
// appear in SCHEMA FACTS or the BRDP; a concept with no facts -> "cannot
// confirm the name, look it up in the specification"), so all Ask cases
// change; buildUnknownNamesBlock's "do NOT exist" paragraph now also
// forbids the listed names bare or with other capitalisation (changes the
// notfound case). New case concept-without-facts-ncage-3-0-1 (the real
// @ncage report). Suggest and rule-test prompts are unchanged.
//
// "Aviso de nombres sin heurísticas y fichas sin hijos comunes" round: the
// multi-variant schema-facts card changed (buildSchemaFactsBlock): the
// header counts the schemas the card covers ("defined in 28 schemas"), not
// the variant groups ("common to all 8 schema variants"); the common lists
// are labelled "attributes/children common to all"; and a kind with
// nothing common but present somewhere is listed per schema group ("children
// depend on the schema (none common to all)") instead of "children: none".
// Only one existing case has a multi-variant card, ask/multi-variant-para-
// refused-notfound (<para>, 28 schemas); new case ask/children-vary-by-
// schema-identandstatussection (the real 4.2 <identAndStatusSection>).
// Single-variant cards (<table>) and every other prompt are unchanged.
import { buildRuleTestExamplesPrompt } from '../src/prompts/ruleTestExamplesPrompt.js';
// Test de reglas T3b: the examples follow the Proposal's DECISION, not the
// rule (the decision comes first, "the examples test THIS"; the rule only
// says which names and schemas are involved; a value restriction never
// makes an attribute or element mandatory; the reject example breaks
// exactly what the Proposal decides) and the LLM no longer explains the
// rule (describeRule does) -- all 5 ruleTestExamples cases change. New:
// ruleTestExamples/brex-4-2-value-list-previous-review (the "PREVIOUS
// EXAMPLES WERE WRONG" block after a review that blamed the examples), a
// new group ruleTestReview (the review prompt, 2 cases: a wrong flag-2
// rule and a wrong example) and suggestRule/brex-4-2-corrected-after-
// failed-test (the "PREVIOUS RULE FAILED ITS TEST" block). Every other
// prompt is unchanged.
//
// Test de reglas T4: two new ruleTestExamples cases for DITA Schematron
// (dita-xpath2-note-topic-body: topic type and topic/body insertion;
// dita-xpath2-root-whole-document: a root context, the LLM writes the whole
// topic). The DITA wording (topic type, ship or aircraft content, no S1000D
// reference elements) only applies to SCH-DITA: every existing prompt,
// the S1000D ruleTestExamples cases included, is unchanged.
//
// Test de reglas T4b: the two DITA ruleTestExamples cases change on
// purpose -- a topic's skeleton now carries its mandatory <title>, so the
// placement line says the application writes it (topic/body) or that the
// whole topic starts with it (root context). New case dita-xpath3-title-
// dependent-context: a context that depends on an element's title gets the
// "THE RULE DEPENDS ON A TITLE" block (a titled <section> around the
// checked table). Every S1000D prompt is unchanged.
//
// C2b Entrega 2, Parte 3 (correcciones): the chapter rule says "in the
// BRDP content below" in Ask, Suggest Definition and Suggest Proposal (the
// BRDP block always comes after it -- checked in each built prompt), and
// Suggest Proposal's opening no longer asks for "the concrete answer"
// (it contradicted DO NOT MAKE THE DECISION): a Proposal is the normative
// sentence with the choices left as placeholders. All 7 ask, 3
// suggestDefinition and 3 suggestProposal cases change; suggestRule and
// the rule-test prompts are unchanged.
//
// C2b Entrega 2, Parte 4 (fusiones), each instruction said once: Ask's
// 3-paragraph limit absorbs "even when the facts are long" (A9+A10), the
// comparison scope is one sentence (A4), and "if the facts do not cover
// what is asked" lives in Ask's own names paragraph, so Ask asks
// buildSchemaFactsBlock for its header without that last sentence
// (coverageNote: false -- Suggest Rule and the rule test keep it, their
// SCHEMA FACTS header is unchanged). Suggest Proposal: "do not copy their
// project-specific values" merges into the end of DO NOT MAKE THE
// DECISION (P3+P7). Suggest Rule: "never a context block" only in format
// rule 1 (now also in 3.0.1's), the TASK line points to it and the
// CONTEXT BLOCKS note keeps only its explanation (F1/R3b/R6); "never copy
// their names" only in the Format examples header (R5). All 7 ask, 3
// suggestProposal and 9 suggestRule cases change; suggestDefinition and
// the rule-test prompts are unchanged.
//
// C2b Entrega 2, Parte 5 (recortes): Ask's role names only the project's
// standard (A1: "an S1000D and DITA … expert" clashed with "do not mix
// other versions"), and "answer exactly what is asked" + "more than 15
// names: group" become one sentence that keeps the question -> relation
// correspondence (A5+A8: contain -> children, where / inside -> parents;
// never dump long lists, the full lists are in the card). Only what the
// parsers already strip is cut from the output lines: Suggest Rule keeps
// "no explanation" and the language line (R10), the rule-test examples
// keep "strict JSON, no comments" (T16), the review keeps "strict JSON"
// and its language line (V5). All 7 ask, 9 suggestRule, 9
// ruleTestExamples and 2 ruleTestReview cases change; suggestDefinition
// and suggestProposal are unchanged.
//
// C3, Parte 4: Ask's SCHEMA FACTS header gains one line (buildSchemaFactsBlock's
// userFacingName option, Ask only): "The user does not see this block by that
// name; if you refer to it, call it the schema card." -- a real answer said
// "(ver diferencias en SCHEMA FACTS)". Only the 3 ask cases that carry schema
// facts change; every other module is unchanged.
//
// Test rule, one schema per part of the rule: NEW case
// ruleTestExamples/brex-4-2-levels-split-by-schema (Lufthansa S1-00120,
// levelledPara → descript, proceduralStep → proced): the examples are split
// by schema. Every existing (single-group) prompt is unchanged.
//
// Templates round, minor items: a rule test that looks only at the DM metadata
// (contentInsertion false, "write no content") no longer says "A short piece
// of an aircraft maintenance manual… at most 10 lines of content", which
// contradicted it; it says to change only what the decision is about in the
// minimal section. Only ruleTestExamples/brex-4-2-metadata-infocode changes.
//
// Pending of the test rule, Part 1: a rule path with a descendant step A//B
// now gives, from the schema's graph, the shortest valid nesting ("To put <B>
// inside <A>, the valid nesting is: …"). Only the A//B cases change:
// ruleTestExamples/brex-3-0-1-mandatory-absolute (content//tgroup) and the
// NEW case ruleTestExamples/brex-4-2-nested-randomlist (S1-00507,
// //randomList//randomList). Every other prompt is unchanged.
//
// Ruta del esquema (identification and status section): a rule on an element
// that is not directly inside any element of the minimal section now gets,
// in its "metadata" instructions, the way down to it (and, with a single way,
// where its first container goes and that container's minimum with every
// required child; with several, every way, at most 3). Only NEW cases:
// ruleTestExamples/brex-4-2-metadata-deep-copyright (Lufthansa S1-00065,
// //copyright), brex-3-0-1-metadata-deep-copyright (status/datarest/inform),
// brex-4-2-pm-metadata-deep-copyright (pmStatus) and
// brex-4-2-metadata-several-ways (//dmStatus//externalPubRef). The 40
// existing prompts are unchanged -- none of them has deep metadata.
//
// "Ajustes tras Comparar dos BRDP": only a NEW case, ask/compare-other-project
// (compareBrdp.source = 'other_project', so the 'Project "<name>"
// (<standard>)' source label is covered). The 44 existing prompts are
// unchanged.
//
// Suggest Title: a new group, suggestTitle (2 cases); the 62 existing
// prompts are unchanged.
//
// AI Extract (2/2), free text: two new groups -- findDecisions (step 1: the
// two sample texts of the eval set and the text with instructions to the
// AI) and extractFromText (step 2: a new EXT whose Title came from step 1,
// a catalog identifier, a new EXT with the Title asked). 5 new cases; the
// 51 existing prompts are unchanged.
//
// AI Extract, free text: titles in English 1 of 3 times for the Spanish style
// guide (Mistral). Step 1 says the titles go in the text's language with its
// own "LANGUAGE OF THE TITLES" paragraph instead of a clause at the end of the
// title line. Only the 3 findDecisions cases change; the other 53 are
// unchanged.
//
// AI Extract, free text: with a Spanish text the AI-written Definition came
// out in English (Title and Proposal were Spanish) -- the only examples of
// the definition line were English ("Decide whether …"). The drafting prompt
// gives the opening in the quote's language ("Decidir si …" / "Decide
// whether …") and its LANGUAGE line names title, definition and proposal and
// says a given (catalog/project) text is never translated. Only the 2
// extractFromText cases change; the other 54 are unchanged.
//
// Barrido final 1/2: all ruleTestExamples cases change on purpose -- the
// "proposalMismatch" field leaves the examples prompt (the Proposal is
// now checked by its own call: new group ruleProposalCheck, 2 cases), and
// the two cases whose rule looks at tables (brex-3-0-1-mandatory-absolute,
// dita-xpath3-title-dependent-context) gain the MODEL TABLE block, a valid
// CALS table with a merged row built from the schema. Ask, Suggest, review
// and AI Extract prompts are unchanged.
//
// Mejoras B, Part 5: the BREX format rules (4.2, 4.1, 3.0.1) no longer say
// "exactly ONE <structureObjectRule>/<objrule>": normally one, and one rule
// per independent requirement with ids {ID}-1, {ID}-2…, each with its own
// path and use, never two paths in one rule; the TASK line says "ONE rule
// (or one rule per independent requirement, see format rule 1)". Only the 7
// BREX suggestRule cases change; the SCH-DITA ones and every other group are
// unchanged.
import { buildRuleTestReviewPrompt } from '../src/prompts/ruleTestReviewPrompt.js';
import { buildRuleProposalCheckPrompt } from '../src/prompts/ruleProposalCheckPrompt.js';
import { buildExtractFromRulesPrompt } from '../src/prompts/extractFromRulesPrompt.js';
import { buildExtractFromTextPrompt, buildFindDecisionsPrompt } from '../src/prompts/extractFromTextPrompt.js';
import { buildSuggestTitlePrompt } from '../src/prompts/suggestTitlePrompt.js';
import { askCases, extractFromRulesCases, extractFromTextCases, findDecisionsCases, ruleProposalCheckCases, ruleTestExamplesCases, ruleTestReviewCases, suggestDefinitionCases, suggestProposalCases, suggestRuleCases, suggestTitleCases } from './prompt-snapshot/cases.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXPECTED_PATH = path.join(__dirname, 'prompt-snapshot', 'expected-prompts.json');

function buildActual() {
  const actual = { ask: {}, suggestTitle: {}, suggestDefinition: {}, suggestProposal: {}, suggestRule: {}, ruleTestExamples: {}, ruleTestReview: {}, ruleProposalCheck: {}, extractFromRules: {}, findDecisions: {}, extractFromText: {} };
  for (const c of askCases) actual.ask[c.name] = buildAskSystemPrompt(...c.args);
  for (const c of suggestTitleCases) actual.suggestTitle[c.name] = buildSuggestTitlePrompt(...c.args);
  for (const c of suggestDefinitionCases) actual.suggestDefinition[c.name] = buildSuggestDefinitionPrompt(...c.args);
  for (const c of suggestProposalCases) actual.suggestProposal[c.name] = buildSuggestProposalPrompt(...c.args);
  for (const c of suggestRuleCases) actual.suggestRule[c.name] = buildSuggestRulePrompt(...c.args);
  for (const c of ruleTestExamplesCases) actual.ruleTestExamples[c.name] = buildRuleTestExamplesPrompt(...c.args);
  for (const c of ruleTestReviewCases) actual.ruleTestReview[c.name] = buildRuleTestReviewPrompt(...c.args);
  for (const c of ruleProposalCheckCases) actual.ruleProposalCheck[c.name] = buildRuleProposalCheckPrompt(...c.args);
  for (const c of extractFromRulesCases) actual.extractFromRules[c.name] = buildExtractFromRulesPrompt(...c.args);
  for (const c of findDecisionsCases) actual.findDecisions[c.name] = buildFindDecisionsPrompt(...c.args);
  for (const c of extractFromTextCases) actual.extractFromText[c.name] = buildExtractFromTextPrompt(...c.args);
  return actual;
}

const update = process.argv.includes('--update');
const actual = buildActual();

if (update) {
  writeFileSync(EXPECTED_PATH, JSON.stringify(actual, null, 2) + '\n');
  const total = Object.values(actual).reduce((n, o) => n + Object.keys(o).length, 0);
  console.log(`Updated ${EXPECTED_PATH} with ${total} prompt(s). Review the diff before committing.`);
  process.exit(0);
}

const expected = JSON.parse(readFileSync(EXPECTED_PATH, 'utf-8'));

let mismatches = 0;
let checked = 0;

for (const group of Object.keys(actual)) {
  const expectedNames = Object.keys(expected[group] || {});
  const actualNames = Object.keys(actual[group] || {});
  for (const name of new Set([...expectedNames, ...actualNames])) {
    checked++;
    const exp = expected[group]?.[name];
    const act = actual[group]?.[name];
    if (exp === undefined) {
      mismatches++;
      console.error(`NEW CASE (not in expected-prompts.json, run --update if intended): ${group}/${name}`);
      continue;
    }
    if (act === undefined) {
      mismatches++;
      console.error(`MISSING CASE (in expected-prompts.json but no longer produced): ${group}/${name}`);
      continue;
    }
    if (exp !== act) {
      mismatches++;
      console.error(`MISMATCH: ${group}/${name}`);
      const expLines = exp.split('\n');
      const actLines = act.split('\n');
      const max = Math.max(expLines.length, actLines.length);
      for (let i = 0; i < max; i++) {
        if (expLines[i] !== actLines[i]) {
          console.error(`  first differing line ${i + 1}:`);
          console.error(`    expected: ${JSON.stringify(expLines[i])}`);
          console.error(`    actual:   ${JSON.stringify(actLines[i])}`);
          break;
        }
      }
    }
  }
}

if (mismatches > 0) {
  console.error(`\n${mismatches}/${checked} case(s) drifted from expected-prompts.json.`);
  console.error('If this drift is intentional, review it carefully, then run: node scripts/check-prompt-snapshot.mjs --update');
  process.exit(1);
}

console.log(`${checked}/${checked} prompt(s) byte-identical to expected-prompts.json.`);
