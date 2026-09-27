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

// Suggest Rule round (docs request): one case per rule format (BREX-4.2,
// BREX-4.1, BREX-3.0.1, SCH-DITA under both XPath dialects), covering the
// three precedent blocks, schema facts, and the no-reference case.
const brdpRule = {
  ...brdpBase,
  proposal: 'Every <table> shall have @frame set to "all".',
};
const ruleSameBrdp = [
  {
    id: 'r1',
    identifier: 'BRDP-S1-00042',
    source: 'Project Gamma',
    proposal: 'Tables shall be framed on all sides.',
    text: '<structureObjectRule id="BRDP-S1-00042"><objectPath allowedObjectFlag="2">//table/@frame</objectPath><objectUse>Frame</objectUse><objectValue valueForm="single" valueAllowed="all">All sides</objectValue></structureObjectRule>',
  },
];
const ruleSimilar = [
  {
    id: 'r2',
    identifier: 'BRDP-S1-00050',
    source: 'Project Delta',
    score: 0.71,
    proposal: 'Tables shall not use @pgwide.',
    text: '<structureObjectRule id="BRDP-S1-00050"><objectPath allowedObjectFlag="0">//table/@pgwide</objectPath><objectUse>No pgwide</objectUse></structureObjectRule>',
  },
];
const ruleFormatExamples = [
  {
    id: 'r3',
    identifier: 'BRDP-S1-00133',
    source: 'Template',
    proposal: 'The parameter element shall not be used.',
    text: '<structureObjectRule id="BRDP-S1-00133"><objectPath allowedObjectFlag="0">//parameter</objectPath><objectUse>Not used</objectUse></structureObjectRule>',
  },
];
const ruleFormatExamples301 = [
  {
    id: 'r4',
    identifier: 'BRDP-EXT-02634',
    source: 'Template',
    proposal: 'Column specifications inside table headers shall not be used.',
    text: '<objrule id="BRDP-EXT-02634"><objpath objappl="0">/dmodule/content//thead/colspec</objpath><objuse>No colspec in thead</objuse></objrule>',
  },
];
const ruleFormatExamplesDita = [
  {
    id: 'r5',
    identifier: 'BRDP-D1-00010',
    source: 'Template',
    proposal: 'Notes shall declare a type.',
    text: '<sch:pattern id="p-BRDP-D1-00010"><sch:rule context="note"><sch:assert id="BRDP-D1-00010" test="@type">A note must declare @type.</sch:assert></sch:rule></sch:pattern>',
  },
];

export const suggestRuleCases = [
  {
    name: 'brex-4-2-all-groups-with-facts',
    args: [brdpRule, 'S1000D 4.2', 'BREX-4.2', { sameBrdp: ruleSameBrdp, similar: ruleSimilar, formatExamples: ruleFormatExamples }, [{ name: 'table', entry: tableEntry }]],
  },
  {
    // Suggest Rule adjustments round: the docs request's value-list edge
    // case -- the prompt must carry rule 5's objectValue instruction with
    // its generic (@acmeCode) example, never this BRDP's own values.
    name: 'brex-4-2-value-list-proposal',
    args: [
      { ...brdpRule, title: 'Emphasis types', proposal: '@emphasisType shall only take em01 and em02.' },
      'S1000D 4.2',
      'BREX-4.2',
      { sameBrdp: [], similar: [], formatExamples: ruleFormatExamples },
      [],
    ],
  },
  {
    // Suggest Rule part 2: a Proposal limited to procedural data modules,
    // the user kept proced checked in the selector, and a format example
    // with context blocks (the shape of the template's BRDP-S1-00006: a
    // general rule plus three context-scoped //dmodule prohibitions).
    name: 'brex-4-2-proced-context',
    args: [
      { ...brdpRule, title: 'Emphasis in procedures', proposal: 'In procedural data modules, <emphasis> shall not be used.' },
      'S1000D 4.2',
      'BREX-4.2',
      {
        sameBrdp: [],
        similar: [],
        formatExamples: [
          {
            identifier: 'BRDP-S1-00006',
            source: 'Template',
            proposal: 'Descriptive, Procedural and IPD schemas shall be used as per Writing Style Guide',
            text: [
              '<structureObjectRule>\n  <objectPath allowedObjectFlag="2">//@xsi:noNamespaceSchemaLocation</objectPath>\n  <objectUse>BRDP-S1-00006. Schema location.</objectUse>\n</structureObjectRule>',
              ...['condcrossreftable', 'fault'].map(
                (schema) =>
                  `<contextRules rulesContext="http://www.s1000d.org/S1000D_4-2/xml_schema_flat/${schema}.xsd">\n  <structureObjectRuleGroup>\n    <structureObjectRule>\n      <objectPath allowedObjectFlag="0">//dmodule</objectPath>\n      <objectUse>BRDP-S1-00006. Not allowed.</objectUse>\n    </structureObjectRule>\n  </structureObjectRuleGroup>\n</contextRules>`
              ),
            ].join('\n'),
          },
        ],
      },
      [],
      { schemas: ['proced'] },
    ],
  },
  {
    name: 'brex-4-1-format-examples-only',
    args: [brdpRule, 'S1000D 4.1', 'BREX-4.1', { sameBrdp: [], similar: [], formatExamples: ruleFormatExamples }, []],
  },
  {
    name: 'brex-3-0-1-format-examples-only',
    args: [brdpRule, 'S1000D 3.0.1', 'BREX-3.0.1', { sameBrdp: [], similar: [], formatExamples: ruleFormatExamples301 }, []],
  },
  {
    // Prompt adjustments after the 0c19b28 photo: 3.0.1 with a chosen
    // schema -- the "no schema filter in <objpath>" paragraph and the
    // objuse/objpath element names of that issue.
    name: 'brex-3-0-1-descript-context',
    args: [
      { ...brdpRule, title: 'Emphasis in descriptions', proposal: 'In descriptive data modules, <emphasis> shall not be used.' },
      'S1000D 3.0.1',
      'BREX-3.0.1',
      { sameBrdp: [], similar: [], formatExamples: ruleFormatExamples301 },
      [],
      { schemas: ['descript'] },
    ],
  },
  {
    name: 'sch-dita-xpath2-no-references',
    args: [{ ...brdpRule, proposal: 'Every <note> shall declare @type.' }, 'DITA 1.3 Xpath2.0', 'SCH-DITA', { sameBrdp: [], similar: [], formatExamples: [] }, []],
  },
  {
    name: 'sch-dita-xpath3-format-examples',
    args: [{ ...brdpRule, proposal: 'Every <note> shall declare @type.' }, 'DITA 1.3 Xpath3.0', 'SCH-DITA', { sameBrdp: [], similar: [], formatExamples: ruleFormatExamplesDita }, []],
  },
];

