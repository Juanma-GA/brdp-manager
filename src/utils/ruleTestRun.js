// Test rule: one generation of examples, from the rule to the engine runs --
// shared by the panel (hooks/useRuleTest.js) and the prompt eval harness
// (scripts/run-prompt-eval.mjs, type "rule-test"), so the eval measures
// exactly what the application does. Pure apart from the injected I/O:
//   ask(messages) → the LLM's text (the panel: sendMessage; the eval: the
//                   real /api/llm-proxy), at RULE_TEST_TEMPERATURE
//   fetchSchemaCards(standard, names) → GET /api/schema-cards response
//   fetchStructure(standard, schema) → GET /api/schema-cards/structure response
//   fetchSchemaAttribute(standard, name) → GET /api/schema-cards/attribute
//                   response (optional: which schemas carry the attribute of
//                   an attribute-only rule, //@materialUsage)
//   parseXml(text) → Document (browser default: DOMParser)
// Steps (T2b): the schema(s) and skeleton the examples are built on, the
// prompt, the LLM's answer, the checks of each example, ONE automatic
// correction round for the examples that fail them, and the engine run.
import { buildRuleTestCorrectionMessage, buildRuleTestExamplesPrompt, parseRuleTestResponse, RULE_TEST_USER_MESSAGE } from '../prompts/ruleTestExamplesPrompt.js';
import { buildRuleProposalCheckPrompt, parseRuleProposalCheckResponse, RULE_PROPOSAL_CHECK_USER_MESSAGE } from '../prompts/ruleProposalCheckPrompt.js';
import { extractRuleNames } from '../validation/schemaValidation.js';
import { contextSchemasOfRule } from './ruleSchemaContext.js';
import { describeRule, parseXmlDocument, ruleConditions, rulePathParts } from './ruleTestEngine.js';
import { stripLiterals, withoutPredicates } from './ruleTestCommon.js';
import { ancestorRelations, calsTableModel, chooseTestSchemas, placeExample, relationCases, ruleLooksAtBrexReference, ruleLooksAtTables, ruleMatchExpressions, ruleTargets, ruleUseNames, targetsForGroup } from './ruleTestSkeleton.js';
import { exampleProblems, materializeExample, runExample } from './ruleTest.js';
import { LLM_TRUNCATED } from '../api/llmTruncation.js';
import { cleanInternalNames } from './answerCleanup.js';

// Same cap as the schema facts of Ask / Suggest Rule.
const MAX_SCHEMA_FACTS = 6;

// Mejoras A, Part 2: a rule whose checked element must (not) be inside
// another one -- //x[not(ancestor::y)], //x[ancestor::y], parent:: too
// (ancestorRelations). The test needs an example the rule selects and one it
// does not; when the test schema allows only one of them, the other goes in
// the first schema (by preference, among those with the rule's elements)
// that allows it. → null (one schema, as before), { parts: [{ schema,
// relation }] } (the selected example's schema first) or { impossible:
// reason } when no schema allows one of them. A relation whose other
// element is not in the standard gets nothing special.
async function splitByRelation({ ruleXml, targets, cards, elementSchemas, testSchema, candidates, standard, fetchStructure }) {
  const known = (name) => Boolean(cards[name]) || Boolean(elementSchemas?.[name]?.length);
  const relation = ancestorRelations(ruleXml).find(
    (r) => targets.checked.includes(r.element) && known(r.ancestor) && r.element !== r.ancestor
  );
  if (!relation) return null;
  const structures = new Map();
  const casesIn = async (schema) => {
    if (!structures.has(schema)) {
      const structure = await fetchStructure(standard, schema);
      structures.set(schema, structure?.available ? relationCases(structure, relation) : null);
    }
    return structures.get(schema);
  };
  const here = await casesIn(testSchema);
  if (!here || (here.inside && here.outside)) return null;
  // The example the rule selects: outside for not(…), inside otherwise.
  const selectedInside = !relation.negated;
  const parts = [];
  for (const inside of [selectedInside, !selectedInside]) {
    let schema = null;
    for (const candidate of [testSchema, ...(candidates || []).filter((s) => s !== testSchema)]) {
      const cases = await casesIn(candidate);
      if (cases && (inside ? cases.inside : cases.outside)) {
        schema = candidate;
        break;
      }
    }
    if (!schema) {
      return {
        impossible: {
          code: 'example_impossible',
          params: { element: relation.element, other: relation.ancestor, axis: relation.axis, inside, standard },
        },
      };
    }
    parts.push({ schema, relation: { element: relation.element, ancestor: relation.ancestor, axis: relation.axis, negated: relation.negated, inside, selected: inside === selectedInside } });
  }
  return { parts };
}

