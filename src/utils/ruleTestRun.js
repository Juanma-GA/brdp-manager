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
import { extractRuleNames, extractRuleXPaths } from '../validation/schemaValidation.js';
import { contextSchemasOfRule } from './ruleSchemaContext.js';
import { describeRule, parseXmlDocument, ruleConditions, rulePathParts, rootSelfPath } from './ruleTestEngine.js';
import { minimalDocumentRuns } from './ruleMinimalDocuments.js';
import { stripLiterals, withoutPredicates } from './ruleTestCommon.js';
import { ancestorRelations, calsTableModel, chooseTestSchemas, placeExample, relationCases, ruleLooksAtBrexReference, ruleLooksAtTables, ruleMatchExpressions, ruleTargets, ruleUseNames, targetsForGroup } from './ruleTestSkeleton.js';
import { exampleProblems, materializeExample, runExample } from './ruleTest.js';
import { elementPlaces } from './schemaPlacement.js';
import { LLM_TRUNCATED } from '../api/llmTruncation.js';
import { cleanInternalNames } from './answerCleanup.js';
import { absoluteConditionRequirements, checkRulePaths, documentExistenceNames, pathAlternatives, pathOperands, pathSteps } from '../validation/rulePathCheck.js';
import { coverageItemEnglish, documentPresence, schemaCoverage } from '../validation/schemaCoverage.js';
import { repeatingComparisons, singleChildPairs, viewFromStructure } from '../validation/ruleRepetition.js';
import { STANDARD_TO_RULE_FORMAT } from '../constants/ruleFormats.js';

// Mejoras C, Part 1: at most this many path problems are recorded with a
// "review" result (the panel shows them all, from the rule itself).
const MAX_RECORDED_PATH_PROBLEMS = 10;

// The paths of the rule against the standard's element graph, before any
// LLM call: when every node path of the rule can never select anything
// (<trade> inside <perscat>, /techstd as a root), the test answers "review"
// with the reason -- no example could show anything. Without a graph (no
// fetcher, the standard has none, or it failed to load) nothing is checked.
async function loadGraph(fetchSchemaGraph, standard) {
  if (!fetchSchemaGraph) return null;
  try {
    return await fetchSchemaGraph(standard);
  } catch {
    return null;
  }
}

function impossiblePathReview({ ruleXml, format, schemaLocation, graph, parseXml }) {
  if (!graph) return null;
  const check = checkRulePaths(ruleXml, format, graph, { schemaLocation, parseXml });
  if (!check.allImpossible) return null;
  const problems = check.problems.filter((p) => !p.inPredicate).slice(0, MAX_RECORDED_PATH_PROBLEMS);
  return { code: 'test_impossible_path', params: { format, problems } };
}

// ─── Mejoras F, Part 1.2: a rule on the document's root ───────────────────
// /*[not(self::dmodule)] (BRDP-EXT-02770): the test schema was descript and
// both examples had a <dmodule> root -- the rule can only be shown with
// documents of different types, which nothing the LLM writes changes. Such
// a rule (every part a BREX path that is ONLY the root step, /* or /name,
// with predicates testing only self::, flag 0 or 1, no values) is tested
// without examples from the LLM: the rule is run on the minimal document of
// every schema (ruleMinimalDocuments.js); one example is the minimal
// document of a schema it accepts, the other of one it rejects (the first
// of each group by preference), both "built by the application". No schema
// rejected → "Already covered by the schema"; every one rejected → review.
const BREX_FORMATS = new Set(['BREX-4.2', 'BREX-4.1', 'BREX-3.0.1']);
const ROOT_TEST_ACCEPT_PREFERENCE = ['descript', 'proced', 'process', 'fault', 'ipd', 'schedul', 'crew', 'comrep', 'sb'];
const ROOT_TEST_REJECT_PREFERENCE = ['pm', 'ddn', 'dml', 'comment'];

export function isRootSelfRule(ruleXml, format, options = {}) {
  if (!BREX_FORMATS.has(format)) return false;
  if (/<(?:objectValue|objval)\b/.test(String(ruleXml || ''))) return false;
  const parts = rulePathParts(ruleXml, format, options);
  return parts.length > 0 && parts.every((p) => !p.condition && (p.flag === '0' || p.flag === '1') && rootSelfPath(p.path));
}

