// Test rule (T2 of 4, T2b): everything between the LLM's examples and the
// panel, deterministic and pure (no React, no API) so scripts/ can test it in
// Node.
// - materializeExample (T2b): the LLM writes only the content of an
//   insertion point; the application builds the complete fragment on the
//   schema's skeleton (utils/ruleTestSkeleton.js).
// - validateExample: well-formed XML + names checked against the standard's
//   vocabulary (same check as the rest of the app) + (T2b) the structure of
//   the example's schema: every child allowed inside its parent, every
//   attribute declared on its element. An example that fails is shown with
//   its warnings and never run -- never dropped (HR7).
// - exampleProblems (T2b): the same problems in English, for the one
//   automatic correction round.
// - runExample: the T1 engine on one example, compared with what the
//   example expects.
// - ruleTestVerdict: the global verdict (correct / incorrect / inconclusive
//   / not executable / nothing runnable).
// - xmlDisplayLines: the example re-indented, split into segments so the
//   panel can highlight the nodes the rule selected and dim the skeleton.
import { acceptanceDetails, documentPresenceTarget, nodePath, parseXmlDocument, runRuleOnFragment } from './ruleTestEngine.js';
import {
  addMissingCalsColspecs,
  checkAgainstVocabulary,
  checkCalsColspecs,
  checkCalsTableSpans,
  checkExampleStructure,
  extractDocumentNames,
  fixCalsRowSpans,
  formatStructureProblem,
  removeSpannedCalsEntries,
} from '../validation/schemaValidation.js';
import { SKELETON_TEXT_SUFFIX, assembleExample, nestingPath, normalizeBrexReferenceCode, ruleTargets } from './ruleTestSkeleton.js';
import { placeSentence, relocateMisplacedElements, relocateToOnlyParent } from './schemaPlacement.js';
import { coveredRelationAlternatives } from '../validation/schemaCoverage.js';
import {
  DOSSIER_MAIN_PATH,
  dossierForEngine,
  dossierProblemText,
  dossierProblems,
  dossierReferenceWarnings,
  materializeDossierFiles,
} from './ruleTestDossier.js';

// Unprefixed element and attribute names of a parsed fragment. Prefixed
// names (xsi:…, xlink:…) and namespace declarations are not schema
// vocabulary and are left out.

// T2b: the LLM's example ({ label, expected, schema, content }) on its
// schema's skeleton → the same example with `xml` (the complete fragment
// that is run and shown), `skeletonNodePaths` and `structure`.
// `setup` = { standard, schemaLocation, placements: { [schema]: { structure,
// placement } } }. A schema the application did not offer gets no xml; its
// validation says so. With a single offered schema, a missing schema is that
// one.
//
// C3b: before anything else, the application removes the table cells that
// sit in a column a morerows above already covers (always an error, always
// the same fix -- see removeSpannedCalsEntries). The example then carries
// the fixed content and `spannedEntriesRemoved` (the rows, one per removed
// cell) for the panel's "Adjusted by the app" note. Every path goes through
// here: the LLM's first answer, the correction round, "Run again" on an
// edited example and the prompt eval.
// C3b follow-up: first of all, the colspecs its tables' colnames need and do
// not have are added (addMissingCalsColspecs), so the morerows fix and the
// checks read the columns by name; the example carries `colspecsAdded`.
// Barrido final 1/2: also a @cols lower than the columns used is raised
// (`colsRaised`), a morerows past the last row is lowered
// (`morerowsLowered`) and an empty row no span reaches is removed
// (`emptyRowsRemoved`) -- each has one fix that keeps every row reading the
// same (see fixCalsRowSpans). A row entirely covered by the morerows above
// has no such fix and goes to the correction round with the exact cells.
export function materializeExample(example, setup, parseXml = parseXmlDocument) {
  const offered = Object.keys(setup.placements || {});
  const schema = example.schema || (offered.length === 1 ? offered[0] : null);
  const withColspecs = addMissingCalsColspecs(example.content, parseXml);
  const rowSpans = fixCalsRowSpans(withColspecs.content, parseXml);
  const { content, removedRows } = removeSpannedCalsEntries(rowSpans.content, parseXml);
  const adjusted = {
    ...example,
    content,
    colspecsAdded: withColspecs.added,
    colsRaised: withColspecs.colsRaised,
    morerowsLowered: rowSpans.morerowsLowered,
    emptyRowsRemoved: rowSpans.emptyRowsRemoved,
    spannedEntriesRemoved: removedRows,
  };
  const entry = schema ? setup.placements[schema] : null;
  if (!entry) return { ...adjusted, schema, xml: null, skeletonNodePaths: [], structure: null, unmaterialized: true };
  // Ruta del esquema, Part 2: an element the LLM put where the schema does
  // not allow it is moved down the ONLY valid way from that parent, with the
  // missing containers and their required children (schemaPlacement.js) --
  // in the content (whose top level goes inside the insertion point) and in
  // the identification and status section (inside the root). With more than
  // one way nothing is moved and the example goes to the correction round.
  const relocated = [];
  if (entry.structure?.models) {
    const inContent = relocateMisplacedElements(adjusted.content, entry.structure, entry.placement.insertion || null);
    if (inContent.moved.length) {
      adjusted.content = inContent.text;
      relocated.push(...inContent.moved);
    }
    if (entry.placement.metadata?.insertion && example.metadata != null) {
      const inSection = relocateMisplacedElements(example.metadata, entry.structure, entry.placement.root);
      if (inSection.moved.length) {
        adjusted.metadata = inSection.text;
        relocated.push(...inSection.moved);
      }
    }
  }
  // Mejoras C, Part 2: an element the RULE names, put where the schema does
  // not allow it, with ONE possible parent in this schema that is already
  // in the same text (the whole document, the content or the section): it
  // is moved there, at its place by the XSD's order -- only when the move
  // does not change what the rule selects or decides on the example (then
  // the correction round gets the place instead).
  const rule = setup.rule;
  if (rule?.names?.length && entry.structure?.elements) {
    const decides = (content, metadata) => {
      const { xml } = assembleExample({ standard: setup.standard, schema, schemaLocation: setup.schemaLocation, placement: entry.placement, content, metadata });
      if (!xml) return null;
      const r = runRuleOnFragment(rule.ruleXml, rule.format, xml, schema, { parseXml, schemaLocation: setup.schemaLocation });
      return JSON.stringify([r.status, r.selectedNodePaths.length, (r.conditions || []).map((c) => c.holds), (r.violations || []).length]);
    };
    const inContent = relocateToOnlyParent(adjusted.content, entry.structure, entry.placement.insertion || null, rule.names, (before, after) => {
      const a = decides(before, adjusted.metadata);
      return a !== null && a === decides(after, adjusted.metadata);
    });
    if (inContent.moved.length) {
      adjusted.content = inContent.text;
      relocated.push(...inContent.moved);
    }
    if (entry.placement.metadata?.insertion && adjusted.metadata != null) {
      const inSection = relocateToOnlyParent(adjusted.metadata, entry.structure, entry.placement.root, rule.names, (before, after) => {
        const a = decides(adjusted.content, before);
        return a !== null && a === decides(adjusted.content, after);
      });
      if (inSection.moved.length) {
        adjusted.metadata = inSection.text;
        relocated.push(...inSection.moved);
      }
    }
  }
  if (relocated.length) adjusted.relocated = relocated;
  else delete adjusted.relocated;
  // Rule test on DM metadata: the rule looks at the identification and
  // status section, so the LLM had to write it; an example without it is
  // not run (its validation says so). Its brexDmRef follows the DM's own
  // code (ruleTestSkeleton.js, normalizeBrexReferenceCode) unless the rule
  // looks at the brexDmRef itself.
  const section = entry.placement.metadata;
  let metadata = adjusted.metadata;
  if (section?.insertion && !setup.keepBrexReference && metadata != null) {
    const normalized = normalizeBrexReferenceCode(metadata, section.element);
    metadata = normalized.text;
    adjusted.metadata = metadata;
    // A pm, DDN or DML: only the shared @modelIdentCode followed.
    adjusted.brexReferenceNormalized = normalized.changed && !normalized.shared;
    if (normalized.shared) adjusted.brexModelIdentFollowed = true;
  }
  const { xml, skeletonNodePaths, insertionPath } = assembleExample({
    standard: setup.standard,
    schema,
    schemaLocation: setup.schemaLocation,
    placement: entry.placement,
    content: adjusted.content,
    metadata,
  });
  const missingMetadata =
    section?.insertion && entry.placement.path.length > 0 && !String(example.metadata || '').trim() ? section.element : null;
  // Dosier, Part 2: the other files of the example's dossier, each with the
  // same fixes and the structure of its own type.
  const dossier = setup.dossier
    ? { mainPath: setup.dossier.mainPath || DOSSIER_MAIN_PATH, files: materializeDossierFiles(example.files || [], setup.dossier.structures, parseXml) }
    : null;
  return {
    ...adjusted,
    ...(dossier ? { mainPath: dossier.mainPath, files: dossier.files } : {}),
    schema,
    xml,
    skeletonNodePaths,
    insertionPath: entry.placement.contentInsertion === false ? null : insertionPath || null,
    structure: entry.structure,
    schemaLocation: setup.schemaLocation || null,
    insertion: entry.placement.insertion,
    metadataElement: section?.insertion && entry.placement.path.length > 0 ? section.element : null,
    contentInsertion: entry.placement.contentInsertion !== false,
    // The application built the whole document (placeExample's rootOnly):
    // nothing in it is the LLM's, so nothing can be edited.
    rootOnly: entry.placement.rootOnly === true,
    missingMetadata,
  };
}