// The schemas the examples use and where each takes the LLM's content.
export async function prepareRuleTestSetup({ ruleXml, standard, schemaLocation, fetchSchemaCards, fetchStructure, fetchSchemaAttribute }) {
  const contextSchemas = contextSchemasOfRule(ruleXml, schemaLocation).schemas;
  const targets = ruleTargets(ruleXml);
  const useNames = ruleUseNames(ruleXml);
  const factNames = extractRuleNames(ruleXml).elements.slice(0, MAX_SCHEMA_FACTS);
  const lookup = [
    ...new Set([
      ...factNames,
      ...targets.checked,
      ...targets.absolutePrefixes.map((p) => p[0]),
      // every element step, so the schema groups know where each part lives
      ...targets.alternatives.flatMap((a) => (a.opaque ? [] : a.steps)),
    ]),
  ];
  // Schema facts improve the examples but are never required; the schema
  // choice falls back to the standard's preference order without them.
  let cards = {};
  let documentSchemas = [];
  let elementSchemas = null;
  try {
    const res = await fetchSchemaCards(standard, lookup);
    cards = res.cards || {};
    documentSchemas = res.document_schemas || [];
    // DITA (T4): which topic types have each name.
    if (res.element_schemas && Object.keys(res.element_schemas).length) elementSchemas = res.element_schemas;
  } catch {
    // no facts
  }
  const schemaFacts = factNames.filter((n) => cards[n]).map((name) => ({ name, entry: cards[name] }));
  const attributeSchemas = await attributeOnlyCarriers(targets, standard, fetchSchemaAttribute, elementSchemas);
  const { testSchema, otherSchema, groups, candidates } = chooseTestSchemas({ contextSchemas, documentSchemas, cards, elementSchemas, attributeSchemas, targets });
  // Mejoras A, Part 2: //commonInfo[not(ancestor::procedure)] (BRDP-S1-00177)
  // was tested on proced only, where every <commonInfo> is inside
  // <procedure> -- the example the rule selects could not be written there.
  // splitByRelation puts it in another schema (process) and keeps the other
  // one in proced; when no schema allows one of them, the test says so
  // before any LLM call.
  const split =
    contextSchemas.length === 0 && !groups && testSchema
      ? await splitByRelation({ ruleXml, targets, cards, elementSchemas, testSchema, candidates, standard, fetchStructure })
      : null;
  if (split?.impossible) {
    return {
      contextSchemas,
      schemaFacts,
      promptPlacements: [],
      untested: [],
      unreachable: split.impossible,
      setup: { standard, schemaLocation, placements: {}, keepBrexReference: ruleLooksAtBrexReference(ruleXml) },
    };
  }
  const placements = {};
  const promptPlacements = [];
  // Parts of the rule that look only inside the identification and status
  // section of a document the application does not build it for (comment,
  // …): that schema is not offered -- the examples could only be invalid
  // (Mistral put <pmStatus> inside <content> before the pm had a section) --
  // and the result says which part was not tested and why.
  const untested = [];
  // One schema per part of the rule (groups), or the test schema and, for
  // a context-scoped rule, the "does not apply" one.
  const wanted = split
    ? split.parts.map((part) => ({ schema: part.schema, role: 'rule', targets, relation: part.relation }))
    : groups
    ? groups.map((g) => ({ schema: g.schema, role: 'rule', targets: targetsForGroup(targets, g), group: g.checked }))
    : [
        { schema: testSchema, role: 'rule', targets },
        { schema: otherSchema, role: 'other', targets },
      ];
  for (const { schema, role, targets: schemaTargets, group, relation } of wanted) {
    if (!schema) continue;
    const structure = await fetchStructure(standard, schema);
    if (!structure.available) continue;
    const placement = placeExample(structure, schemaTargets, {
      useNames,
      // The valid way down from the insertion point, in every S1000D schema
      // (contentRoutes gives nothing when every checked element goes
      // directly inside it). Plantillas 4.1/4.2: <parameter> only inside
      // <multimediaObject>, <supportEquipDescr> four levels below
      // <procedure> -- the skeleton reaching <para> is not enough.
      withRoutes: !String(standard).startsWith('DITA'),
      relation: relation || null,
    });
    if (placement.sectionMissing && role === 'rule') {
      untested.push({ schema, element: placement.sectionMissing.element, names: placement.sectionMissing.names });
    }
    if (placement.sectionMissing?.all) continue;
    placements[schema] = { structure, placement };
    promptPlacements.push({ schema, role, ...placement, ...(group ? { group } : {}) });
  }
  if (!promptPlacements.some((p) => p.role === 'rule') && untested.length > 0) {
    return {
      contextSchemas,
      schemaFacts,
      promptPlacements,
      untested,
      unreachable: {
        code: 'section_unavailable',
        params: {
          names: [...new Set(untested.flatMap((u) => u.names))].join(', '),
          schemas: [...new Set(untested.map((u) => u.schema))].join(', '),
        },
      },
      setup: { standard, schemaLocation, placements, keepBrexReference: ruleLooksAtBrexReference(ruleXml) },
    };
  }
  if (promptPlacements.length === 0) throw new Error(`No schema structure is available for ${standard}.`);
  // Rule test on DM metadata, Part 3: when nothing the examples of the test
  // schema(s) can contain is on any path of the rule, no example can ever
  // show it working -- said now, before any LLM call, instead of an
  // "inconclusive … regenerate" that no regeneration fixes.
  const rulePlacements = promptPlacements.filter((p) => p.role === 'rule');
  const unreachable =
    rulePlacements.length > 0 && rulePlacements.every((p) => p.unreachable)
      ? { code: 'unreachable_target', params: { names: [...new Set(rulePlacements.flatMap((p) => p.unreachable))].join(', ') } }
      : null;
  // Barrido final 1/2: a rule that looks at tables gets a model table with a
  // merged row in the prompt, built from the first test schema's structure.
  const firstRule = rulePlacements.find((p) => p.insertion) || rulePlacements[0];
  const tableModel =
    firstRule && ruleLooksAtTables(ruleXml, [...extractRuleNames(ruleXml).elements, ...targets.checked])
      ? calsTableModel(placements[firstRule.schema]?.structure)
      : null;
  return {
    contextSchemas,
    schemaFacts,
    promptPlacements,
    unreachable,
    untested,
    tableModel,
    setup: { standard, schemaLocation, placements, keepBrexReference: ruleLooksAtBrexReference(ruleXml), tableModel: Boolean(tableModel) },
  };
}