function firstByPreference(schemas, preference) {
  const rank = (s) => {
    const i = preference.indexOf(s);
    return i === -1 ? preference.length : i;
  };
  return [...schemas].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))[0] || null;
}

function minimalExample(run, expected, schemaLocation) {
  return {
    label: run.schema,
    expected,
    schema: run.schema,
    content: '',
    xml: run.xml,
    skeletonNodePaths: run.skeletonNodePaths,
    schemaLocation: schemaLocation || null,
    structure: null,
    insertion: null,
    contentInsertion: false,
    // Built by the application, never edited: the minimal document of its
    // schema, with nothing written for the test.
    minimalDocument: true,
  };
}

function rootElementOf(xml) {
  const m = /<([A-Za-z_][\w.-]*)[\s>]/.exec(String(xml || ''));
  return m ? m[1] : null;
}

// → null (not a root rule, or no minimal documents) | the 'ready' result.
export function rootRuleTest({ ruleXml, format, standard, schemaLocation, graph, vocabulary, parseXml }) {
  if (!graph || !isRootSelfRule(ruleXml, format, { parseXml, schemaLocation })) return null;
  const minimal = minimalDocumentRuns(ruleXml, format, graph, { standard, schemaLocation, parseXml });
  if (!minimal.available || minimal.counted === 0) return null;
  const bySchema = new Map(minimal.results.map((r) => [r.schema, r]));
  const examples = [];
  let coverage = null;
  const accepted = firstByPreference(minimal.accepted, ROOT_TEST_ACCEPT_PREFERENCE);
  const rejected = firstByPreference(minimal.rejected, ROOT_TEST_REJECT_PREFERENCE);
  if (accepted) examples.push(minimalExample(bySchema.get(accepted), 'accept', schemaLocation));
  if (rejected) examples.push(minimalExample(bySchema.get(rejected), 'reject', schemaLocation));
  if (!rejected) {
    const roots = [...new Set(minimal.accepted.map((s) => rootElementOf(bySchema.get(s).xml)).filter(Boolean))];
    coverage = { items: [{ ruleId: null, kind: 'rootsAllowed', element: roots.join('>, <'), roots }] };
  } else if (!accepted) {
    coverage = { rootAllRejected: true, schemas: minimal.rejected };
  }
  const runs = examples.map((ex) => runExample(ruleXml, format, ex, { vocabulary, parseXml, schemaLocation }));
  return { status: 'ready', coverage, examples, runs, minimal, rootRule: true };
}