// { wellFormed, error, names, structure, cards, unknownSchema, runnable }
// `structure` (T2b) is the example's schema structure, or null (then only
// the vocabulary is checked). `structure` in the result also carries the
// CALS table-span problems (C3, Part 1b), which need no schema.
export function validateExample(xml, vocabulary, parseXml = parseXmlDocument, structure = null, options = {}) {
  const empty = { available: false, notFound: [], wrongType: [] };
  if (options.unknownSchema) {
    return { wellFormed: true, error: null, names: empty, structure: [], cards: [], unknownSchema: options.unknownSchema, runnable: false };
  }
  if (options.missingMetadata) {
    return { wellFormed: true, error: null, names: empty, structure: [], cards: [], unknownSchema: null, missingMetadata: options.missingMetadata, runnable: false };
  }
  let doc;
  try {
    doc = parseXml(String(xml || ''));
    if (!doc?.documentElement) throw new Error('no root element');
  } catch (err) {
    return { wellFormed: false, error: err.message, names: empty, structure: [], cards: [], unknownSchema: null, runnable: false };
  }
  const names = checkAgainstVocabulary(extractDocumentNames(doc), vocabulary);
  const namesOk = !names.available || (names.notFound.length === 0 && names.wrongType.length === 0);
  // A name the vocabulary already reports is not repeated as "does not exist
  // in the <schema> schema".
  const reported = new Set(names.notFound.map((n) => n.replace(/^[<@]|>$/g, '')));
  const structureProblems = [
    ...(structure
      ? checkExampleStructure(doc, structure).filter((p) => !(p.kind === 'unknownElement' && reported.has(p.element)))
      : []),
    ...checkCalsColspecs(doc),
    ...checkCalsTableSpans(doc),
  ];
  return {
    wellFormed: true,
    error: null,
    names,
    structure: structureProblems,
    cards: structure ? elementCards(doc, names, structureProblems, structure) : [],
    unknownSchema: null,
    runnable: namesOk && structureProblems.length === 0,
  };
}

// ─── Element cards for the correction round (C3, Part 1a) ──────────────────
// A real run wrote <quantity quantityValue="25" unitOfMeasure="N·m"> and,
// asked to fix it, <quantity><quantityValue>… -- both invalid, because the
// correction request only said what was wrong, never what the element takes.
// For every problem about an element (a child not allowed inside it, an
// element there that does not exist in the schema, an attribute it does not
// have, an attribute that is really an element or the reverse), the request
// now carries a compact card of that element in the example's schema: its
// allowed children and its attributes, from the same structure the check
// used. Lists over CARD_MAX_NAMES are cut with "+N more".
const CARD_MAX_NAMES = 20;

