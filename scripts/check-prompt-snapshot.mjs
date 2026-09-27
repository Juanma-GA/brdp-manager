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