// For each attribute-only alternative of the rule (//@materialUsage), the
// schemas that have an element carrying the attribute -- read from the
// attribute owners (GET /api/schema-cards/attribute), which list the
// schemas of each carrier's card variant. S1000D only: the DITA cards are
// one merged schema, and the topic type of each carrier would need another
// lookup (an attribute-only Schematron context is not a real case). A
// failed lookup leaves that attribute out: the choice is then what it was
// before, never "not executable" because of a network error.
async function attributeOnlyCarriers(targets, standard, fetchSchemaAttribute, elementSchemas) {
  if (!fetchSchemaAttribute || elementSchemas) return null;
  const names = [
    ...new Set(
      targets.alternatives
        .filter((a) => !a.opaque && a.attribute && a.steps.length === 0 && !a.absolutePrefix)
        .map((a) => a.attribute)
    ),
  ];
  if (names.length === 0) return null;
  const out = {};
  for (const name of names) {
    try {
      const res = await fetchSchemaAttribute(standard, name);
      if (!res?.available) continue;
      out[name] = [...new Set((res.owners || []).flatMap((o) => o.schemas || []))];
    } catch {
      // not narrowed
    }
  }
  return out;
}

// T4b: an example meant to be rejected in which the rule selects nothing
// (no node on its paths, no node any Schematron context matches) can never
// be rejected -- the test then ends "inconclusive" although the example
// is valid. It goes to the correction round too, with what it must contain.
// Mejoras B, Part 1: the correction round fixes markup, it never pushes an
// example toward the rule:
//   - an example the rule already rejects is never sent (a mandatory part,
//     flag 1, rejects the parent that lacks the node, so nothing is
//     "selected": BRDP-S1-00219 was sent back and the LLM added the
//     <partSegment> -- since 007a9b1, when this check was written);
//   - with nodes of the path's kind none of which meets its predicates
//     (case b, run.predicateMiss), the example shows the decision and the
//     rule does not cover it: not sent (the verdict says why);
//   - with no node of that kind (case a) it is sent, naming the path
//     WITHOUT its predicates (never a value or a threshold), and only for
//     the parts that forbid or restrict (flag 0, flag 2, no objappl,
//     Schematron contexts) -- a mandatory part is never asked for.
// A context whose predicates cannot be removed safely (it uses a variable,
// or the stripped path does not evaluate) is sent back as before, naming
// the whole expression.
export function missesRuleProblem(example, run, ruleXml) {
  if (example.expected !== 'reject' || !run.result || run.result.status === 'not_executable') return null;
  if (run.result.status === 'rejected') return null;
  if (run.predicateMiss) return null;
  // Remates B, Part 1: a rejecting condition (Plantillas, Part 4: flag 0
  // rejects when true, flag 1 when false) selects no node. Case b -- the
  // example contains some of the names the condition looks at and does not
  // meet it -- is run.predicateMiss (above). Case a -- it contains none --
  // is sent back naming only those elements and attributes, never the
  // condition nor its values. Each part of a rule gets its own treatment:
  // a node path of the same rule follows the lines below.
  const details = run.acceptance;
  const lines = (details || [])
    .filter((d) => d.case === 'condition' && (d.flag === '0' || d.flag === '1') && d.names?.length > 0)
    .map((d) => conditionNamesProblem(d.names));
  const conditionPaths = new Set(
    (details || []).filter((d) => d.case === 'condition').map((d) => d.path)
  );
  const nodeDetails = details ? details.filter((d) => d.case !== 'condition') : null;
  const hasNodeParts = nodeDetails ? nodeDetails.length > 0 || details.length === 0 : (run.result.conditions || []).length === 0;
  if (!hasNodeParts || run.result.selectedNodePaths.length > 0) return [...new Set(lines)].join(' ') || null;
  let nodeLine = null;
  if (!nodeDetails || nodeDetails.some((d) => d.case === 'unsafe')) {
    const exprs = ruleMatchExpressions(ruleXml).filter((e) => !conditionPaths.has(e.replace(/\s+/g, ' ').trim()));
    if (exprs.length) {
      const matched = exprs.map((e) => `\`${e}\``).join(' or ');
      nodeLine = `This example must contain a node matched by: ${matched}. Nothing in it matches, so the rule never runs.`;
    }
  } else {
    const missingParts = nodeDetails.filter((d) => d.case === 'missing' && d.flag !== '1');
    const missing = [...new Set(missingParts.map((d) => d.stripped))];
    if (missing.length > 0) {
      const matched = missing.map((e) => `\`${e}\``).join(' or ');
      const stripped = missingParts.some((d) => d.stripped !== d.path) ? " (the rule's path without its predicates)" : '';
      nodeLine = `This example must contain a node matched by: ${matched}${stripped}. Nothing in it matches, so the rule never runs.`;
    }
  }
  return [...new Set([...lines, nodeLine].filter(Boolean))].join(' ') || null;
}