function elementsNamed(doc, predicate) {
  const out = [];
  const walk = (el) => {
    if (predicate(el)) out.push(el);
    for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) walk(n);
  };
  walk(doc.documentElement);
  return out;
}

function elementCards(doc, names, problems, structure) {
  const wanted = [];
  const want = (name) => {
    if (name && structure.elements[name] && !wanted.includes(name)) wanted.push(name);
  };
  for (const p of problems) {
    if (p.kind === 'notAllowed') want(p.parent);
    else if (p.kind === 'tooMany') {
      want(p.parent);
      want(p.element);
    } else if (p.kind === 'unknownAttribute') want(p.element);
    else if (p.kind === 'unknownElement') {
      for (const el of elementsNamed(doc, (e) => e.nodeName === p.element)) want(el.parentNode?.nodeName);
    }
  }
  for (const w of names.wrongType || []) {
    if (w.usedAs === 'element') {
      // <x> written as an element, but x is an attribute: the card of the
      // element it was written inside says where @x may go.
      for (const el of elementsNamed(doc, (e) => e.nodeName === w.name)) want(el.parentNode?.nodeName);
    } else {
      // @x written as an attribute, but x is an element: the element that
      // carries it, and the element x itself.
      for (const el of elementsNamed(doc, (e) => e.hasAttribute?.(w.name))) want(el.nodeName);
      want(w.name);
    }
  }
  return wanted.map((element) => ({
    element,
    children: [...structure.elements[element].children],
    attributes: [...structure.elements[element].attributes],
    max: { ...(structure.models?.[element]?.max || {}) },
  }));
}

// "a, b, c" with at most CARD_MAX_NAMES names, then "+N more".
function cardNameList(names, prefix = '') {
  if (!names.length) return 'none';
  const shown = names.slice(0, CARD_MAX_NAMES).map((n) => `${prefix}${n}`).join(', ');
  const omitted = names.length - CARD_MAX_NAMES;
  return omitted > 0 ? `${shown}, +${omitted} more` : shown;
}

function formatElementCard(card, schema) {
  const where = schema ? ` in the ${schema} schema` : '';
  // Mejoras G, Part 1.2: the children it allows only a limited number of
  // times ("at most 1: <displaytext>, <evaluate>").
  const limited = new Map();
  for (const child of card.children) {
    const max = card.max?.[child];
    if (Number.isInteger(max)) limited.set(max, [...(limited.get(max) || []), child]);
  }
  const limits = [...limited.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([max, names]) => `; at most ${max} of each: ${cardNameList(names.map((n) => `<${n}>`))}`)
    .join('');
  return `card of <${card.element}>${where}: allowed children: ${cardNameList(card.children)}${limits}; attributes: ${cardNameList(card.attributes, '@')}`;
}

// C3b: an example often fails on the markup of an element the rule does
// not even look at (a real run: <quantity> and <dmCode> written wrong in
// "Procedure without emphasis", for a rule about <emphasis>). The problem
// about such an element then also offers the simplest fix.
const PLAIN_TEXT_HINT = 'If this element is not needed to test the rule, remove it and use plain text.';

// The validation problems of one example, in English (the correction
// request to the LLM), followed by the cards of the elements involved.
// `ruleNames` ({ elements, attributes } of the rule, extractRuleNames), when
// given, adds PLAIN_TEXT_HINT to each problem about the markup of an element
// the rule does not name.
// Pending of the test rule, Part 3: "Run again" on an example edited by
// hand. The example keeps what the generation wrote (`generated`) and is
// marked `editedByUser` while its text differs from it -- the panel then
// says the verdict includes hand-edited examples and is not recorded (T3:
// only the examples as the LLM wrote them are). Running it again unchanged,
// or back to the generated text, leaves no mark.
// Dosier, Part 2: `files` ([{ path, content }]) replaces the dossier's other
// files (one edited file, the rest as they were).
const filesText = (files) => JSON.stringify((files || []).map((f) => [f.path, f.content]));
export function editExample(current, content, metadata, setup, parseXml = parseXmlDocument, files = undefined) {
  const generated = current.generated || {
    content: current.content,
    metadata: current.metadata ?? null,
    ...(Array.isArray(current.files) ? { files: current.files.map((f) => ({ path: f.path, content: f.content })) } : {}),
  };
  const edited = { ...current, content, generated };
  if (files !== undefined) edited.files = files.map((f) => ({ path: f.path, content: f.content }));
  else if (Array.isArray(current.files)) edited.files = current.files.map((f) => ({ path: f.path, content: f.content }));
  const filesChanged = files !== undefined && filesText(files) !== filesText(current.files);
  // Mejoras H: a hand edit is the user's example, no longer the one the
  // correction could not write.
  if (content !== current.content || filesChanged || (metadata !== undefined && metadata !== (current.metadata ?? null))) delete edited.schemaLimit;
  if (metadata !== undefined) edited.metadata = metadata;
  edited.editedByUser =
    edited.content !== generated.content ||
    (edited.metadata ?? null) !== generated.metadata ||
    (generated.files !== undefined && filesText(edited.files) !== filesText(generated.files));
  return materializeExample(edited, setup, parseXml);
}

// "Record the corrected test": the record to send when the user's hand
// edits (Run again) turn the verdict into "Correct" while the test recorded
// for this generation was not passed (failed, inconclusive, nothing
// runnable -- or nothing recorded). Once per generation: after one such
// record, later edits record nothing (`alreadyRecorded`). A recorded
// "passed" stays as it is -- editing is then a what-if. Never for a verdict
// that is not "Correct". → { result: 'passed', reason: null,
// editedExamples: [{ label, xml }] } (xml: the complete example as it was
// run) | null.
export function editedExamplesRecord({ recorded, alreadyRecorded, examples, verdict }) {
  if (alreadyRecorded || !verdict || verdict.kind !== 'correct') return null;
  if (recorded && recorded.result === 'passed') return null;
  const edited = (examples || []).filter((ex) => ex.editedByUser && ex.xml);
  if (edited.length === 0) return null;
  return {
    result: 'passed',
    reason: null,
    editedExamples: edited.map((ex) => ({
      label: ex.label || '',
      xml: ex.xml,
      ...(Array.isArray(ex.files) ? { files: ex.files.map((f) => ({ path: f.path, xml: f.xml ?? f.content })) } : {}),
    })),
  };
}

