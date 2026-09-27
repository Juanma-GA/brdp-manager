// "Ajustes al juego de pruebas de prompts" round, Part 5: the fixed set of
// inputs fed to the real prompt builders (src/prompts/askPrompt.js/
// suggestDefinitionPrompt.js/suggestProposalPrompt.js) by
// scripts/check-prompt-snapshot.mjs, committed to the repo so a future
// refactor of those builders (or of anything they call into, like
// vocabularyCheck.js) can be checked for accidental prompt drift with
// `node scripts/check-prompt-snapshot.mjs`, without needing a live backend,
// Postgres, or a real LLM provider.
//
// This is the permanent version of what the "Refactor del asistente" round
// only ever built as scratch files (never committed -- see this round's own
// CLAUDE.md entry for why that was a gap). The <para>/<table> schema-facts
// entries below are NOT hand-typed: they're the REAL, already-compacted
// output of app.services.schema_cards.get_schema_cards() for S1000D 4.2,
// captured into schema-cards-fixture.json by
// backend/scripts/dump_schema_cards_fixture.py -- so they already reflect
// whatever compaction rules are live today, including this same round's
// Part 4 fix (a short enum like objectPath's allowedObjectFlag stays a
// plain list; <para>'s 99-value @caveat/@securityClassification still
// collapse to a single range each, since 99 > MAX_ENUM_VALUES). Re-run that
// script (see its own docstring) if backend/schema_cards/*.json is ever
// regenerated, then regenerate expected-prompts.json from the new fixture
// with `node scripts/check-prompt-snapshot.mjs --update`.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const realCards = JSON.parse(readFileSync(path.join(__dirname, 'schema-cards-fixture.json'), 'utf-8'));
const paraEntry = realCards['S1000D 4.2'].para;
const tableEntry = realCards['S1000D 4.2'].table;

const brdpBase = {
  identifier: 'BRDP-S1-00042',
  title: 'Table frame attribute',
  definition: 'Governs when the <table> element uses a frame.',
  proposal: 'The frame attribute shall be set to "all".',
  validation: 'Validated',
  comments: '',
};

const brdpRefused = {
  ...brdpBase,
  identifier: 'BRDP-S1-00099',
  validation: 'Refused',
  comments: 'Too broad, needs a narrower scope.',
};

const ruleApprovalVerified = {
  rule_xml: '<sch:pattern id="p1"><sch:rule context="//table"><sch:assert test="@frame">msg</sch:assert></sch:rule></sch:pattern>',
  status: 'approved',
};
const ruleApprovalDraft = { rule_xml: '<sch:pattern id="p2"/>', status: 'pending_review' };
const ruleApprovalNone = null;

const compareBrdpRecords = {
  source: 'records',
  identifier: 'BRDP-S1-00010',
  title: 'Compare title',
  definition: 'Compare definition.',
  proposal: 'Compare proposal.',
  validation: 'Validated',
  ruleState: 'verified',
  ruleXml: '<sch:pattern id="cmp"/>',
};

const compareBrdpCatalog = {
  source: 'catalog',
  identifier: 'BRDP-CAT-001',
  title: 'Catalog title',
  definition: 'Catalog definition.',
};

const vocabNone = null;
const vocabClean = { available: true, notFound: [], wrongType: [] };
const vocabNotFound = { available: true, notFound: ['<pokemon>', '<stranger>'], wrongType: [] };
const vocabWrongType = {
  available: true,
  notFound: [],
  wrongType: [{ name: 'label', usedAs: 'element', actualAs: 'attribute' }],
};
const vocabUnavailable = { available: false, notFound: [], wrongType: [] };

const similarDefinitionSample = [
  { id: 'a1', identifier: 'BRDP-S1-00001', title: 'Similar A', text: 'Definition A text.', source: 'Records: Demo Project', score: 0.91 },
  { id: 'a2', identifier: 'BRDP-CAT-002', title: 'Similar B', text: 'Definition B text.', source: 'Catalog', score: 0.85 },
];
const styleReferencesSample = [
  { id: 'b1', identifier: 'BRDP-S1-00003', title: 'Style A', text: 'Style A definition text.', source: 'Records: Demo Project' },
];

const sameBrdpSample = [
  { id: 'c1', identifier: 'BRDP-S1-00042', text: 'Other project decided: frame shall be "top".', source: 'Project Beta' },
  { id: 'c2', identifier: 'BRDP-S1-00042', text: 'Other project decided: frame shall be "all".', source: 'Project Gamma' },
];
const similarProposalSample = [{ id: 'd1', identifier: 'BRDP-S1-00050', definition: 'Def D.', text: 'Proposal D.', source: 'Project Delta', score: 0.77 }];
const thisProjectSample = [{ id: 'e1', identifier: 'BRDP-S1-00060', definition: 'Def E.', text: 'Proposal E.', score: 0.66 }];

export const askCases = [
  {
    name: 'single-variant-no-compare-clean-vocab',
    args: [brdpBase, ruleApprovalVerified, null, 'S1000D 4.2', vocabClean, [{ name: 'table', entry: tableEntry }]],
  },
  {
    name: 'multi-variant-para-refused-notfound',
    args: [brdpRefused, ruleApprovalDraft, null, 'S1000D 4.2', vocabNotFound, [{ name: 'para', entry: paraEntry }]],
  },
  {
    name: 'compare-records-wrongtype-todo',
    args: [brdpBase, ruleApprovalNone, compareBrdpRecords, 'S1000D 4.2', vocabWrongType, []],
  },
  {
    name: 'compare-catalog-unavailable-no-facts',
    args: [brdpBase, ruleApprovalVerified, compareBrdpCatalog, 'DITA 1.3 Xpath2.0', vocabUnavailable, []],
  },
  {
    name: 'no-vocab-no-facts-no-compare',
    args: [brdpBase, ruleApprovalVerified, null, 'S1000D 3.0.1', vocabNone, []],
  },
];

export const suggestDefinitionCases = [
  { name: 'with-similar-and-style', args: [brdpBase, 'S1000D 4.2', similarDefinitionSample, styleReferencesSample, vocabClean] },
  { name: 'no-references-notfound', args: [brdpBase, 'S1000D 4.2', [], [], vocabNotFound] },
  { name: 'only-similar-empty-fields', args: [{ ...brdpBase, definition: '', proposal: '' }, 'DITA 1.3 Xpath3.0', similarDefinitionSample, [], vocabNone] },
];

export const suggestProposalCases = [
  { name: 'all-three-groups', args: [brdpBase, 'S1000D 4.2', sameBrdpSample, similarProposalSample, thisProjectSample, vocabClean] },
  { name: 'refused-with-comments-wrongtype', args: [brdpRefused, 'S1000D 4.2', [], [], [], vocabWrongType] },
  { name: 'no-references-notfound', args: [{ ...brdpBase, proposal: '' }, 'DITA 1.3 Xpath2.0', [], [], [], vocabNotFound] },
];