// Mejoras G, Part 2.3: "every document must contain <x>" -- /*[not(P)] or
// /R[not(P)], flag 0 (schemaCoverage.js documentPresence). When no schema
// of the scope depends on the document (P is either always there or can
// never be there), no examples from the LLM: one is the minimal document of
// a schema where it is always there (accepted), the other, if any, of one
// where it cannot exist (rejected) -- like the rules on the root. None of
// the second kind → "Already covered by the schema"; only the second kind →
// review. BRDP-EXT-02715 /*[not(//dmaddres)].
export function documentPresenceTest({ ruleXml, format, standard, schemaLocation, graph, vocabulary, parseXml }) {
  if (!graph) return null;
  const presence = documentPresence(ruleXml, format, graph, { parseXml, schemaLocation });
  if (!presence || presence.depends.length > 0) return null;
  const minimal = minimalDocumentRuns(ruleXml, format, graph, { standard, schemaLocation, parseXml });
  if (!minimal.available) return null;
  const bySchema = new Map(minimal.results.map((r) => [r.schema, r]));
  const acceptable = presence.always.filter((s) => bySchema.get(s)?.status === 'accepted');
  const rejectable = presence.cannot.filter((s) => bySchema.get(s)?.status === 'rejected');
  if (acceptable.length === 0 && rejectable.length === 0) return null;
  const examples = [];
  const accepted = firstByPreference(acceptable, ROOT_TEST_ACCEPT_PREFERENCE);
  const rejected = firstByPreference(rejectable, ROOT_TEST_REJECT_PREFERENCE);
  // The note under each example says what decides it (not "only the root").
  // presenceNames (Remates de Mejoras G, Part 1.3): the whole path, so the
  // note names "<qa> inside <status>", not only <qa>.
  const withTarget = (ex) => ({ ...ex, presenceTarget: `<${presence.target}>`, presenceNames: presence.names });
  if (accepted) examples.push(withTarget(minimalExample(bySchema.get(accepted), 'accept', schemaLocation)));
  if (rejected) examples.push(withTarget(minimalExample(bySchema.get(rejected), 'reject', schemaLocation)));
  let coverage = null;
  if (presence.cannot.length === 0) {
    const roots = [...new Set(presence.always.map((s) => rootElementOf(bySchema.get(s)?.xml)).filter(Boolean))];
    coverage = { items: [{ ruleId: null, kind: 'documentAlways', element: presence.target, other: roots.join('>, <') || presence.root }] };
  } else if (presence.always.length === 0) {
    coverage = { rootAllRejected: true, schemas: presence.cannot };
  }
  const runs = examples.map((ex) => runExample(ruleXml, format, ex, { vocabulary, parseXml, schemaLocation }));
  return { status: 'ready', coverage, examples, runs, minimal, rootRule: true, presence };
}

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
// acceptOnly (Mejoras E, Part 1.4): the schema already rules out what the
// rule forbids (schemaCoverage.js) -- only examples meant to be accepted are
// written, so the relation split (one example inside, one outside) is not
// needed: the "outside" example cannot exist.
export async function prepareRuleTestSetup({ ruleXml, standard, schemaLocation, fetchSchemaCards, fetchStructure, fetchSchemaAttribute, acceptOnly = false, format = null, parseXml = parseXmlDocument }) {
  const contextSchemas = contextSchemasOfRule(ruleXml, schemaLocation).schemas;
  // Mejoras F, Part 1.3: absolute paths the checked step's condition needs
  // (BREX only; Schematron DITA unchanged).
  const conditionRequirements = format && format.startsWith('BREX') ? absoluteConditionRequirements(ruleXml, format, { parseXml, schemaLocation }) : [];
  const targets = {
    ...ruleTargets(ruleXml),
    containNames: format && format.startsWith('BREX') ? documentExistenceNames(ruleXml, format, { parseXml, schemaLocation }) : [],
  };
  const useNames = ruleUseNames(ruleXml);
  const factNames = extractRuleNames(ruleXml).elements.slice(0, MAX_SCHEMA_FACTS);
  const lookup = [
    ...new Set([
      ...factNames,
      ...targets.checked,
      ...targets.absolutePrefixes.map((p) => p[0]),
      // every element step, so the schema groups know where each part lives
      ...targets.alternatives.flatMap((a) => (a.opaque ? [] : a.steps)),
      ...conditionRequirements.flat(2),
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
  const { testSchema, otherSchema, groups, candidates, noConditionSchema } = chooseTestSchemas({ contextSchemas, documentSchemas, cards, elementSchemas, attributeSchemas, targets, conditionRequirements });
  if (noConditionSchema) {
    return {
      contextSchemas,
      schemaFacts,
      promptPlacements: [],
      untested: [],
      unreachable: {
        code: 'condition_no_schema',
        params: { paths: noConditionSchema.map((names) => `/${names.join('/')}`).join(' | '), standard },
      },
      setup: { standard, schemaLocation, placements: {}, keepBrexReference: ruleLooksAtBrexReference(ruleXml) },
    };
  }
  // Mejoras A, Part 2: //commonInfo[not(ancestor::procedure)] (BRDP-S1-00177)
  // was tested on proced only, where every <commonInfo> is inside
  // <procedure> -- the example the rule selects could not be written there.
  // splitByRelation puts it in another schema (process) and keeps the other
  // one in proced; when no schema allows one of them, the test says so
  // before any LLM call.
  const split =
    contextSchemas.length === 0 && !groups && testSchema && !acceptOnly
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
  const place = (structure, schemaTargets, relation) =>
    placeExample(structure, schemaTargets, {
      useNames,
      // The valid way down from the insertion point, in every S1000D schema
      // (contentRoutes gives nothing when every checked element goes
      // directly inside it). Plantillas 4.1/4.2: <parameter> only inside
      // <multimediaObject>, <supportEquipDescr> four levels below
      // <procedure> -- the skeleton reaching <para> is not enough.
      withRoutes: !String(standard).startsWith('DITA'),
      relation: relation || null,
    });
  // Mejoras D, Part 1: a schema where no insertion point holds the
  // outermost element of the rule's path; the next candidate is tried.
  const noRoom = [];
  for (const item of wanted) {
    let { schema } = item;
    const { role, targets: schemaTargets, group, relation } = item;
    if (!schema) continue;
    let structure = await fetchStructure(standard, schema);
    if (!structure.available) continue;
    let placement = place(structure, schemaTargets, relation);
    if (placement.entryMissing && role === 'rule' && !group && !relation && contextSchemas.length === 0) {
      let replaced = false;
      for (const candidate of (candidates || []).filter((c) => c !== schema && !placements[c])) {
        const other = await fetchStructure(standard, candidate);
        if (!other.available) continue;
        const otherPlacement = place(other, schemaTargets, relation);
        if (!otherPlacement.entryMissing) {
          schema = candidate;
          structure = other;
          placement = otherPlacement;
          replaced = true;
          break;
        }
      }
      if (!replaced) {
        noRoom.push(placement.entryMissing);
        continue;
      }
    }
    // Mejoras C, Part 2: where each element the rule names goes, when it
    // does not fit where the LLM writes and no route above says it already.
    placement.places = placementPlaces(structure, placement, ruleXml);
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
  if (!promptPlacements.some((p) => p.role === 'rule') && noRoom.length > 0) {
    return {
      contextSchemas,
      schemaFacts,
      promptPlacements: [],
      untested,
      unreachable: {
        code: 'example_no_room',
        params: {
          outer: [...new Set(noRoom.flatMap((n) => n.outer))].map((n) => `<${n}>`).join(', '),
          checked: [...new Set(noRoom.flatMap((n) => n.checked))].map((n) => `<${n}>`).join(', '),
          standard,
        },
      },
      setup: { standard, schemaLocation, placements: {}, keepBrexReference: ruleLooksAtBrexReference(ruleXml) },
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
  // Mejoras G, Parts 1.4 and 1.6, read from the test schemas' structures:
  // the parent/child pairs the rule names that the schema allows only once
  // ("at most one <evaluate> inside <applic>"), and the paths the rule
  // compares with that can give several nodes (examples with several).
  const views = rulePlacements.map((p) => viewFromStructure(placements[p.schema]?.structure)).filter(Boolean);
  const ruleFormat = format || STANDARD_TO_RULE_FORMAT[standard] || null;
  const limits = ruleFormat ? singleChildPairs(ruleXml, ruleFormat, views, { parseXml, schemaLocation }) : [];
  const several = ruleFormat && !acceptOnly ? repeatingComparisons(ruleXml, ruleFormat, views, { parseXml, schemaLocation }) : [];
  return {
    contextSchemas,
    schemaFacts,
    promptPlacements,
    unreachable,
    untested,
    tableModel,
    limits,
    several,
    setup: { standard, schemaLocation, placements, keepBrexReference: ruleLooksAtBrexReference(ruleXml), tableModel: Boolean(tableModel), several },
  };
}

// The elements a placement already gives a way to (the routes down from the
// insertion point, the routes in the identification and status section,
// the nestings): elementPlaces says nothing more about them.
function placementRouteNames(placement) {
  return [
    ...(placement.routes?.cards || []).map((c) => c.name),
    ...(placement.routes?.steps || []).flatMap((st) => st.children),
    ...(placement.metadata?.routes || []).map((r) => r.target),
    ...(placement.nestings || []).map((n) => n.descendant),
  ];
}

// Mejoras C, Part 2: where each element the rule names goes, for one
// placement (also used by the prompt snapshot, so it is the app's code).
// An element the rule's own path already writes under its parent
// (tgroup/tbody, dmStatus/applicRef) needs no sentence either.
export function placementPlaces(structure, placement, ruleXml) {
  const elements = structure?.elements || {};
  const underParent = [];
  // A step written under the step before it -- "/" with that parent allowed
  // by the schema, or "//" (the path gives the ancestor and the nesting is
  // said elsewhere) -- also inside the steps' predicates ([entry[…]]).
  const visit = (alternative, start) => {
    const { steps } = pathSteps(alternative);
    steps.forEach((step, i) => {
      const prev = i === 0 && step.sep === null ? (start ? { kind: 'element', name: start } : null) : steps[i - 1];
      if (step.kind !== 'element') return;
      if (prev?.kind === 'element' && (step.sep === '//' || step.desc || (elements[prev.name]?.children || []).includes(step.name))) underParent.push(step.name);
      for (const pred of step.predicates) {
        for (const operand of pathOperands(pred)) if (!operand.startsWith('/')) pathAlternatives(operand).forEach((alt) => visit(alt, step.name));
      }
    });
  };
  for (const expression of [...extractRuleXPaths(ruleXml || ''), ...ruleMatchExpressions(ruleXml || '')]) {
    for (const alternative of pathOperands(expression).flatMap(pathAlternatives)) visit(alternative, null);
  }
  // A Schematron test reads from its rule's context node (row → entry[…]).
  const decode = (t) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  for (const m of String(ruleXml || '').matchAll(/<(?:[\w.-]+:)?rule\b[^>]*?\scontext\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?rule\s*>/g)) {
    const lasts = pathOperands(decode(m[1])).flatMap(pathAlternatives).map((alt) => {
      const steps = pathSteps(alt).steps;
      const last = steps[steps.length - 1];
      return last?.kind === 'element' ? last.name : null;
    });
    for (const t of m[2].matchAll(/\stest\s*=\s*"([^"]*)"/g)) {
      for (const operand of pathOperands(decode(t[1]))) {
        if (operand.startsWith('/')) continue;
        for (const start of lasts.filter(Boolean)) pathAlternatives(operand).forEach((alt) => visit(alt, start));
      }
    }
  }
  return elementPlaces(structure, placement, extractRuleNames(ruleXml).elements, [...placementRouteNames(placement), ...underParent]);
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
  if (example.expected !== 'reject' || !run.result || run.result.status === 'not_executable' || run.result.status === 'error') return null;
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
      r.result.status !== 'error' &&
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

function correctionPlaces(entry, names) {
  if (!entry?.structure || !entry.placement) return [];
  return elementPlaces(entry.structure, entry.placement, names);
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
      // Mejoras E, Part 1.3: an example the schema already rules out is
      // never sent back -- correcting it would remove what breaks the rule.
      if (r.schemaCovered) return { index, label: examples[index].label, problems: [] };
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
            // every element of the rule, also those its own path places (the
            // prompt leaves those out): the example still put one elsewhere
            places: correctionPlaces(setup?.placements?.[materialized[index].schema], ruleNames.elements),
          });
      if (problems.length > 0 && !missing && keep && examples[index].expected === 'reject') problems.push(keep);
      return { index, label: examples[index].label, problems };
    })
    .filter((f) => f.problems.length > 0);
}

// Mejoras E, Part 1.5: a corrected example keeps a true label. The element
// names its label mentions (<x>, or the bare name) that the correction
// removed from the example, or moved to another parent, are noted:
// { removed: [names], moved: [names] } -- the panel says "corrected:
// <emphasis> was removed". Real case: "disallowed child element (emphasis)"
// kept its label after the correction took the <emphasis> out.
function elementParents(xml) {
  const parents = new Map();
  const stack = [];
  const text = String(xml || '').replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>/g, '');
  for (const m of text.matchAll(/<(\/?)([A-Za-z_][\w.:-]*)[^>]*?(\/?)>/g)) {
    const [, close, name, self] = m;
    if (close) {
      stack.pop();
      continue;
    }
    if (!parents.has(name)) parents.set(name, new Set());
    parents.get(name).add(stack[stack.length - 1] || '');
    if (!self) stack.push(name);
  }
  return parents;
}

export function labelNote(label, correctedXml, originalXml) {
  const before = elementParents(originalXml);
  const after = elementParents(correctedXml);
  const named = [...new Set(String(label || '').match(/[A-Za-z_][\w.-]*/g) || [])].filter((n) => before.has(n));
  const removed = named.filter((n) => !after.has(n));
  const moved = named.filter((n) => after.has(n) && [...before.get(n)].some((p) => !after.get(n).has(p)));
  return removed.length || moved.length ? { removed, moved } : null;
}

function withLabelNote(corrected, original) {
  const note = labelNote(corrected.label, corrected.xml, original.xml);
  return note ? { ...corrected, labelNote: note } : corrected;
}

// Mejoras H, Part 1.1: the correction round may never remove what the
// schema limits. Real cases: "<step> allows at most 1 <cmd>; the example has
// 2" on an example meant to be rejected (the rule: one <cmd> per <step>) --
// the correction merged the two <cmd> into one, the rule accepted it and the
// verdict blamed the rule; and two <evaluate> in <applic> merged into one.
// For every tooMany problem { element: C, parent: P, max } of an example the
// <C> written by the LLM (its content and, if any, its identification
// section -- never the application's skeleton) are counted before and after
// the correction: fewer after → that example's correction is discarded and
// the example stays as in the first answer (invalid, never run), carrying
// `schemaLimit` { element, parent, max } for the panel and the verdict.
// Moving or nesting the surplus (as many <C> or more) is a real fix.
function tooManyLimits(run) {
  const seen = new Set();
  return (run?.validation?.structure || [])
    .filter((p) => p.kind === 'tooMany')
    .filter((p) => {
      const key = `${p.parent}/${p.element}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((p) => ({ element: p.element, parent: p.parent, max: p.max }));
}

const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function countWrittenElements(example, name) {
  const text = `${example?.content || ''}\n${example?.metadata || ''}`.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>/g, '');
  return (text.match(new RegExp(`<${escapeRegExp(name)}(?=[\\s/>])`, 'g')) || []).length;
}

// → the limit whose element the correction removed, or null.
export function lostSchemaLimit(original, corrected, limits) {
  return limits.find((l) => countWrittenElements(original, l.element) > (corrected ? countWrittenElements(corrected, l.element) : 0)) || null;
}

// The corrected examples with every correction that removed a limited
// element replaced by the first answer's example. `next` is aligned with
// `examples` when `aligned`; otherwise the corrected example is found by
// its label (one not found counts as removing everything).
export function keepSchemaLimitedExamples(examples, runs, failures, next, aligned) {
  const out = [...next];
  const used = new Set();
  for (const f of failures) {
    const limits = tooManyLimits(runs[f.index]);
    if (limits.length === 0) continue;
    const original = examples[f.index];
    let pos = aligned ? f.index : out.findIndex((ex, j) => !used.has(j) && ex.label === original.label);
    if (pos >= 0) used.add(pos);
    const lost = lostSchemaLimit(original, pos >= 0 ? out[pos] : null, limits);
    if (!lost) continue;
    const kept = { ...original, schemaLimit: lost };
    if (pos >= 0) out[pos] = kept;
    else {
      out.push(kept);
      used.add(out.length - 1);
    }
  }
  return out;
}

// Materialize, validate and run every example.
function runRuleTestExamples(examples, { ruleXml, format, setup, vocabulary, parseXml = parseXmlDocument }) {
  const materialized = examples.map((ex) => materializeExample(ex, setup, parseXml));
  const runs = materialized.map((ex) => runExample(ruleXml, format, ex, { vocabulary, parseXml, graph: setup.graph || null }));
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
//   | { status: 'path_review', reason } -- Mejoras C: every path of the rule
//     cannot exist in the standard (no LLM call); reason
//     { code: 'test_impossible_path', params: { format, problems } }
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
  // Mejoras C, Part 1 (optional): GET /api/schema-cards/graph.
  fetchSchemaGraph = null,
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
    const graph = await loadGraph(fetchSchemaGraph, standard);
    if (!isCurrent()) return null;
    const pathReview = impossiblePathReview({ ruleXml, format, schemaLocation, graph, parseXml });
    if (pathReview) return { status: 'path_review', reason: pathReview, systemPrompt: null, responses };
    // Mejoras F, Part 1.2: a rule on the document's root -- no LLM examples.
    const rootTest = rootRuleTest({ ruleXml, format, standard, schemaLocation, graph, vocabulary, parseXml });
    if (rootTest) {
      const checkable = !rootTest.coverage && askProposalCheck && ruleDescription != null;
      const proposalCheck = checkable ? await checkRuleImplementsProposal({ brdp, standard, format, ruleXml, ruleDescription, ask: askProposalCheck }) : null;
      if (!isCurrent()) return null;
      return {
        ...rootTest,
        proposalCheck,
        correction: null,
        predicateSkipped: 0,
        setup: { standard, schemaLocation, placements: {}, keepBrexReference: false },
        untested: [],
        systemPrompt: null,
        responses,
      };
    }
    // Mejoras G, Part 2.3: "every document must contain <x>", decided by the
    // schema for every type -- no LLM examples either.
    const presenceTest = documentPresenceTest({ ruleXml, format, standard, schemaLocation, graph, vocabulary, parseXml });
    if (presenceTest) {
      const checkable = !presenceTest.coverage && askProposalCheck && ruleDescription != null;
      const proposalCheck = checkable ? await checkRuleImplementsProposal({ brdp, standard, format, ruleXml, ruleDescription, ask: askProposalCheck }) : null;
      if (!isCurrent()) return null;
      return {
        ...presenceTest,
        proposalCheck,
        correction: null,
        predicateSkipped: 0,
        setup: { standard, schemaLocation, placements: {}, keepBrexReference: false },
        untested: [],
        systemPrompt: null,
        responses,
      };
    }
    // Mejoras E, Part 1.2: the rule forbids what no valid document of the
    // schema can contain -- only examples meant to be accepted are asked
    // for (Part 1.4), to show the rule does not reject what is valid.
    const coverage = graph ? schemaCoverage(ruleXml, format, graph, { schemaLocation, parseXml }) : null;
    const prepared = await prepareRuleTestSetup({ ruleXml, standard, schemaLocation, fetchSchemaCards, fetchStructure, fetchSchemaAttribute, acceptOnly: Boolean(coverage), format, parseXml });
    if (!isCurrent()) return null;
    if (prepared.unreachable) return { status: 'not_executable', reason: prepared.unreachable, setup: prepared.setup, untested: prepared.untested };
    // Mejoras C, Part 2: the rule, so materializeExample can move an element
    // of it to its only parent without changing what the rule decides.
    prepared.setup.rule = { ruleXml, format, names: extractRuleNames(ruleXml).elements };
    // Remates de Mejoras G, Part 1.1: the standard's graph, so an example
    // the schema rules out is recognized only by a relation the rule names
    // (runExample's schemaCovered; "Run again" reads it from here too).
    prepared.setup.graph = graph || null;
    // The schemas whose examples the application builds whole (rootOnly):
    // their examples come with no "content".
    const parseOptions = { contentOptionalSchemas: prepared.promptPlacements.filter((p) => p.rootOnly).map((p) => p.schema) };
    // With the schema already covering the rule there is no "correct" to
    // turn into "review": the Proposal check is not asked.
    const checkPromise =
      askProposalCheck && ruleDescription != null && !coverage
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
      acceptOnly: coverage ? { reasons: coverage.items.map(coverageItemEnglish) } : null,
      limits: prepared.limits || [],
      several: prepared.several || [],
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
    if (coverage) {
      // Only examples meant to be accepted: one meant to be rejected cannot
      // be a valid document here, whatever the answer says.
      examples = examples.filter((ex) => ex.expected === 'accept');
      if (examples.length === 0) {
        return { status: 'error', error: 'The answer has no example meant to be accepted.', badResponse: true, systemPrompt, responses };
      }
    }
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
          const aligned = reparsed.examples.length === examples.length;
          const next = keepSchemaLimitedExamples(
            examples,
            runs,
            failures,
            aligned ? examples.map((ex, i) => (failing.has(i) ? reparsed.examples[i] : ex)) : reparsed.examples,
            aligned
          );
          // The answer to the correction keeps only what this test asks for
          // (accept examples only when the schema covers the rule).
          const kept = coverage ? next.filter((ex) => ex.expected === 'accept') : next;
          const rerun = run(kept);
          const still = new Set(exampleFailures(kept, rerun.materialized, rerun.runs, { ruleXml, standard, format, setup: prepared.setup, parseXml }).map((f) => f.index));
          correction.fixed = failures.filter((f) => rerun.runs[f.index] && !still.has(f.index)).length;
          // Mejoras E, Part 1.5: a corrected example whose label names an
          // element the correction removed or moved says so.
          rerun.materialized = rerun.materialized.map((ex, i) =>
            failures.some((f) => f.index === i) && materialized[i] ? withLabelNote(ex, materialized[i]) : ex
          );
          examples = kept;
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
      coverage,
      proposalCheck,
      examples: materialized,
      runs,
      correction,
      predicateSkipped,
      several: prepared.several || [],
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