// Pending of the test rule (Part 1): `nestings` (the placement's
// nestingPaths) and `expected` -- in an example meant to be rejected, a
// "<B> is not allowed inside <A>" problem on the way of a rule's A//B also
// gives the valid nesting and says to keep it: corrected without it, an LLM
// moved the <randomList> out of the other one and the reject example was no
// longer nested.
function nestingHint(problem, nestings) {
  if (problem.kind !== 'notAllowed') return null;
  const n = nestings.find((x) => x.descendant === problem.element && x.path.slice(0, -1).includes(problem.parent));
  if (!n) return null;
  return `To put <${n.descendant}> inside <${n.ancestor}>, the valid nesting is: ${n.path.join('/')}. Keep the nesting — do not move <${n.descendant}> outside <${n.ancestor}>.`;
}

// Barrido final 1/2: the table problems the application cannot fix itself
// (a row entirely under the morerows above, colnames whose column cannot be
// worked out...) point at the model table the prompt gave (tableModel).
const TABLE_PROBLEM_KINDS = new Set(['spannedEntry', 'morerowsPastEnd', 'emptyRow', 'rowFullyCovered', 'unorderableColname', 'tooManyColumns']);
export const TABLE_MODEL_HINT = 'Write the table like the MODEL TABLE in the instructions: every colname has its <colspec>, and the row under a morerows has no <entry> in that column but keeps at least one <entry> of its own.';

// Barrido final 3, Part 3: where each element sits in the minimal
// identification and status section (placement.metadata.tree) → Map name →
// [paths]. A real run (applicability-dm-pm-ddn-dml, 0758381) put <language>
// and <issueInfo> directly inside <dmStatus>; relocateMisplacedElements does
// not move them, because the schema has several ways down from <dmStatus>
// to either (sourceDmIdent, brexDmRef/dmRef/dmRefIdent, applicRef/…) and
// even from the section itself -- no unique fix. The correction request
// then names the place the minimal section gives it.
export function minimalSectionPlaces(tree) {
  const places = new Map();
  const walk = (node, path) => {
    if (!node?.name) return;
    const here = [...path, node.name];
    if (!places.has(node.name)) places.set(node.name, []);
    places.get(node.name).push(here);
    for (const child of node.children || []) walk(child, here);
  };
  walk(tree, []);
  return places;
}

function sectionPlaceHint(problem, places) {
  if (!places || problem.kind !== 'notAllowed') return null;
  const at = places.get(problem.element);
  if (!at || at.length !== 1 || !places.has(problem.parent)) return null;
  const path = at[0];
  return `In this section <${problem.element}> goes inside <${path[path.length - 2]}> (${path.join('/')}), as in the minimal section; do not repeat it elsewhere`;
}

export function exampleProblems(validation, { standard, schema, ruleNames = null, nestings = [], expected = null, tableModel = false, sectionTree = null, places: rulePlaces = [] } = {}) {
  const places = sectionTree ? minimalSectionPlaces(sectionTree) : null;
  const ruleElements = new Set(ruleNames?.elements || []);
  const ruleAttributes = new Set(ruleNames?.attributes || []);
  const offer = (line, element, alsoAttribute = false) =>
    ruleNames && element && !ruleElements.has(element) && !(alsoAttribute && ruleAttributes.has(element))
      ? `${line}. ${PLAIN_TEXT_HINT}`
      : line;
  const out = [];
  if (validation.unknownSchema) out.push(`schema "${validation.unknownSchema}" was not offered; use one of the listed schemas`);
  if (validation.missingMetadata) out.push(`"metadata" is missing: write the complete <${validation.missingMetadata}> of this example`);
  if (!validation.wellFormed) out.push(`not well-formed XML: ${validation.error}`);
  for (const name of validation.names?.notFound || []) {
    const element = /^<(.+)>$/.exec(name)?.[1];
    out.push(offer(`${name} does not exist in ${standard}`, element));
  }
  for (const w of validation.names?.wrongType || []) {
    out.push(
      w.usedAs === 'element'
        ? offer(`<${w.name}> is not an element (it is the attribute @${w.name})`, w.name, true)
        : `@${w.name} is not an attribute (it is the element <${w.name}>)`
    );
  }
  for (const p of validation.structure || []) {
    const hint = expected === 'reject' ? nestingHint(p, nestings) : null;
    if (hint) {
      out.push(`${formatStructureProblem(p, schema)}. ${hint}`);
      continue;
    }
    const place = sectionPlaceHint(p, places);
    if (place) {
      out.push(`${formatStructureProblem(p, schema)}. ${place}.`);
      continue;
    }
    // Mejoras C, Part 2: an element the rule names, put where the schema
    // does not allow it -- the same "goes inside" sentence as the prompt.
    const rulePlace = p.kind === 'notAllowed' ? rulePlaces.find((x) => x.element === p.element) : null;
    if (rulePlace) {
      out.push(`${formatStructureProblem(p, schema)}. ${placeSentence(rulePlace)}`);
      continue;
    }
    const element = ['unknownElement', 'notAllowed', 'unknownAttribute'].includes(p.kind) ? p.element : null;
    out.push(offer(formatStructureProblem(p, schema), element));
  }
  for (const card of validation.cards || []) out.push(formatElementCard(card, schema));
  if (tableModel && (validation.structure || []).some((p) => TABLE_PROBLEM_KINDS.has(p.kind))) out.push(TABLE_MODEL_HINT);
  // Dosier, Part 2: the dossier's own problems, and each file's, naming the
  // file.
  for (const p of validation.dossierProblems || []) out.push(dossierProblemText(p));
  for (const f of validation.files || []) {
    if (f.validation.runnable) continue;
    for (const line of exampleProblems(f.validation, { standard, schema: f.schema, ruleNames, tableModel })) out.push(`file "${f.path}": ${line}`);
  }
  return out;
}