// Test rule (T2): the examples prompt -- a general flag-0 rule with schema
// facts, a value-list rule, a proced-only rule (third example of another
// schema), and a 3.0.1 mandatory rule on an absolute path.
const brdpRuleTest = {
  identifier: 'BRDP-TEST-001',
  title: 'Use of the element <emphasis>',
  definition: 'Decide whether the element <emphasis> may be used in data modules.',
  proposal: 'El elemento <emphasis> no se utiliza.',
};
const ruleEmphasisFlag0 =
  '<structureObjectRule>\n  <objectPath allowedObjectFlag="0">//emphasis</objectPath>\n  <objectUse>BRDP-TEST-001. The element &lt;emphasis&gt; must not be used.</objectUse>\n</structureObjectRule>';
export const ruleTestExamplesCases = [
  {
    name: 'brex-4-2-general-flag0-with-facts',
    args: [{ brdp: brdpRuleTest, standard: 'S1000D 4.2', format: 'BREX-4.2', ruleXml: ruleEmphasisFlag0, schemaFacts: [{ name: 'table', entry: tableEntry }] }],
  },
  {
    name: 'brex-4-2-value-list',
    args: [
      {
        brdp: { ...brdpRuleTest, title: 'Emphasis types', proposal: '@emphasisType shall only take em01 and em02.' },
        standard: 'S1000D 4.2',
        format: 'BREX-4.2',
        ruleXml:
          '<structureObjectRule>\n  <objectPath allowedObjectFlag="2">//@emphasisType</objectPath>\n  <objectUse>Only em01 and em02.</objectUse>\n  <objectValue valueForm="single" valueAllowed="em01"/>\n  <objectValue valueForm="single" valueAllowed="em02"/>\n</structureObjectRule>',
      },
    ],
  },
  {
    name: 'brex-4-2-proced-context',
    args: [
      {
        brdp: { ...brdpRuleTest, proposal: 'In procedural data modules, <emphasis> shall not be used.' },
        standard: 'S1000D 4.2',
        format: 'BREX-4.2',
        ruleXml: `<contextRules rulesContext="http://www.s1000d.org/S1000D_4-2/xml_schema_flat/proced.xsd">\n<structureObjectRuleGroup>\n${ruleEmphasisFlag0}\n</structureObjectRuleGroup>\n</contextRules>`,
        contextSchemas: ['proced'],
        otherSchema: 'descript',
      },
    ],
  },
  {
    name: 'brex-3-0-1-mandatory-absolute',
    args: [
      {
        brdp: { ...brdpRuleTest, title: 'Table body', proposal: 'Every tgroup shall have a tbody.' },
        standard: 'S1000D 3.0.1',
        format: 'BREX-3.0.1',
        ruleXml: '<objrule id="R-1">\n  <objpath objappl="1">/dmodule/content//tgroup/tbody</objpath>\n  <objuse>Every tgroup needs a tbody.</objuse>\n</objrule>',
      },
    ],
  },
];
