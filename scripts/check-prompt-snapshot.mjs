// "Ajustes al juego de pruebas de prompts" round, Part 5: permanent,
// committed byte-for-byte comparison of the real prompt builders
// (src/prompts/askPrompt.js/suggestDefinitionPrompt.js/
// suggestProposalPrompt.js) against a fixed set of expected outputs
// (expected-prompts.json), built from a fixed set of inputs
// (prompt-snapshot/cases.mjs). A future refactor of those builders, or of
// anything they call into (vocabularyCheck.js's summarizeSchemaFactEntry/
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
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { buildAskSystemPrompt } from '../src/prompts/askPrompt.js';
import { buildSuggestDefinitionPrompt } from '../src/prompts/suggestDefinitionPrompt.js';
import { buildSuggestProposalPrompt } from '../src/prompts/suggestProposalPrompt.js';
import { askCases, suggestDefinitionCases, suggestProposalCases } from './prompt-snapshot/cases.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXPECTED_PATH = path.join(__dirname, 'prompt-snapshot', 'expected-prompts.json');

function buildActual() {
  const actual = { ask: {}, suggestDefinition: {}, suggestProposal: {} };
  for (const c of askCases) actual.ask[c.name] = buildAskSystemPrompt(...c.args);
  for (const c of suggestDefinitionCases) actual.suggestDefinition[c.name] = buildSuggestDefinitionPrompt(...c.args);
  for (const c of suggestProposalCases) actual.suggestProposal[c.name] = buildSuggestProposalPrompt(...c.args);
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

for (const group of ['ask', 'suggestDefinition', 'suggestProposal']) {
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