// One example → { validation, result (engine output) | null, matches }.
// matches: true/false when the rule ran and gave a verdict, null otherwise.
// A materialized example (T2b) is validated against its schema's structure.
// schemaLocation: the project's setting (ruleSchemaContext.js), so a context
// block written with a custom pattern is recognized; the example's own one
// (materializeExample) wins.
export function runExample(ruleXml, format, example, { vocabulary = null, parseXml = parseXmlDocument, schemaLocation = null, graph = null } = {}) {
  const unknownSchema = example.unmaterialized ? example.schema || '(none)' : null;
  const validation = validateExample(example.xml, vocabulary, parseXml, example.structure || null, {
    unknownSchema,
    missingMetadata: example.missingMetadata || null,
  });
  // Dosier, Part 2: every file of the example's dossier is validated with
  // the structure of its own type; a problem in any of them (or in the
  // dossier itself) keeps the example from running. A reference to a file
  // not in the dossier is only a warning.
  const dossier = dossierForEngine(example);
  if (dossier) {
    validation.files = example.files.map((f) => ({
      path: f.path,
      schema: f.schema || null,
      validation: validateExample(f.xml ?? f.content, vocabulary, parseXml, f.structure || null),
    }));
    validation.dossierProblems = dossierProblems(example.files, dossier.mainPath);
    validation.referenceWarnings = dossierReferenceWarnings(example.xml, example.files, parseXml, dossier.mainPath);
    validation.runnable = validation.runnable && validation.dossierProblems.length === 0 && validation.files.every((f) => f.validation.runnable);
  }
  if (!validation.runnable) {
    // Mejoras E, Part 1.3: an example meant to be rejected whose only
    // problem is an element the schema does not allow where it is -- and
    // that element is exactly what the rule rejects -- shows the schema
    // already forbids it. Never corrected (the correction would remove
    // what makes it break the rule) and never counted. Remates de Mejoras
    // G, Part 1.1: only with the standard's graph and an alternative of
    // the rule that the schema covers by that very relation.
    const schemaCovered =
      example.expected === 'reject'
        ? schemaCoveredExample(ruleXml, format, example, validation, { parseXml, schemaLocation, graph })
        : null;
    return schemaCovered ? { validation, result: null, matches: null, schemaCovered } : { validation, result: null, matches: null };
  }
  const result = runRuleOnFragment(ruleXml, format, example.xml, example.schema || null, {
    parseXml,
    schemaLocation: example.schemaLocation || schemaLocation,
    ...(dossier ? { dossier } : {}),
  });
  const expectedStatus = example.expected === 'reject' ? 'rejected' : 'accepted';
  // Mejoras E, Part 2.3: an engine error on a valid example is the rule
  // failing on it (never "as expected").
  const matches = result.status === 'not_executable' ? null : result.status === 'error' ? false : result.status === expectedStatus;
  // Mejoras B, Parts 1 and 3: for an example meant to be rejected that the
  // rule accepted, why -- per rule part, with the path without predicates.
  // predicateMiss (case b): the rule selected nothing, but nodes of the
  // kind its path names are there and none meets its predicates -- the
  // example shows the decision and the rule does not cover it: never sent
  // to the correction round, and the verdict is "incorrect", not
  // "inconclusive".
  const acceptance =
    example.expected === 'reject' && result.status === 'accepted'
      ? acceptanceDetails(ruleXml, format, example.xml, example.schema || null, {
          parseXml,
          schemaLocation: example.schemaLocation || schemaLocation,
          ...(dossier ? { dossier } : {}),
        })
      : null;
  // Remates B, Part 1: a rejecting condition the example names (some of
  // the elements or attributes it looks at are there) but does not meet is
  // case b too -- counted and treated the same.
  const conditionMiss = Boolean(acceptance?.some((d) => d.case === 'condition' && d.presentNames?.length > 0));
  const predicateMiss = Boolean(
    acceptance &&
      (conditionMiss ||
        (result.selectedNodePaths.length === 0 && !(result.conditions?.length > 0) && acceptance.some((d) => d.case === 'predicate')))
  );
  const rejection = example.expected === 'accept' && result.status === 'rejected' ? rejectionDetails(example, result) : null;
  // Mejoras G, Part 2.4 d: "every document must contain <x>" -- what the
  // document lacks, never "it rejects /dmodule".
  if (rejection) {
    const missing = documentPresenceTarget(ruleXml, format, { parseXml, schemaLocation: example.schemaLocation || schemaLocation });
    if (missing) rejection.missing = missing;
  }
  return { validation, result, matches, rejectedByBrexReference: rejectedByBrexReference(result), acceptance, predicateMiss, rejection };
}

// ─── Mejoras F, Part 1.4: why the rule rejected an example meant to be
// accepted ──────────────────────────────────────────────────────────────────
// BRDP-EXT-02719 (//*[text()[contains(., '  ')]]) rejected every example:
// the nodes it selected were the indentation of the document the
// application builds, not what was written for the test. The nodes the rule
// rejected (a text node counts as its element), at most REJECTION_SHOWN
// shown, and whether ALL of them are in the part the application built
// (its skeleton and minimal section -- the insertion point holds what was
// written, so it never counts; a minimal document built whole for a rule on
// the root is all the application's).
export const REJECTION_SHOWN = 5;
const TEXT_STEP_RE = /\/(?:text|comment|processing-instruction)\(\)\[\d+\]$/;

export function rejectionDetails(example, result) {
  const raw = (result.violations || []).flatMap((v) => v.nodePaths || []);
  const paths = [...new Set((raw.length ? raw : result.selectedNodePaths || []).map((p) => p.replace(TEXT_STEP_RE, '')).filter(Boolean))];
  if (paths.length === 0) return null;
  const skeleton = new Set((example.skeletonNodePaths || []).filter((p) => !p.endsWith('/text()')));
  if (example.insertionPath) skeleton.delete(example.insertionPath);
  const appBuilt = (p) => example.minimalDocument === true || skeleton.has(p.replace(/\/@[^/]+$/, ''));
  return {
    nodes: paths.slice(0, REJECTION_SHOWN),
    more: Math.max(0, paths.length - REJECTION_SHOWN),
    total: paths.length,
    allAppBuilt: paths.every(appBuilt),
  };
}