// Remates B, Part 1, case a: the names a condition looks at, none of which
// is in the example. Never the condition nor its values.
function conditionNamesProblem(names) {
  return `This example must contain the elements and attributes the rule's condition looks at: ${names.join(', ')}. It contains none of them, so the condition says nothing about it.`;
}

// C3, Part 1c: a rule that restricts VALUES only shows it accepts a valid
// value when an example meant to be accepted contains a node it selects --
// an accept example without the node is accepted for the wrong reason (the
// rule has nothing to look at). True for:
//   BREX: a part with objectValue / objval (allowedObjectFlag="2" or no
//         objappl: restricted values; flag 1: mandatory with values) --
//         never a prohibition (allowedObjectFlag="0" / objappl="0"), where
//         the correct accept example is precisely the one WITHOUT the node.
//         allowedObjectFlag="2" WITHOUT values restricts no value at all
//         (it rejects nothing; describeRule already warns "cannot reject"),
//         and asking for the node there would contradict a Proposal that
//         forbids it (eval case rule-test-4-2-wrong-rule-flag2), so it is
//         left out;
//   Schematron: an assert / report (not a warning, not a constant) whose
//         test compares a value: = != < > eq ne lt le gt ge, or
//         matches() / contains() / starts-with() / ends-with().
const VALUE_STATEMENTS = new Set([
  'describe_restricted_values',
  'describe_mandatory_values',
  'describe_mandatory_somewhere_values',
]);
const VALUE_TEST_RE = /!=|<|>|(?<![:!<>=])=|\b(?:eq|ne|lt|le|gt|ge)\b|\b(?:matches|contains|starts-with|ends-with)\s*\(/;

export function ruleRestrictsValues(ruleXml, format, parseXml = parseXmlDocument) {
  const description = describeRule(ruleXml, format, { parseXml });
  if (!description.available) return false;
  return description.statements.some(({ statement }) => {
    if (VALUE_STATEMENTS.has(statement.code)) return true;
    if (statement.code !== 'describe_sch_assert' && statement.code !== 'describe_sch_report') return false;
    if (statement.params.warning || statement.params.constant) return false;
    const test = stripLiterals(String(statement.params.test || '')).replace(/=>/g, ' ');
    return VALUE_TEST_RE.test(test);
  });
}

// The accept examples that must be sent back because none of them contains
// a node the value rule selects: every accept example that ran, gave a
// verdict and is in scope (an example of another schema, which the rule
// does not apply to, never counts). None when one of them already has the
// node, or when no accept example ran (the invalid ones are sent back for
// their own problems anyway).
function acceptWithoutNodeIndices(examples, runs, restrictsValues) {
  if (!restrictsValues) return [];
  const candidates = runs
    .map((r, index) => ({ r, index }))
    .filter(({ r, index }) =>
      examples[index].expected === 'accept' &&
      r.result &&
      r.result.status !== 'not_executable' &&
      !(r.result.outOfScopeSchemas?.length > 0)
    );
  if (candidates.length === 0 || candidates.some(({ r }) => r.result.selectedNodePaths.length > 0)) return [];
  return candidates.map(({ index }) => index);
}

// Remates B, Part 1, point 3: the path WITHOUT its predicates -- naming
// the predicates (a value, a threshold) would push the accept example
// toward the rule instead of toward the decision.
function acceptWithoutNodeProblem(ruleXml) {
  const matched = [...new Set(ruleMatchExpressions(ruleXml).map((e) => withoutPredicates(e).replace(/\s*(\/+)\s*/g, '$1')))]
    .map((e) => `\`${e}\``)
    .join(' or ');
  return `The rule checks values, so at least one example meant to be accepted must contain a node matched by: ${matched}, with a value the decision allows. No accept example contains one, so the test never shows the rule accepting a valid value.`;
}

// Ajustes tras la pasada real de las plantillas, Part 2: an example meant
// to be rejected that goes back to the correction round is always told to
// keep what the rule checks -- corrected without it, an LLM replaced the
// <changeInline> around an invalid <dmRef> with plain text (EXT-00040) and
// the test ended inconclusive. The line comes last, after the problems it
// has to fix. A valid reject example with no matched node gets
// missesRuleProblem instead (it already says what it must contain).
// Mejoras B, Part 1, point 4: what an invalid example meant to be
// rejected must keep while its markup is fixed -- never "add the node the
// rule looks for". parts: rulePathParts (ruleTestEngine.js); without it,
// the old line (callers that do not know the format).
//   flag 1 parts: do not change which elements are present or absent;
//   flag 0 / 2 / Schematron: keep the nodes of the path without its
//     predicates, and do not change what the example shows.
export function keepMatchedNodeProblem(ruleXml, conditions = [], parts = null) {
  // Remates B, Part 1, point 2: a condition part (flag 0 / 1) never gets a
  // "keep what makes it true / false" line -- that pushed the example
  // toward the rule. The neutral line instead: keep what the example shows.
  const conditionLine =
    'Do not change what this example shows (which elements and attributes it contains, or their values): fix only the markup named above.';
  if (!parts && conditions.length > 0 && conditions.length === ruleMatchExpressions(ruleXml).length) return conditionLine;
  if (!parts) {
    const matched = ruleMatchExpressions(ruleXml).map((e) => `\`${e}\``).join(' or ');
    return matched ? `Keep a node matched by ${matched}: fix the markup around it, do not remove it.` : null;
  }
  const nodeParts = parts.filter((p) => !p.condition);
  const lines = [];
  if (parts.some((p) => p.condition && (p.flag === '0' || p.flag === '1'))) lines.push(conditionLine);
  if (nodeParts.some((p) => p.flag === '1')) {
    lines.push('Do not change which elements are present or absent in this example: fix only the markup named above.');
  }
  const kept = [...new Set(nodeParts.filter((p) => p.flag !== '1').map((p) => p.stripped))];
  if (kept.length) {
    lines.push(
      `Keep the nodes matched by ${kept.map((e) => `\`${e}\``).join(' or ')}: fix only the markup named above, and do not change what the example shows (its nesting, how many elements there are, the values, or which element each attribute is on).`
    );
  }
  return lines.join(' ') || null;
}

// The examples the correction round must fix: [{ index, label, problems }].
export function exampleFailures(examples, materialized, runs, { ruleXml, standard, format = null, setup = null, parseXml = parseXmlDocument }) {
  const withoutNode = new Set(acceptWithoutNodeIndices(examples, runs, format ? ruleRestrictsValues(ruleXml, format, parseXml) : false));
  const ruleNames = extractRuleNames(ruleXml);
  const keep = keepMatchedNodeProblem(
    ruleXml,
    format ? ruleConditions(ruleXml, format, { parseXml }) : [],
    format ? rulePathParts(ruleXml, format, { parseXml }) : null
  );
  return runs
    .map((r, index) => {
      const missing = r.validation.runnable ? missesRuleProblem(examples[index], r, ruleXml) : null;
      const problems = r.validation.runnable
        ? [missing, withoutNode.has(index) ? acceptWithoutNodeProblem(ruleXml) : null].filter(Boolean)
        : exampleProblems(r.validation, {
            standard,
            schema: materialized[index].schema,
            ruleNames,
            nestings: setup?.placements?.[materialized[index].schema]?.placement?.nestings || [],
            expected: examples[index].expected,
            tableModel: Boolean(setup?.tableModel),
            sectionTree: setup?.placements?.[materialized[index].schema]?.placement?.metadata?.tree || null,
          });
      if (problems.length > 0 && !missing && keep && examples[index].expected === 'reject') problems.push(keep);
      return { index, label: examples[index].label, problems };
    })
    .filter((f) => f.problems.length > 0);
}

// Materialize, validate and run every example.
function runRuleTestExamples(examples, { ruleXml, format, setup, vocabulary, parseXml = parseXmlDocument }) {
  const materialized = examples.map((ex) => materializeExample(ex, setup, parseXml));
  const runs = materialized.map((ex) => runExample(ruleXml, format, ex, { vocabulary, parseXml }));
  return { materialized, runs };
}

// Barrido final 1/2, Part 2: does the rule implement the Proposal? Its own
// call (ruleProposalCheckPrompt.js), given the decision and the rule's
// deterministic description. `ask(messages, systemPrompt)` → the answer
// text (the caller sends it at RULE_PROPOSAL_CHECK_TEMPERATURE).
//   { status: 'implements' }                    -- "yes"
//   { status: 'partial', reason }               -- "partly" (Barrido final 3):
//     the examples' verdict stands, with an informative note
//   { status: 'mismatch', missing, reason }     -- "no": the LLM's sentence
//   { status: 'unavailable', error, truncated? } -- the call failed or did
//     not answer valid JSON: never read as "implements" (the verdict says
//     the Proposal could not be checked).
// Never throws.
export async function checkRuleImplementsProposal({ brdp, standard, format, ruleXml, ruleDescription, ask }) {
  const systemPrompt = buildRuleProposalCheckPrompt({ brdp, standard, format, ruleXml, ruleDescription });
  try {
    const answer = await ask([{ role: 'user', content: RULE_PROPOSAL_CHECK_USER_MESSAGE }], systemPrompt);
    const parsed = parseRuleProposalCheckResponse(answer);
    if (!parsed.ok) return { status: 'unavailable', error: parsed.error, systemPrompt, answer };
    if (parsed.level === 'yes') return { status: 'implements', systemPrompt, answer };
    const reason = cleanInternalNames(parsed.reason);
    if (parsed.level === 'partly') return { status: 'partial', reason, systemPrompt, answer };
    return { status: 'mismatch', missing: reason, reason, systemPrompt, answer };
  } catch (err) {
    return { status: 'unavailable', error: err?.message || String(err), truncated: err?.code === LLM_TRUNCATED, systemPrompt };
  }
}

// → { status: 'ready', proposalCheck, examples, runs,
//     correction, setup, systemPrompt, responses }
//   | { status: 'not_executable', reason, setup } -- the rule looks at
//     nothing the examples can contain (no LLM call)
//   | { status: 'error', error, badResponse?, truncated?, systemPrompt?, responses? }
//   truncated: the LLM's answer was cut by its length limit (ask threw
//   llmAPI.js's LLM_TRUNCATED error) -- said as such, never "not valid JSON".
//   | null when isCurrent() turned false (a newer generation started).
// onPrompt(systemPrompt) is called as soon as the prompt exists (Copy test
// prompt works even if the LLM then fails).
export async function generateRuleTestExamples({
  ruleXml,
  format,
  standard,
  schemaLocation,
  brdp,
  vocabulary,
  ask,
  fetchSchemaCards,
  fetchStructure,
  fetchSchemaAttribute,
  parseXml = parseXmlDocument,
  isCurrent = () => true,
  onPrompt,
  previousReview = null,
  // Barrido final 1/2: the Proposal check, run in parallel with the
  // examples (one more LLM call per test). Without askProposalCheck no
  // check is made and proposalCheck is null.
  askProposalCheck = null,
  ruleDescription = null,
}) {
  let systemPrompt = null;
  const responses = [];
  try {
    const prepared = await prepareRuleTestSetup({ ruleXml, standard, schemaLocation, fetchSchemaCards, fetchStructure, fetchSchemaAttribute });
    if (!isCurrent()) return null;
    if (prepared.unreachable) return { status: 'not_executable', reason: prepared.unreachable, setup: prepared.setup, untested: prepared.untested };
    // The schemas whose examples the application builds whole (rootOnly):
    // their examples come with no "content".
    const parseOptions = { contentOptionalSchemas: prepared.promptPlacements.filter((p) => p.rootOnly).map((p) => p.schema) };
    const checkPromise =
      askProposalCheck && ruleDescription != null
        ? checkRuleImplementsProposal({ brdp, standard, format, ruleXml, ruleDescription, ask: askProposalCheck })
        : Promise.resolve(null);
    systemPrompt = buildRuleTestExamplesPrompt({
      brdp,
      standard,
      format,
      ruleXml,
      contextSchemas: prepared.contextSchemas,
      placements: prepared.promptPlacements,
      schemaFacts: prepared.schemaFacts,
      previousReview,
      matchExpressions: ruleMatchExpressions(ruleXml),
      conditions: ruleConditions(ruleXml, format, { parseXml }),
      tableModel: prepared.tableModel,
    });
    onPrompt?.(systemPrompt);
    const run = (examples) => runRuleTestExamples(examples, { ruleXml, format, setup: prepared.setup, vocabulary, parseXml });
    const first = [{ role: 'user', content: RULE_TEST_USER_MESSAGE }];
    const answer = await ask(first, systemPrompt);
    responses.push(answer);
    if (!isCurrent()) return null;
    const parsed = parseRuleTestResponse(answer, parseOptions);
    if (!parsed.ok) {
      // Nothing runs on a broken answer (docs request).
      return { status: 'error', error: parsed.error, badResponse: true, systemPrompt, responses };
    }
    let { examples } = parsed;
    let { materialized, runs } = run(examples);

    // One automatic correction round (T2b, Part 3): the exact problems of
    // each failing example go back to the LLM once -- invalid examples and
    // (T4b) reject examples the rule never runs on. What still fails is
    // shown as it is, with its warnings -- never dropped.
    const failures = exampleFailures(examples, materialized, runs, { ruleXml, standard, format, setup: prepared.setup, parseXml });
    // Mejoras B, Part 1, point 6: the reject examples kept out of the
    // correction round because the rule's predicates leave their nodes out
    // (case b) -- the panel says how many.
    const predicateSkipped = runs.filter((r, i) => examples[i].expected === 'reject' && r.predicateMiss).length;
    let correction = null;
    if (failures.length > 0) {
      // `problems`: the exact lines sent for each example (the eval reads
      // them; Mejoras B, Part 6).
      correction = { attempted: failures.length, fixed: 0, failed: null, problems: failures.map((f) => ({ label: f.label, problems: f.problems })) };
      try {
        const again = await ask(
          [...first, { role: 'assistant', content: answer }, { role: 'user', content: buildRuleTestCorrectionMessage(failures) }],
          systemPrompt
        );
        responses.push(again);
        if (!isCurrent()) return null;
        const reparsed = parseRuleTestResponse(again, parseOptions);
        if (!reparsed.ok) {
          correction.failed = reparsed.error;
        } else {
          const failing = new Set(failures.map((f) => f.index));
          const next =
            reparsed.examples.length === examples.length
              ? examples.map((ex, i) => (failing.has(i) ? reparsed.examples[i] : ex))
              : reparsed.examples;
          const rerun = run(next);
          const still = new Set(exampleFailures(next, rerun.materialized, rerun.runs, { ruleXml, standard, format, setup: prepared.setup, parseXml }).map((f) => f.index));
          correction.fixed = failures.filter((f) => rerun.runs[f.index] && !still.has(f.index)).length;
          examples = next;
          ({ materialized, runs } = rerun);
        }
      } catch (err) {
        if (!isCurrent()) return null;
        correction.failed = err.message;
        // Respuestas cortadas: the correction was cut by the length limit.
        if (err?.code === LLM_TRUNCATED) correction.truncated = true;
      }
    }
    const proposalCheck = await checkPromise;
    if (!isCurrent()) return null;
    return {
      status: 'ready',
      proposalCheck,
      examples: materialized,
      runs,
      correction,
      predicateSkipped,
      setup: prepared.setup,
      untested: prepared.untested,
      systemPrompt,
      responses,
    };
  } catch (err) {
    if (!isCurrent()) return null;
    return { status: 'error', error: err.message, truncated: err?.code === LLM_TRUNCATED, systemPrompt, responses };
  }
}