// Mejoras E, Part 1.3: the nodes of the example that the schema does not
// allow where they are (their parent does not list them as children).
function notAllowedNodes(doc, structure) {
  const elements = structure?.elements || {};
  const out = [];
  const walk = (el) => {
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType !== 1) continue;
      if (elements[n.nodeName] && elements[el.nodeName] && !elements[el.nodeName].children.includes(n.nodeName)) {
        out.push({ path: nodePath(n), element: n.nodeName, parent: el.nodeName, node: n });
      }
      walk(n);
    }
  };
  walk(doc.documentElement);
  return out;
}

// Remates de Mejoras G, Part 1.1: does a node the schema does not allow
// where it is break exactly the relation a covered alternative names?
//   onlyInside          the alternative's element, with no ancestor <other>
//   onlyDirectlyInside  the alternative's element, its parent not <other>
//   childrenListed      a child of the alternative's element that is not
//                       one of the children the schema allows there
function breaksCoveredRelation(o, item) {
  if (item.kind === 'onlyInside') {
    if (o.element !== item.element) return false;
    for (let p = o.node?.parentNode; p && p.nodeType === 1; p = p.parentNode) if (p.nodeName === item.other) return false;
    return true;
  }
  if (item.kind === 'onlyDirectlyInside') return o.element === item.element && o.parent !== item.other;
  if (item.kind === 'childrenListed') return o.parent === item.element && !(item.children || []).includes(o.element);
  return false;
}

// { items: [{ kind: 'structure', element, parent, schema }], nodePaths } when
// the example's only problems are elements not allowed where they are, the
// rule rejects exactly those nodes and (Remates de Mejoras G, Part 1.1)
// each of them breaks a relation an alternative of the rule names and the
// schema covers (by the standard's graph: "only inside", "only directly
// inside", "children listed"). BRDP-EXT-02642 //*[@mark and …] rejects a
// <para mark="1"> written inside another <para>: the schema does not allow
// that <para> there, but nothing in the rule is about where a <para> goes
// -- the example is just written wrong and goes to the correction round.
// Without a graph, never. null otherwise.
function schemaCoveredExample(ruleXml, format, example, validation, { parseXml, schemaLocation, graph }) {
  if (!graph) return null;
  if (!validation.wellFormed || validation.unknownSchema || validation.missingMetadata || !example.structure) return null;
  if (validation.names?.available && (validation.names.notFound.length > 0 || validation.names.wrongType.length > 0)) return null;
  if (!validation.structure.length || !validation.structure.every((p) => p.kind === 'notAllowed')) return null;
  let doc;
  try {
    doc = parseXml(String(example.xml || ''));
  } catch {
    return null;
  }
  const offending = notAllowedNodes(doc, example.structure);
  if (offending.length === 0) return null;
  const covered = coveredRelationAlternatives(ruleXml, format, graph, { parseXml, schemaLocation: example.schemaLocation || schemaLocation });
  if (covered.length === 0 || !offending.every((o) => covered.some((item) => breaksCoveredRelation(o, item)))) return null;
  // A descendant step of the rule (A//X) that the schema allows by another
  // way (<randomList> inside <randomList> through listItem/para): the
  // example is merely written wrong, the schema does not rule it out.
  const pairs = ruleTargets(ruleXml).alternatives.flatMap((a) => a.descendantPairs || []);
  if (offending.some((o) => pairs.some(([a, x]) => x === o.element && nestingPath(example.structure.elements || {}, a, o.element)))) return null;
  const exampleDossier = dossierForEngine(example);
  const result = runRuleOnFragment(ruleXml, format, example.xml, example.schema || null, {
    parseXml,
    schemaLocation: example.schemaLocation || schemaLocation,
    ...(exampleDossier ? { dossier: exampleDossier } : {}),
  });
  if (result.status !== 'rejected') return null;
  const rejected = new Set(result.violations.flatMap((v) => v.nodePaths || []));
  const notAllowed = new Set(offending.map((o) => o.path));
  if (rejected.size === 0 || [...rejected].some((p) => !notAllowed.has(p)) || [...notAllowed].some((p) => !rejected.has(p))) return null;
  const items = [];
  for (const o of offending) {
    if (!items.some((i) => i.element === o.element && i.parent === o.parent)) {
      items.push({ kind: 'structure', element: o.element, parent: o.parent, schema: example.schema || null });
    }
  }
  return { items, nodePaths: [...rejected] };
}

// Rule test on DM metadata: a rejection whose every offending node is in
// the brexDmRef (brexref in 3.0.1) comes from the project's own BREX -- its
// code is the DM's with infoCode 022 and itemLocationCode D
// (normalizeBrexReferenceCode), so the rule would reject the real BREX too.
// The panel says so; the verdict is not changed. A rejection that also
// points at the DM's own nodes is not attributed to the BREX.
const BREX_REFERENCE_PATH_RE = /\/(?:brexDmRef|brexref)\[\d+\]\//;
function rejectedByBrexReference(result) {
  if (result?.status !== 'rejected') return false;
  const paths = (result.violations || []).flatMap((v) => v.nodePaths || []);
  return paths.length > 0 && paths.every((p) => BREX_REFERENCE_PATH_RE.test(p));
}

// The global verdict from the examples and their runs:
//   { kind: 'not_executable', reason }  -- the rule cannot be tested (T2b:
//                                          analyzeRule, known before any
//                                          example) or the engine could not
//                                          judge an example
//   { kind: 'no_runnable', bySchema }   -- every example failed validation;
//                                          bySchema: [{ schema, count,
//                                          validation }] -- per schema, how
//                                          many examples and the first one's
//                                          validation, so the panel names the
//                                          schema and the reason (never only
//                                          "regenerate")
//   { kind: 'inconclusive', why: 'nothing_selected' | 'missing_expectation' }
//   { kind: 'incorrect', permissive, strict } -- which way the rule was wrong
//   { kind: 'correct' }
// `proposalCheck` (Barrido final 1/2: the result of the separate "does the
// rule implement the Proposal?" call, ruleTestRun.js's
// checkRuleImplementsProposal): a verdict that would be "correct" becomes
//   { kind: 'review', mismatch }   -- the check says it does not (real case:
//     "at most three substeps" tested against count(proceduralStep) = 1:
//     the examples pass because rule and examples agree with each other)
//   { kind: 'review', unchecked: true, error } -- the check failed or did
//     not answer valid JSON: "the Proposal could not be checked", never
//     "correct" by default.
// Barrido final 3: the check answers in three levels; "partly" (the rule
// implements the main checkable restriction, it lacks a nuance or something
// no XML rule can check) leaves "correct" -- the panel adds an informative
// note -- and only "no" (status 'mismatch') gives "review".
// Recorded as its own result, never "passed". null (no check made -- the
// examples kept from a passed test, or a caller without it) leaves
// "correct" as it is; a string is read as a mismatch (the old shape). A
// failed or inconclusive verdict is left as it is.
// Mejoras B, Part 2: `threshold` (ruleThreshold.js's thresholdMismatch):
// the Proposal's numbers match no border of the rule's threshold -- a
// verdict that would be "correct" becomes { kind: 'review', threshold }
// (before the Proposal check: it is a deterministic fact).
// Mejoras E: `coverage` (schemaCoverage.js: the rule forbids what no valid
// document of the schema can contain, found before any LLM call -- the
// examples are then only meant to be accepted) and the examples the schema
// already rules out (runExample's schemaCovered, Part 1.3) give
//   { kind: 'schema_covered', items, via: 'path' | 'examples' }
// when at least one example meant to be accepted ran and the rule accepted
// it; a rule that rejects it is "incorrect", as always. An example the
// schema rules out never counts otherwise (the verdict comes from the
// others). An engine error on an example (Part 2.3) is
//   { kind: 'incorrect', engineErrors: [{ index, label, code, message, plain }] }
// -- the rule fails on a valid example; never "not executable".
export function ruleTestVerdict(examples, runs, analysis = null, proposalCheck = null, threshold = null, coverage = null) {
  if (analysis?.status === 'not_executable') return { kind: 'not_executable', reason: analysis.reason };
  const ran = runs.filter((r) => r.result);
  const notExecutable = ran.find((r) => r.result.status === 'not_executable');
  if (notExecutable) return { kind: 'not_executable', reason: notExecutable.result.notExecutableReason };
  const engineErrors = runs
    .map((r, index) => (r.result?.status === 'error' ? { index, label: examples[index]?.label || '', ...r.result.runtimeErrors[0] } : null))
    .filter(Boolean);
  if (engineErrors.length > 0) {
    const others = runs.map((r, i) => (r.matches === false && r.result?.status !== 'error' ? examples[i].expected : null)).filter(Boolean);
    return { kind: 'incorrect', permissive: others.includes('reject'), strict: others.includes('accept'), engineErrors };
  }
  // Mejoras F, Part 1.2: a rule on the root that rejects the root of every
  // document type of the standard.
  if (coverage?.rootAllRejected) return { kind: 'review', rootAll: true, schemas: coverage.schemas || [] };
  const rejectIndices = examples.map((ex, i) => (ex.expected === 'reject' ? i : -1)).filter((i) => i >= 0);
  const coveredRuns = runs.filter((r) => r.schemaCovered);
  const coveredByExamples = coveredRuns.length > 0 && rejectIndices.length > 0 && rejectIndices.every((i) => runs[i]?.schemaCovered);
  if ((coverage && !coverage.rootAllRejected) || coveredByExamples) {
    const accepts = runs.filter((r, i) => r.result && examples[i].expected === 'accept');
    if (accepts.length > 0) {
      if (accepts.some((r) => r.matches === false)) return { kind: 'incorrect', permissive: false, strict: true };
      const items = [];
      for (const item of coverage ? coverage.items : coveredRuns.flatMap((r) => r.schemaCovered.items)) {
        if (!items.some((i) => i.kind === item.kind && i.element === item.element && i.other === item.other && i.parent === item.parent)) items.push(item);
      }
      return { kind: 'schema_covered', items, via: coverage ? 'path' : 'examples' };
    }
  }
  if (ran.length === 0) {
    const bySchema = [];
    runs.forEach((r, i) => {
      if (r.schemaCovered) return;
      const schema = examples[i]?.schema || null;
      const entry = bySchema.find((b) => b.schema === schema);
      if (entry) entry.count += 1;
      else bySchema.push({ schema, count: 1, validation: r.validation });
    });
    return { kind: 'no_runnable', bySchema };
  }
  // A condition (Plantillas, Part 4) is always evaluated on the document,
  // so a rule made of conditions has always looked at it.
  // Mejoras B, Part 3: an example whose nodes the rule's predicates leave
  // out (case b) shows the rule is permissive -- checked before "nothing
  // selected".
  // Mejoras H, Part 1.3: no example meant to be rejected ran because the
  // schema limits what it needs (the correction that removed the element
  // was discarded): the inconclusive verdict says so -- never "incorrect"
  // and never "covered by the schema".
  const limitedReject = !runs.some((r, i) => r.result && examples[i].expected === 'reject')
    ? examples.find((ex) => ex?.expected === 'reject' && ex.schemaLimit)?.schemaLimit || null
    : null;
  const inconclusive = (why) => (limitedReject ? { kind: 'inconclusive', why, schemaLimit: limitedReject } : { kind: 'inconclusive', why });
  if (
    !runs.some((r) => r.predicateMiss) &&
    ran.every((r) => r.result.selectedNodePaths.length === 0 && !(r.result.conditions?.length > 0))
  ) return inconclusive('nothing_selected');
  const ranExpectations = new Set(runs.map((r, i) => (r.result ? examples[i].expected : null)).filter(Boolean));
  const mismatches = runs.map((r, i) => (r.matches === false ? examples[i].expected : null)).filter(Boolean);
  if (mismatches.length > 0) {
    return {
      kind: 'incorrect',
      // accepted an example meant to violate it / rejected one meant to comply
      permissive: mismatches.includes('reject'),
      strict: mismatches.includes('accept'),
    };
  }
  if (!ranExpectations.has('accept') || !ranExpectations.has('reject')) return inconclusive('missing_expectation');
  if (threshold) return { kind: 'review', threshold };
  if (typeof proposalCheck === 'string' && proposalCheck.trim()) return { kind: 'review', mismatch: proposalCheck.trim() };
  if (proposalCheck?.status === 'mismatch') return { kind: 'review', mismatch: proposalCheck.missing || '' };
  if (proposalCheck?.status === 'unavailable') return { kind: 'review', unchecked: true, error: proposalCheck.error || '' };
  return { kind: 'correct' };
}

// The likely cause of a failed test, for the message under the verdict:
//   { cause: 'examples' }  -- nothing could be judged (no example ran, the
//                             rule selected nothing, an accept/reject pair is
//                             missing) or the test is wrong while some
//                             examples did not even run: the examples are
//                             the AI's and are what to redo first
//   { cause: 'rule', permissive, strict } -- every example ran and some gave
//                             the wrong result: if that example is right, the
//                             rule is wrong
//   null                   -- correct, review (its own message) and not
//                             executable (its own reason)
export function verdictCause(verdict, runs = []) {
  if (!verdict) return null;
  // Mejoras H, Part 1.3: the schema limits the example, regenerating it
  // will not help -- the verdict says why.
  if (verdict.kind === 'inconclusive' && verdict.schemaLimit) return null;
  if (verdict.kind === 'no_runnable' || verdict.kind === 'inconclusive') return { cause: 'examples' };
  if (verdict.kind !== 'incorrect') return null;
  // Mejoras E, Part 2.3: the verdict itself says the error and its reason.
  if (verdict.engineErrors?.length) return null;
  // An example the schema already rules out (Part 1.3) is not a bad example.
  if (runs.some((r) => !r?.validation?.runnable && !r?.schemaCovered)) return { cause: 'examples' };
  // Mejoras F, Part 1.4: every accept example the rule rejected was
  // rejected only for the document the application built -- the example
  // is not what to review.
  const rejectedAccepts = runs.filter((r) => r?.rejection);
  const appBuilt = verdict.strict === true && verdict.permissive !== true && rejectedAccepts.length > 0 && rejectedAccepts.every((r) => r.rejection.allAppBuilt);
  return { cause: 'rule', permissive: verdict.permissive === true, strict: verdict.strict === true, ...(appBuilt ? { appBuilt: true } : {}) };
}

// ─── Display ────────────────────────────────────────────────────────────────
const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

// The fragment re-indented, as lines of segments:
//   [{ depth, segments: [{ text, highlight, skeleton }] }]
// highlight marks the tag of a selected element (start and end tag) and the
// name="value" of a selected attribute; skeleton (T2b) marks the tags of the
// application's skeleton (skeletonNodePaths), shown dimmed next to the
// LLM's content. An element with text inside (a <para>, even with
// <emphasis> in it) stays on one line. Display only: whitespace inside text
// is tidied, so the rule always runs on the example's own XML, never on
// these lines. null when the XML does not parse.
export function xmlDisplayLines(xml, selectedNodePaths = [], parseXml = parseXmlDocument, skeletonNodePaths = []) {
  let doc;
  try {
    doc = parseXml(String(xml || ''));
  } catch {
    return null;
  }
  const selected = new Set(selectedNodePaths);
  const skeleton = new Set(skeletonNodePaths);
  const lines = [];
  const startTag = (el, selfClose) => {
    const path = nodePath(el);
    const hl = selected.has(path);
    const sk = skeleton.has(path);
    const segments = [{ text: `<${el.nodeName}`, highlight: hl, skeleton: sk }];
    for (const a of Array.from(el.attributes || [])) {
      segments.push({ text: ' ', highlight: false, skeleton: sk });
      segments.push({ text: `${a.name}="${escAttr(a.value)}"`, highlight: selected.has(nodePath(a)), skeleton: sk });
    }
    segments.push({ text: selfClose ? '/>' : '>', highlight: hl, skeleton: sk });
    return segments;
  };
  const endTag = (el) => {
    const path = nodePath(el);
    return { text: `</${el.nodeName}>`, highlight: selected.has(path), skeleton: skeleton.has(path) };
  };
  const visible = (el) =>
    Array.from(el.childNodes).filter((n) => n.nodeType === 1 || n.nodeType === 8 || (n.nodeType === 3 || n.nodeType === 4) && n.data.trim());
  // Mixed content (text next to elements, as in a <para>) stays on one
  // line, the way a reader sees it.
  const inline = (el) => {
    const children = Array.from(el.childNodes).filter((n) => n.nodeType !== 7);
    if (children.length === 0 || children.every((n) => (n.nodeType === 3 || n.nodeType === 4) && !n.data.trim())) {
      return startTag(el, true);
    }
    const segments = startTag(el, false);
    // The text of a skeleton element the application wrote (a DITA title).
    const skeletonText = skeleton.has(`${nodePath(el)}${SKELETON_TEXT_SUFFIX}`);
    for (const n of children) {
      if (n.nodeType === 1) segments.push(...inline(n));
      else if (n.nodeType === 8) segments.push({ text: `<!--${n.data}-->`, highlight: false, skeleton: false });
      else segments.push({ text: escText(n.data.replace(/\s+/g, ' ')), highlight: false, skeleton: skeletonText });
    }
    segments.push(endTag(el));
    return segments;
  };
  const walk = (el, depth) => {
    const children = visible(el);
    if (children.length === 0 || children.some((n) => n.nodeType === 3 || n.nodeType === 4)) {
      lines.push({ depth, segments: inline(el) });
      return;
    }
    lines.push({ depth, segments: startTag(el, false) });
    for (const n of children) {
      if (n.nodeType === 1) walk(n, depth + 1);
      else lines.push({ depth: depth + 1, segments: [{ text: `<!--${n.data}-->`, highlight: false, skeleton: false }] });
    }
    lines.push({ depth, segments: [endTag(el)] });
  };
  walk(doc.documentElement, 0);
  return lines;
}

// The indentation of a display line as real spaces, so a copied example
// keeps its structure (T2b, Part 6).
export function displayIndent(depth) {
  return '  '.repeat(depth);
}

// The display lines as plain text, indented with spaces ("Copy XML").
export function displayText(lines) {
  return lines.map((line) => displayIndent(line.depth) + line.segments.map((s) => s.text).join('')).join('\n');
}
