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
  attributeEnum,
  checkExampleStructure,
  compactValueList,
  extractDocumentNames,
  extractRuleNames,
  fixCalsRowSpans,
  formatStructureProblem,
  removeSpannedCalsEntries,
  textFacetsText,
} from '../validation/schemaValidation.js';
import { CONTENT_NODE_MARK, SKELETON_TEXT_SUFFIX, assembleExample, attributeCarrierLines, metadataXml, nestingPath, normalizeBrexReferenceCode, ruleTargets } from './ruleTestSkeleton.js';
import { setSectionValuesInDocument, setSectionValuesInText } from './ownSectionValues.js';
import { placeSentence, relocateMisplacedElements, relocateToOnlyParent, routesThrough, sectionRouteSentence, wrapLooseContent } from './schemaPlacement.js';
import { coveredRelationAlternatives } from '../validation/schemaCoverage.js';
import { applyExampleSchemaFixes, namedByRuleOrProposal } from './exampleSchemaFixes.js';
import {
  DOSSIER_MAIN_PATH,
  dossierForEngine,
  dossierProblemText,
  dossierProblems,
  dossierReferenceWarnings,
  materializeDossierFiles,
  wrapDossierFiles,
} from './ruleTestDossier.js';
import { DOSSIER_PATH_SEPARATOR } from './ruleTestSchematron.js';

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
// Test de reglas: referencias…, Part 2.3: S1000D uses no namespace, so a
// default xmlns="…" the LLM put on a top-level element of its content (a
// whole <dmodule xmlns="http://www.s1000d.org/S1000D_4-2">) makes every
// element of it invisible to the rule's paths (//dmodule selects nothing).
// It is removed before anything else; prefixed declarations (xmlns:xlink,
// xsi…) are never touched, nor nested elements, nor DITA.
// → { text, removed: [namespace URIs] }
const TOP_TAG_RE = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
const DEFAULT_XMLNS_RE = /\s+xmlns\s*=\s*("[^"]*"|'[^']*')/;
export function stripDefaultNamespace(text) {
  const source = String(text ?? '');
  const removed = [];
  let depth = 0;
  let out = '';
  let last = 0;
  for (const m of source.matchAll(TOP_TAG_RE)) {
    if (m[2] === undefined) continue; // comment, CDATA, PI
    const closing = m[1] === '/';
    const selfClosing = m[4] === '/';
    if (closing) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0) {
      const ns = DEFAULT_XMLNS_RE.exec(m[3]);
      if (ns) {
        removed.push(ns[1].slice(1, -1));
        const tag = m[0].replace(m[3], m[3].replace(DEFAULT_XMLNS_RE, ''));
        out += source.slice(last, m.index) + tag;
        last = m.index + m[0].length;
      }
    }
    if (!selfClosing) depth += 1;
  }
  return { text: removed.length ? out + source.slice(last) : source, removed };
}

// What the rule and its Proposal name (exampleSchemaFixes.js), or null when
// the setup carries no rule.
function exampleNamed(setup) {
  if (!setup?.rule?.ruleXml) return null;
  return namedByRuleOrProposal(extractRuleNames(setup.rule.ruleXml), setup.rule.proposal);
}

// [{ element, attributes }] groups merged by element (content + section).
export function mergeElementGroups(groups) {
  const out = [];
  for (const g of groups || []) {
    const found = out.find((o) => o.element === g.element);
    if (!found) {
      out.push({ element: g.element, attributes: [...g.attributes] });
      continue;
    }
    for (const a of g.attributes) if (!found.attributes.includes(a)) found.attributes.push(a);
  }
  return out;
}

// Contenido suelto, Part 2.8: what the rule selects and decides on a
// document (and its dossier) as one comparable string -- the run's status,
// its violations' messages, and for every selected node its name,
// attributes and string value (never its position: wrapping moves nodes
// under a new container, and a rule that does not depend on the direct
// parent selects the very same nodes after it). A rule on taskbody/p
// selects nothing once the <p> is in <context>: the strings differ and the
// wrap is refused. null when the rule cannot be run.
function resolveNodePath(doc, path) {
  let node = doc;
  for (const step of String(path || '').split('/').filter(Boolean)) {
    if (!node) return null;
    if (step.startsWith('@')) {
      node = node.getAttributeNode ? node.getAttributeNode(step.slice(1)) : null;
      continue;
    }
    const m = /^(.+)\[(\d+)\]$/.exec(step);
    if (!m) return null;
    const [, name, n] = m;
    const kind = name === 'text()' ? 3 : name === 'comment()' ? 8 : name === 'processing-instruction()' ? 7 : 1;
    let count = 0;
    let found = null;
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (c.nodeType !== kind || (kind === 1 && c.nodeName !== name)) continue;
      count += 1;
      if (count === Number(n)) {
        found = c;
        break;
      }
    }
    node = found;
  }
  return node;
}

function nodeSignature(node) {
  if (!node) return '?';
  const value = String(node.nodeType === 1 ? node.textContent : node.nodeValue ?? '').replace(/\s+/g, ' ').trim();
  if (node.nodeType === 2) return `@${node.nodeName}=${value}`;
  if (node.nodeType !== 1) return `${node.nodeType}:${value}`;
  const list = node.attributes || { length: 0 };
  const attrs = Array.from({ length: list.length }, (_, i) => list.item ? list.item(i) : list[i])
    .map((a) => `${a.nodeName}=${a.nodeValue}`)
    .sort()
    .join(' ');
  return `<${node.nodeName} ${attrs}>${value}`;
}

export function ruleSelectionSignature(rule, xml, schema, { parseXml = parseXmlDocument, schemaLocation = null, dossier = null } = {}) {
  if (!rule?.ruleXml || !xml) return null;
  let result;
  try {
    result = runRuleOnFragment(rule.ruleXml, rule.format, xml, schema, { parseXml, schemaLocation, ...(dossier ? { dossier } : {}) });
  } catch {
    return null;
  }
  if (!result || result.status === 'not_executable' || result.status === 'error') return null;
  const docs = new Map();
  const docOf = (file) => {
    if (!docs.has(file)) {
      const text = file === null ? xml : dossier?.files?.find((f) => f.path === file)?.xml;
      let doc;
      try {
        doc = text != null ? parseXml(String(text)) : null;
      } catch {
        doc = null;
      }
      docs.set(file, doc);
    }
    return docs.get(file);
  };
  const selected = (result.selectedNodePaths || []).map((p) => {
    const at = p.indexOf(DOSSIER_PATH_SEPARATOR);
    const file = at >= 0 ? p.slice(0, at) : null;
    const path = at >= 0 ? p.slice(at + DOSSIER_PATH_SEPARATOR.length) : p;
    const doc = docOf(file);
    return `${file ?? ''}|${doc ? nodeSignature(resolveNodePath(doc, path)) : '?'}`;
  }).sort();
  const messages = (result.violations || []).map((v) => `${v.file || ''}|${v.message || ''}`).sort();
  return JSON.stringify([result.status, selected, messages, (result.conditions || []).map((c) => c.holds)]);
}

export function materializeExample(example, setup, parseXml = parseXmlDocument) {
  const offered = Object.keys(setup.placements || {});
  const schema = example.schema || (offered.length === 1 ? offered[0] : null);
  // Part 2.3: S1000D only (DITA never had it; it declares no namespace either,
  // but its examples are left exactly as written).
  const s1000d = !String(setup.standard || '').startsWith('DITA');
  const contentNs = s1000d ? stripDefaultNamespace(example.content) : { text: example.content, removed: [] };
  const metadataNs = s1000d && example.metadata != null ? stripDefaultNamespace(example.metadata) : { text: example.metadata, removed: [] };
  const namespacesRemoved = [...new Set([...contentNs.removed, ...metadataNs.removed])];
  // Test de reglas: lo que la app puede arreglar sola (exampleSchemaFixes.js)
  // -- in the LLM's text only (content and section), never the skeleton --
  // before the table fixes, so a @cols the application adds is then raised
  // to the columns the table really uses. Without the rule (and its
  // Proposal) the application cannot tell what is tested: nothing is fixed.
  const named = exampleNamed(setup);
  const fixStructure = schema ? setup.placements?.[schema]?.structure : null;
  const contentFix = applyExampleSchemaFixes(contentNs.text, fixStructure, named);
  const metadataFix = applyExampleSchemaFixes(metadataNs.text, fixStructure, named);
  if (metadataNs.removed.length || metadataFix.text !== metadataNs.text) example = { ...example, metadata: metadataFix.text };
  const withColspecs = addMissingCalsColspecs(contentFix.text, parseXml);
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
    namespacesRemoved,
    requiredAttributesAdded: mergeElementGroups([...contentFix.requiredAttributesAdded, ...metadataFix.requiredAttributesAdded]),
    textRemoved: [...new Set([...contentFix.textRemoved, ...metadataFix.textRemoved])],
    valuesReplaced: [...contentFix.valuesReplaced, ...metadataFix.valuesReplaced],
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
      const { xml } = assembleExample({ standard: setup.standard, schema, schemaLocation: setup.schemaLocation, placement: entry.placement, content, metadata, rootAttributes: adjusted.rootAttributes || null });
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
  // Contenido suelto en el cuerpo (Part 2): a run of consecutive children
  // the schema does not allow in their parent, with no single way down
  // (the relocation above did nothing for them), goes into ONE container
  // the parent allows and that admits all of them (schemaPlacement.js
  // wrapLooseContent) -- only when the rule selects and decides the same on
  // the example before and after (ruleSelectionSignature). In the content
  // only, never the skeleton. DITA (SCH-DITA) only: a BREX example (S1000D
  // 4.2, 4.1, 3.0.1) is never wrapped, even with the same pattern -- it goes
  // to the correction round as before (Part 4).
  delete adjusted.wrapped;
  if (rule?.ruleXml && rule.format === 'SCH-DITA' && entry.structure?.models) {
    const rawDossier = setup.dossier
      ? dossierForEngine({ mainPath: setup.dossier.mainPath || DOSSIER_MAIN_PATH, files: example.files || [] })
      : null;
    const signature = (content) => {
      const { xml: doc } = assembleExample({ standard: setup.standard, schema, schemaLocation: setup.schemaLocation, placement: entry.placement, content, metadata: adjusted.metadata, rootAttributes: adjusted.rootAttributes || null });
      return doc ? ruleSelectionSignature(rule, doc, schema, { parseXml, schemaLocation: setup.schemaLocation, dossier: rawDossier }) : null;
    };
    const r = wrapLooseContent(adjusted.content, entry.structure, entry.placement.insertion || null, {
      keeps: (before, after) => {
        const a = signature(before);
        return a !== null && a === signature(after);
      },
    });
    if (r.wrapped.length) {
      adjusted.content = r.text;
      adjusted.wrapped = r.wrapped;
    }
  }
  // Rule test on DM metadata: the rule looks at the identification and
  // status section, so the LLM had to write it; an example without it is
  // not run (its validation says so). Its brexDmRef follows the DM's own
  // code (ruleTestSkeleton.js, normalizeBrexReferenceCode) unless the rule
  // looks at the brexDmRef itself.
  const section = entry.placement.metadata;
  let metadata = adjusted.metadata;
  // Test de reglas: condiciones sobre la sección de identificación del
  // propio documento (BRDP-EXT-00134). The values the rule's condition asks
  // of the document's own section (section.values, prepareRuleTestSetup):
  // the application writes the section with them (metadata.insertion
  // false, the skeleton's tree already has them); in a section the LLM
  // wrote -- or in its whole document -- they are set in every example
  // meant to be rejected (without them the rule cannot apply) and, in one
  // meant to be accepted, only where the attribute is missing or still has
  // the minimal section's value: another value there is a document the rule
  // does not apply to. A section the LLM
  // did not write is the minimal one with the values. Each example says
  // what was set.
  const sectionValues = section?.values || [];
  delete adjusted.sectionValuesSet;
  delete adjusted.sectionBuilt;
  if (sectionValues.length) {
    const force = adjusted.expected !== 'accept';
    if (entry.placement.path.length === 0) {
      const r = setSectionValuesInDocument(adjusted.content, entry.placement.root, metadataXml(section.tree, 1).xml, sectionValues, { force });
      adjusted.content = r.text;
      if (r.built) adjusted.sectionBuilt = sectionValues;
      else if (r.set.length) adjusted.sectionValuesSet = r.set;
    } else if (section.insertion) {
      if (!String(metadata ?? '').trim()) {
        metadata = metadataXml(section.tree, 1).xml.trimStart();
        adjusted.sectionBuilt = sectionValues;
      } else {
        const r = setSectionValuesInText(metadata, sectionValues, { force });
        metadata = r.text;
        if (r.set.length) adjusted.sectionValuesSet = r.set;
      }
      adjusted.metadata = metadata;
    } else {
      adjusted.sectionValuesSet = sectionValues;
    }
  }
  if (section?.insertion && !setup.keepBrexReference && metadata != null) {
    const normalized = normalizeBrexReferenceCode(metadata, section.element);
    metadata = normalized.text;
    adjusted.metadata = metadata;
    // A pm, DDN or DML: only the shared @modelIdentCode followed.
    adjusted.brexReferenceNormalized = normalized.changed && !normalized.shared;
    if (normalized.shared) adjusted.brexModelIdentFollowed = true;
  }
  // Test de reglas DITA: the topic's title the rule asks for, written by
  // the application (placement.topicTitle) -- said on every example.
  if (entry.placement.topicTitle) adjusted.topicTitleSet = entry.placement.topicTitle.value;
  else delete adjusted.topicTitleSet;
  const { xml, skeletonNodePaths, insertionPath, rootAttributeProblems } = assembleExample({
    standard: setup.standard,
    schema,
    schemaLocation: setup.schemaLocation,
    placement: entry.placement,
    content: adjusted.content,
    metadata,
    // GMC, Part 1.3: the values the example gives for the root's attributes.
    rootAttributes: adjusted.rootAttributes || null,
  });
  const missingMetadata =
    section?.insertion && entry.placement.path.length > 0 && !String(metadata || '').trim() ? section.element : null;
  // Part 2.4: the LLM gave this example no "content" (and no "metadata").
  const missingContent = example.noContent === true && !String(adjusted.content || '').trim() && !String(adjusted.metadata || '').trim();
  // Dosier, Part 2: the other files of the example's dossier, each with the
  // same fixes and the structure of its own type.
  let dossier = setup.dossier
    ? { mainPath: setup.dossier.mainPath || DOSSIER_MAIN_PATH, files: materializeDossierFiles(example.files || [], setup.dossier.structures, parseXml, { named, topicTitles: setup.dossier.topicTitles || null, checked: setup.dossier.titles?.checked || null }) }
    : null;
  // Contenido suelto (Part 2): the loose children of each dossier file
  // wrapped too -- the rule runs on the whole dossier (it reads the other
  // files) before and after, and a wrap that changes what it selects or
  // decides in any document is refused.
  if (dossier && rule?.ruleXml && rule.format === 'SCH-DITA' && xml) {
    const engineDossier = (files, path, text) => ({ mainPath: dossier.mainPath, files: files.map((f) => ({ path: f.path, xml: f.path === path ? text : f.xml ?? f.content ?? '' })) });
    dossier = {
      ...dossier,
      files: wrapDossierFiles(dossier.files, (path, before, after, files) => {
        const a = ruleSelectionSignature(rule, xml, schema, { parseXml, schemaLocation: setup.schemaLocation, dossier: engineDossier(files, path, before) });
        return a !== null && a === ruleSelectionSignature(rule, xml, schema, { parseXml, schemaLocation: setup.schemaLocation, dossier: engineDossier(files, path, after) });
      }, setup.dossier.structures),
    };
  }
  // Remates: the levels above the insertion point where the content could
  // be written instead (skeletonLiftLevels) -- only for the diagnosis of an
  // example meant to be accepted that the rule rejects (runExample).
  const skeletonLift =
    !dossier && entry.placement.contentInsertion !== false && entry.placement.rootOnly !== true
      ? skeletonLiftLevels(entry.placement, entry.structure, adjusted.content, parseXml)
      : null;
  return {
    ...adjusted,
    ...(dossier ? { mainPath: dossier.mainPath, files: dossier.files } : {}),
    schema,
    xml,
    skeletonNodePaths,
    skeletonLift,
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
    missingContent,
    rootAttributeProblems: rootAttributeProblems || [],
    // GMC, Part 1.3: the attributes this example may give for the root
    // (the panel's editor for them).
    rootAttributeNames: (entry.placement.rootAttributes || []).map((r) => r.attribute),
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
  if (options.missingContent) {
    return { wellFormed: true, error: null, names: empty, structure: [], cards: [], unknownSchema: null, missingContent: true, runnable: false };
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
      ? checkExampleStructure(doc, structure, { skipPaths: options.skeletonNodePaths || [], ignoreValueOf: options.ignoreValueOf }).filter(
          (p) => !(p.kind === 'unknownElement' && reported.has(p.element))
        )
      : []),
    ...checkCalsColspecs(doc),
    ...checkCalsTableSpans(doc),
    // GMC, Part 1.3: a "rootAttributes" name the application never writes.
    ...(options.rootAttributeProblems || []),
  ];
  return {
    wellFormed: true,
    error: null,
    names,
    structure: structureProblems,
    cards: structure ? elementCards(doc, names, structureProblems, structure) : [],
    attributeContexts: structure ? attributeContexts(doc, structureProblems, options.skeletonNodePaths || []) : [],
    unknownSchema: null,
    runnable: namesOk && structureProblems.length === 0,
  };
}

// ─── Where an attribute can go, from where the LLM put it ──────────────────
// EXT-00033 (default S1000D 4.2 BREX): the LLM wrote <dmStatus
// changeMark="1">, and the correction round only had the 672 carriers of
// @changeMark and the way to the nearest from the content -- 0 of 4 fixed.
// For each "@x does not exist on <e>" problem, the example's own context of
// the first such <e> (one the LLM wrote, never the skeleton): its ancestors
// and, for <e> and each ancestor, the elements already under it with the
// path to the shallowest of each.
// → [{ attribute, element, under: [{ element, paths: { name: [path] } }] }]
// (under[0] is <e>, then its parent, … up to the root).
function attributeContexts(doc, problems, skeletonPaths) {
  const skip = new Set(skeletonPaths);
  const out = [];
  for (const p of problems) {
    if (p.kind !== 'unknownAttribute' || out.some((c) => c.attribute === p.attribute && c.element === p.element)) continue;
    const found = elementsNamed(doc, (el) => el.nodeName === p.element && el.hasAttribute?.(p.attribute) && !skip.has(nodePath(el)));
    const el = found[0] || elementsNamed(doc, (e) => e.nodeName === p.element && e.hasAttribute?.(p.attribute))[0];
    if (!el) continue;
    const under = [];
    for (let at = el; at && at.nodeType === 1; at = at.parentNode) {
      // The shallowest place of each name under <at>, as a path from <at>.
      const paths = {};
      let level = [[at, [at.nodeName]]];
      while (level.length) {
        const next = [];
        for (const [node, path] of level) {
          for (let n = node.firstChild; n; n = n.nextSibling) {
            if (n.nodeType !== 1) continue;
            const here = [...path, n.nodeName];
            if (!(n.nodeName in paths)) paths[n.nodeName] = here;
            next.push([n, here]);
          }
        }
        level = next;
      }
      under.push({ element: at.nodeName, paths });
    }
    out.push({ attribute: p.attribute, element: p.element, under });
  }
  return out;
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
    } else if (
      p.kind === 'unknownAttribute' ||
      p.kind === 'missingRequiredAttribute' ||
      p.kind === 'textNotAllowed' ||
      p.kind === 'textFormat'
    ) {
      want(p.element);
    }
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
    required: (structure.models?.[element]?.attributes || []).map(([name]) => name),
    // Part 2 (lo que la app puede arreglar sola): said only for an element
    // whose text is the problem.
    noText: problems.some((p) => p.kind === 'textNotAllowed' && p.element === element),
    // Formato del texto, Part 1: the format its text must meet.
    textFormat: textFacetsText(structure.models?.[element]?.textFacets),
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
  // Test de reglas: atributos obligatorios -- the ones it cannot go
  // without.
  const required = card.required?.length ? `; required attributes: ${cardNameList(card.required, '@')}` : '';
  const noText = card.noText ? '; no text inside' : '';
  const textFormat = card.textFormat ? `; its text must match: ${card.textFormat}` : '';
  return `card of <${card.element}>${where}: allowed children: ${cardNameList(card.children)}${limits}; attributes: ${cardNameList(card.attributes, '@')}${required}${noText}${textFormat}`;
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
const rootAttributesText = (attrs) => JSON.stringify(attrs || {});
export function editExample(current, content, metadata, setup, parseXml = parseXmlDocument, files = undefined, rootAttributes = undefined) {
  const generated = current.generated || {
    content: current.content,
    metadata: current.metadata ?? null,
    ...(Array.isArray(current.files) ? { files: current.files.map((f) => ({ path: f.path, content: f.content })) } : {}),
    // GMC, Part 1.3: the root's attribute values the generation gave.
    rootAttributes: current.rootAttributes || null,
  };
  const edited = { ...current, content, generated };
  if (rootAttributes !== undefined) edited.rootAttributes = rootAttributes;
  if (files !== undefined) edited.files = files.map((f) => ({ path: f.path, content: f.content }));
  else if (Array.isArray(current.files)) edited.files = current.files.map((f) => ({ path: f.path, content: f.content }));
  const filesChanged = files !== undefined && filesText(files) !== filesText(current.files);
  // Mejoras H: a hand edit is the user's example, no longer the one the
  // correction could not write.
  if (content !== current.content || filesChanged || (metadata !== undefined && metadata !== (current.metadata ?? null))) delete edited.schemaLimit;
  if (metadata !== undefined) edited.metadata = metadata;
  edited.editedByUser =
    edited.content !== generated.content ||
    rootAttributesText(edited.rootAttributes) !== rootAttributesText(generated.rootAttributes) ||
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

// Colocación, Part 1: an element on the way the prompt gave to write the
// checked element inside an ancestor the rule tests (relationWays of the
// placement: levelledPara/table/title/footnote for
// //footnote[not(ancestor::table)]), put where the schema does not allow it
// (<table> inside <para>) -- the same way again.
function relationWayHint(problem, relationWays, innerWays = []) {
  if (problem.kind !== 'notAllowed') return null;
  const ways = relationWays.filter((r) => r.way.slice(1).includes(problem.element));
  // Default BREX pass, Part 2.3: the way to what the condition looks for
  // inside the checked element (<pmRef> inside <frontMatter>).
  const inner = innerWays.filter((x) => x.way.slice(1).includes(problem.element));
  if (ways.length === 0 && inner.length === 0) return null;
  return [
    ...ways.map((r) => `<${r.element}> ${r.axis === 'parent' ? 'directly ' : ''}inside <${r.ancestor}> is written by exactly this way: ${r.way.join('/')}.`),
    ...inner.map((x) => `<${x.names[x.names.length - 1]}> inside <${x.element}> is written by exactly this way: ${x.way.join('/')}.`),
  ].join(' ');
}

// The carriers of @x near where the LLM put it (attributeContexts):
// first the elements inside <e> that may carry it (schema graph, shortest
// way from <e>); if none, going up the example's ancestors of <e>: the
// ancestor itself, the siblings of the path and their descendants, at the
// nearest ancestor that has any. Those already in the example (or in the minimal section under
// <e>) come first, then the shallower, then by name. → { scope: 'inside' |
// 'up', anchor, carriers: [{ name, path, present }], total } | null.
export const NEARBY_CARRIERS_MAX = 6;
export function nearbyAttributeCarriers(structure, context, places = null) {
  const elements = structure?.elements;
  if (!elements || !context?.under?.length) return null;
  const local = String(context.attribute).replace(/^xlink:/, '');
  const carries = (name) => (elements[name]?.attributes || []).includes(local);
  const reach = (start, exclude) => {
    // BFS over the schema's children, shortest way first.
    const way = new Map();
    const queue = [];
    for (const child of elements[start]?.children || []) {
      if (child === exclude || way.has(child)) continue;
      way.set(child, [start, child]);
      queue.push(child);
    }
    while (queue.length) {
      const name = queue.shift();
      for (const child of elements[name]?.children || []) {
        if (child === exclude || way.has(child) || child === start) continue;
        way.set(child, [...way.get(name), child]);
        queue.push(child);
      }
    }
    return way;
  };
  const inMinimal = (name, anchorName) =>
    Boolean(places?.get(name)?.some((path) => path.slice(0, -1).includes(anchorName)));
  const pick = (start, exclude, presentPaths) => {
    const present = (name) => Boolean(presentPaths[name]) && (exclude == null || presentPaths[name][1] !== exclude);
    const found = [...reach(start, exclude)]
      .filter(([name]) => carries(name))
      .map(([name, path]) =>
        present(name)
          ? { name, path: presentPaths[name], present: true, minimal: false }
          : { name, path, present: false, minimal: inMinimal(name, start) }
      );
    found.sort(
      (a, b) =>
        Number(b.present) - Number(a.present) ||
        Number(b.minimal) - Number(a.minimal) ||
        a.path.length - b.path.length ||
        a.name.localeCompare(b.name)
    );
    return found;
  };
  const inside = pick(context.element, null, context.under[0].paths);
  if (inside.length) return { scope: 'inside', anchor: context.element, carriers: inside.slice(0, NEARBY_CARRIERS_MAX), total: inside.length };
  for (let i = 1; i < context.under.length; i += 1) {
    const level = context.under[i];
    const below = context.under[i - 1].element;
    // The ancestor itself first (it is already in the example), then its
    // other children and their descendants.
    const self = carries(level.element) ? [{ name: level.element, path: [level.element], present: true, minimal: false }] : [];
    const up = [...self, ...pick(level.element, below, level.paths)];
    if (up.length) return { scope: 'up', anchor: level.element, carriers: up.slice(0, NEARBY_CARRIERS_MAX), total: up.length };
  }
  return null;
}

// The English correction line for nearbyAttributeCarriers, with (Part 2)
// the closed list of values of the attribute on the first carrier named.
export function nearbyCarriersLine(problem, nearby, structure) {
  const shown = nearby.carriers.map((c) => `<${c.name}>`).join(', ');
  const paths = nearby.carriers.map((c) => c.path.join('/')).join(', ');
  const more = nearby.total > nearby.carriers.length ? `, +${nearby.total - nearby.carriers.length} more` : '';
  const head =
    nearby.scope === 'inside'
      ? `@${problem.attribute} is not allowed on <${problem.element}>. Inside <${problem.element}> it can go on: ${shown}${more} (paths: ${paths}).`
      : `@${problem.attribute} is not allowed on <${problem.element}>, nor on anything inside it. Going up from <${problem.element}>, the nearest that can carry it, from <${nearby.anchor}>: ${shown}${more} (paths: ${paths}).`;
  const lines = [head];
  const already = nearby.carriers.filter((c) => c.present).map((c) => `<${c.name}>`);
  if (already.length) lines.push(`${already.join(', ')} ${already.length === 1 ? 'is' : 'are'} already in this example.`);
  const values = attributeEnum(structure, nearby.carriers[0].name, problem.attribute);
  if (values) {
    const differs = nearby.carriers.some((c) => {
      const other = attributeEnum(structure, c.name, problem.attribute);
      return other && other.join('|') !== values.join('|');
    });
    const compact = compactValueList(values);
    lines.push(`@${problem.attribute} allowed values${differs ? ` on <${nearby.carriers[0].name}>` : ''}: ${compact.text}${compact.more ? `, +${compact.more} more` : ''}.`);
  }
  return lines.join(' ');
}

// Fichas del dosier, Part 2: (element) → the sentence that says where it
// goes in a file of this type, or null. The title the rule looks for gets
// the ways dossierTitleRequirements found for the type; any other element
// of the rule, its shortest way from the file's root (through the topic's
// body when it can).
function wayFromRoot(elements, root, body, target) {
  const bfs = (from) => {
    if (from === target) return [from];
    const previous = new Map([[from, null]]);
    const queue = [from];
    while (queue.length) {
      const name = queue.shift();
      for (const child of elements[name]?.children || []) {
        if (previous.has(child) || !elements[child]) continue;
        previous.set(child, name);
        if (child === target) {
          const path = [target];
          for (let x = name; x; x = previous.get(x)) path.unshift(x);
          return path;
        }
        queue.push(child);
      }
    }
    return null;
  };
  const viaBody = body && (elements[root]?.children || []).includes(body) ? bfs(body) : null;
  return viaBody ? [root, ...viaBody] : bfs(root);
}

function dossierFileWay(structure, type, ruleElements, titles) {
  const elements = structure?.elements;
  if (!elements || !type) return null;
  const root = structure.skeleton?.path?.[0] || type;
  const body = structure.skeleton?.path?.[1] || null;
  return (element) => {
    if (element === 'title' && titles) {
      const w = (titles.ways || []).find((x) => x.type === type);
      if (!w) return null;
      const options = [w.topic ? `on the file's own <${w.root}> (its <title>, first child)` : null, ...w.inside.map((p) => `on ${p.join('/')}`)].filter(Boolean);
      const checked = titles.checked ? `, with the checked content (<${titles.checked}>) inside it` : '';
      return `The title the rule looks for ("${titles.value}") goes ${options.join(', or ')}${checked}.`;
    }
    if (!ruleElements.has(element)) return null;
    const path = wayFromRoot(elements, root, body, element);
    return path && path.length > 1 ? `In a ${type} file, <${element}> goes this way: ${path.join('/')}.` : null;
  };
}

export function exampleProblems(validation, { standard, schema, ruleNames = null, nestings = [], expected = null, tableModel = false, sectionTree = null, sectionRoutes = [], places: rulePlaces = [], carriers = [], rootAttributes = [], relationWays = [], innerWays = [], namedAttribute = null, structure = null, dossierTitles = null, fileWay = null } = {}) {
  const places = sectionTree ? minimalSectionPlaces(sectionTree) : null;
  // GMC, Part 1.3: an attribute given for the root is never "markup of an
  // element the rule does not name": no plain-text hint for it.
  const rootElements = new Set(rootAttributes.map((r) => r.element));
  const ruleElements = new Set(ruleNames?.elements || []);
  const ruleAttributes = new Set(ruleNames?.attributes || []);
  const offer = (line, element, alsoAttribute = false) =>
    ruleNames && element && !ruleElements.has(element) && !(alsoAttribute && ruleAttributes.has(element))
      ? `${line}. ${PLAIN_TEXT_HINT}`
      : line;
  const out = [];
  if (validation.unknownSchema) out.push(`schema "${validation.unknownSchema}" was not offered; use one of the listed schemas`);
  if (validation.missingContent) out.push('the example has no "content": write it');
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
    // Fichas del dosier, Part 2: in a dossier file, an element of the rule
    // (or the title the rule looks for) put where the file's type does not
    // allow it -- the valid way from the file's root, read from its type.
    const way = fileWay && p.kind === 'notAllowed' ? fileWay(p.element) : null;
    if (way) {
      out.push(`${formatStructureProblem(p, schema)}. ${way}`);
      continue;
    }
    // Caminos de la sección, Part 1: an element on the way the rule's own
    // steps take through the section the LLM writes, put where the schema
    // does not allow it -- the same way(s) as the prompt (EXT-00188:
    // <para> inside <copyrightPara>, <para> inside <emphasis>).
    const routes = p.kind === 'notAllowed' ? routesThrough(sectionRoutes, p.element) : [];
    if (routes.length) {
      out.push(`${formatStructureProblem(p, schema)}. ${routes.map(sectionRouteSentence).join(' ')}`);
      continue;
    }
    const relationHint = relationWayHint(p, relationWays, innerWays);
    if (relationHint) {
      out.push(`${formatStructureProblem(p, schema)}. ${relationHint}`);
      continue;
    }
    // (before the general nesting hint: these ways follow every step of
    // the rule, the nesting only the pair it names).
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
    // GMC, Part 1.2: an attribute the rule checks, put on an element that
    // does not carry it -- the elements that do, and the way to the nearest.
    // Atributo, desde donde la IA lo puso: an attribute the rule looks at (or
    // the Proposal names), on an element that does not carry it -- the
    // carriers near that element, and its allowed values.
    if (p.kind === 'unknownAttribute' && namedAttribute?.(String(p.attribute).replace(/^xlink:/, ''))) {
      const context = (validation.attributeContexts || []).find((c) => c.attribute === p.attribute && c.element === p.element);
      const nearby = context ? nearbyAttributeCarriers(structure, context, places) : null;
      if (nearby) {
        out.push(nearbyCarriersLine(p, nearby, structure));
        out.movesAttribute = true;
        continue;
      }
    }
    const carrier = p.kind === 'unknownAttribute' ? carriers.find((c) => c.attribute === p.attribute) : null;
    if (carrier) {
      out.push(`${formatStructureProblem(p, schema)}. ${attributeCarrierLines(carrier).join(' ')}`);
      continue;
    }
    if (rulePlace) {
      out.push(`${formatStructureProblem(p, schema)}. ${placeSentence(rulePlace)}`);
      continue;
    }
    const element = ['unknownElement', 'notAllowed', 'unknownAttribute'].includes(p.kind) ? p.element : null;
    if (p.kind === 'unknownAttribute' && rootElements.has(p.element)) {
      out.push(formatStructureProblem(p, schema));
      continue;
    }
    out.push(offer(formatStructureProblem(p, schema), element));
  }
  for (const card of validation.cards || []) out.push(formatElementCard(card, schema));
  if (tableModel && (validation.structure || []).some((p) => TABLE_PROBLEM_KINDS.has(p.kind))) out.push(TABLE_MODEL_HINT);
  // Dosier, Part 2: the dossier's own problems, and each file's, naming the
  // file.
  for (const p of validation.dossierProblems || []) out.push(dossierProblemText(p));
  for (const f of validation.files || []) {
    if (f.validation.runnable) continue;
    const lines = exampleProblems(f.validation, {
      standard,
      schema: f.schema,
      ruleNames,
      tableModel,
      namedAttribute,
      structure: f.structure || null,
      fileWay: dossierFileWay(f.structure || null, f.schema, ruleElements, dossierTitles),
    });
    for (const line of lines) out.push(`file "${f.path}": ${line}`);
    if (lines.movesAttribute) out.movesAttribute = true;
  }
  return out;
}

// One example → { validation, result (engine output) | null, matches }.
// matches: true/false when the rule ran and gave a verdict, null otherwise.
// A materialized example (T2b) is validated against its schema's structure.
// schemaLocation: the project's setting (ruleSchemaContext.js), so a context
// block written with a custom pattern is recognized; the example's own one
// (materializeExample) wins.
function withRootSchema(reason, schema) {
  if (reason?.code === 'absolute_root') return { ...reason, params: { ...reason.params, schema } };
  if (reason?.code === 'parts' && Array.isArray(reason.params?.parts)) {
    return { ...reason, params: { ...reason.params, parts: reason.params.parts.map((p) => ({ ...p, reason: withRootSchema(p.reason, schema) })) } };
  }
  return reason;
}

export function runExample(ruleXml, format, example, { vocabulary = null, parseXml = parseXmlDocument, schemaLocation = null, graph = null, proposal = '' } = {}) {
  const unknownSchema = example.unmaterialized ? example.schema || '(none)' : null;
  // Part 3 (lo que la app puede arreglar sola): a value of an attribute the
  // rule or the Proposal names is never checked against its closed list --
  // a value outside it may be exactly the example meant to be rejected.
  const ignoreValueOf = namedByRuleOrProposal(extractRuleNames(ruleXml), proposal).attribute;
  const validation = validateExample(example.xml, vocabulary, parseXml, example.structure || null, {
    ignoreValueOf,
    unknownSchema,
    missingMetadata: example.missingMetadata || null,
    missingContent: example.missingContent === true,
    rootAttributeProblems: example.rootAttributeProblems || [],
    skeletonNodePaths: example.skeletonNodePaths || [],
  });
  // Dosier, Part 2: every file of the example's dossier is validated with
  // the structure of its own type; a problem in any of them (or in the
  // dossier itself) keeps the example from running. A reference to a file
  // not in the dossier is only a warning.
  const dossier = dossierForEngine(example);
  if (dossier) {
    validation.files = example.files.map((f) => {
      const entry = {
        path: f.path,
        schema: f.schema || null,
        validation: validateExample(f.xml ?? f.content, vocabulary, parseXml, f.structure || null, { ignoreValueOf }),
      };
      // (not enumerable: the structure is only for the correction round)
      Object.defineProperty(entry, 'structure', { value: f.structure || null, enumerable: false });
      return entry;
    });
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
        ? requiredAttributeCoveredExample(ruleXml, example, validation, proposal) ||
          schemaCoveredExample(ruleXml, format, example, validation, { parseXml, schemaLocation, graph })
        : null;
    return schemaCovered ? { validation, result: null, matches: null, schemaCovered } : { validation, result: null, matches: null };
  }
  const result = runRuleOnFragment(ruleXml, format, example.xml, example.schema || null, {
    parseXml,
    schemaLocation: example.schemaLocation || schemaLocation,
    ...(dossier ? { dossier } : {}),
  });
  // Remates de AI Extract y del test de reglas, Part 2: a path anchored at
  // another root says which schema's root this document has, so the
  // message is the same as when the test is prepared ("the rule looks at
  // <dmodule>, which the examples cannot contain (in the ddn schema the
  // root is <ddn>)").
  if (example.schema && result.notExecutableReason) result.notExecutableReason = withRootSchema(result.notExecutableReason, example.schema);
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
  // Remates: the rejection comes from where the application put the
  // content, not from the content (skeletonPlacementDiagnosis).
  const skeletonPlacement =
    example.expected === 'accept' && result.status === 'rejected'
      ? skeletonPlacementDiagnosis(ruleXml, format, example, { parseXml, schemaLocation, dossier })
      : null;
  return {
    validation,
    result,
    matches,
    rejectedByBrexReference: rejectedByBrexReference(result),
    acceptance,
    predicateMiss,
    rejection,
    ...(skeletonPlacement ? { skeletonPlacement } : {}),
  };
}

// ─── Remates: an example the skeleton makes impossible ─────────────────────
// Real cases (CMP 4.2): BRDP-EXT-00043, //description//levelledPara/
// levelledParaAlts in descript, and BRDP-EXT-00059, //mainProcedure//
// proceduralStep/proceduralStepAlts in proced. The application writes the
// content inside the skeleton's <levelledPara> / <proceduralStep>, so the
// example meant to be accepted ("<levelledParaAlts> directly in
// <description>") always sits inside one and a correct rule rejects it --
// and no edit can fix it. Diagnosis only: the same content one level up
// (in the parent of the insertion point), then the next, up to the
// content's root (<content>, or the document's root), stopping at the
// first level that accepts it; a level whose element the schema does not
// let hold each top-level element of the content stops the climb (no
// diagnosis). Never changes the document shown or saved.

// The levels above the insertion point, nearest first:
//   { insertion, insertionPath, levels: [{ name, path, chainPath, fits }] }
// path: the level's node path in the assembled document; chainPath: the
// skeleton element under it that holds the content (what the content
// replaces); fits: the schema lets <name> hold each top-level element of
// the content (and the content has no top-level text). null when there is
// no level or no content.
export function skeletonLiftLevels(placement, structure, content, parseXml = parseXmlDocument) {
  const path = placement?.path || [];
  if (path.length < 2 || !structure?.elements) return null;
  const top = contentTopLevel(content, parseXml);
  if (!top || top.names.length === 0) return null;
  const pathOf = (i) => path.slice(0, i + 1).map((n) => `/${n}[1]`).join('');
  const last = path.length - 1;
  const contentIdx = path.indexOf('content');
  const stop = contentIdx >= 0 && contentIdx < last ? contentIdx : 0;
  const levels = [];
  for (let i = last - 1; i >= stop; i -= 1) {
    const children = structure.elements[path[i]]?.children || [];
    levels.push({ name: path[i], path: pathOf(i), chainPath: pathOf(i + 1), fits: !top.text && top.names.every((n) => children.includes(n)) });
  }
  return levels.length ? { insertion: path[last], insertionPath: pathOf(last), levels } : null;
}

const LIFT_WRAPPER_NS = 'xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"';
function contentTopLevel(content, parseXml) {
  const text = String(content ?? '').trim();
  if (!text) return null;
  let doc;
  try {
    doc = parseXml(`<lift-wrapper ${LIFT_WRAPPER_NS}>${text}</lift-wrapper>`);
  } catch {
    return null;
  }
  const names = [];
  let hasText = false;
  for (let n = doc.documentElement.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1) names.push(n.nodeName);
    else if ((n.nodeType === 3 || n.nodeType === 4) && n.nodeValue.trim()) hasText = true;
  }
  return { names: [...new Set(names)], text: hasText };
}

// Element by node path (/a[1]/b[2]...) in a parsed document.
function elementAt(doc, path) {
  let el = null;
  for (const step of String(path).split('/').filter(Boolean)) {
    const m = /^(.+)\[(\d+)\]$/.exec(step);
    if (!m) return null;
    const [, name, nth] = m;
    if (!el) {
      el = doc.documentElement?.nodeName === name && nth === '1' ? doc.documentElement : null;
    } else {
      let count = 0;
      let found = null;
      for (let c = el.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 1 && c.nodeName === name && (count += 1) === Number(nth)) {
          found = c;
          break;
        }
      }
      el = found;
    }
    if (!el) return null;
  }
  return el;
}

const escXmlText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escXmlAttr = (s) => escXmlText(s).replace(/"/g, '&quot;');
// A plain serializer (the same in the browser and in Node): elements with
// their attributes as written (xmlns declarations included), text, CDATA,
// comments and processing instructions.
function serializeNode(node) {
  switch (node.nodeType) {
    case 1: {
      const attrs = Array.from(node.attributes || []).map((a) => ` ${a.name}="${escXmlAttr(a.value)}"`).join('');
      let inner = '';
      for (let c = node.firstChild; c; c = c.nextSibling) inner += serializeNode(c);
      return `<${node.nodeName}${attrs}>${inner}</${node.nodeName}>`;
    }
    case 3:
      return escXmlText(node.nodeValue);
    case 4:
      return `<![CDATA[${node.nodeValue}]]>`;
    case 7:
      return `<?${node.target} ${node.data}?>`;
    case 8:
      return `<!--${node.nodeValue}-->`;
    default:
      return '';
  }
}

// The example's document with its content written directly in `level`:
// the skeleton element under the level (chainPath) is replaced by the
// content of the insertion point (the skeleton's own <title> left out).
function liftedDocument(xml, lift, level, skeletonPaths, parseXml) {
  let doc;
  try {
    doc = parseXml(String(xml || ''));
  } catch {
    return null;
  }
  const insertion = elementAt(doc, lift.insertionPath);
  const chain = elementAt(doc, level.chainPath);
  if (!insertion || !chain || !chain.parentNode) return null;
  const skeleton = new Set(skeletonPaths || []);
  const moved = [];
  for (let c = insertion.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 1 && skeleton.has(nodePath(c))) continue;
    moved.push(c);
  }
  const parent = chain.parentNode;
  for (const n of moved) parent.insertBefore(n, chain);
  parent.removeChild(chain);
  return serializeNode(doc.documentElement);
}

// → { inside, at } | null: the rule rejected the example inside the
// skeleton's <inside> and accepts the same content written directly in
// <at>.
export function skeletonPlacementDiagnosis(ruleXml, format, example, { parseXml = parseXmlDocument, schemaLocation = null, dossier = null } = {}) {
  const lift = example?.skeletonLift;
  if (!lift || !example.xml || dossier) return null;
  for (const level of lift.levels || []) {
    if (!level.fits) return null;
    const xml = liftedDocument(example.xml, lift, level, example.skeletonNodePaths, parseXml);
    if (!xml) return null;
    const r = runRuleOnFragment(ruleXml, format, xml, example.schema || null, { parseXml, schemaLocation: example.schemaLocation || schemaLocation });
    if (r.status === 'accepted') return { inside: lift.insertion, at: level.name };
    if (r.status !== 'rejected') return null;
  }
  return null;
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
  // GMC, Part 1.3: an attribute the example gave for the root is its own.
  const appBuilt = (p) =>
    example.minimalDocument === true || (!skeleton.has(`${CONTENT_NODE_MARK}${p}`) && skeleton.has(p.replace(/\/@[^/]+$/, '')));
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

// Test de reglas: atributos obligatorios. An example meant to be rejected
// whose only problem is a required attribute it leaves out
// (missingRequiredAttribute), and every such attribute is one the rule or
// the Proposal names: the decision it breaks ("@verificationType shall be
// stated") cannot be broken in a valid document -- the schema already
// requires it (GMC 4.2 BRDP-EXT-00160: <firstVerification/> without
// @verificationType). Never corrected and never counted, as the other
// schemaCovered examples; with no example meant to be rejected left to
// run, the verdict is "already covered by the schema" with
// "@verificationType is required in <firstVerification>". An attribute
// neither names is only an example written wrong: correction round.
// → { items: [{ kind: 'requiredAttribute', element, other }] } | null
function requiredAttributeCoveredExample(ruleXml, example, validation, proposal) {
  if (!validation.wellFormed || validation.unknownSchema || validation.missingMetadata || validation.missingContent) return null;
  if (validation.names?.available && (validation.names.notFound.length > 0 || validation.names.wrongType.length > 0)) return null;
  if ((validation.dossierProblems || []).length > 0) return null;
  const problems = [...(validation.structure || []), ...(validation.files || []).flatMap((f) => f.validation.structure || [])];
  if (!problems.length || !problems.every((p) => p.kind === 'missingRequiredAttribute')) return null;
  if ((validation.files || []).some((f) => !f.validation.wellFormed)) return null;
  const named = new Set(extractRuleNames(ruleXml).attributes || []);
  const text = String(proposal || '');
  const inProposal = (name) => new RegExp(`(^|[^\\w@.-])@?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(text);
  if (!problems.every((p) => named.has(p.attribute) || inProposal(p.attribute))) return null;
  const items = [];
  for (const p of problems) {
    if (!items.some((i) => i.element === p.element && i.other === p.attribute)) items.push({ kind: 'requiredAttribute', element: p.element, other: p.attribute });
  }
  return { items, nodePaths: [] };
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
    // Test de reglas: referencias…, Part 2.2: decided by code from the
    // schema alone (no element the rule forbids exists in its context
    // schema) -- no example is needed to say so.
    if (coverage?.byCode) return { kind: 'schema_covered', items: coverage.items, via: 'path' };
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
  // Remates: every example that did not give what it expects was rejected
  // only because of where the application put its content (written one
  // level up, the rule accepts it) -- the test says nothing about the rule.
  const mismatchRuns = runs.filter((r) => r.matches === false);
  if (mismatchRuns.length > 0 && mismatchRuns.every((r) => r.skeletonPlacement)) {
    const { inside, at } = mismatchRuns[0].skeletonPlacement;
    return { kind: 'inconclusive', why: 'skeleton_placement', inside, at };
  }
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
  // Remates: the skeleton causes it; regenerating will not help.
  if (verdict.kind === 'inconclusive' && verdict.why === 'skeleton_placement') return null;
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
      // GMC, Part 1.3: an attribute the example gave for the root is shown as
      // the example's content, not dimmed with the skeleton.
      const own = skeleton.has(`${CONTENT_NODE_MARK}${nodePath(a)}`);
      segments.push({ text: ' ', highlight: false, skeleton: sk && !own });
      segments.push({ text: `${a.name}="${escAttr(a.value)}"`, highlight: selected.has(nodePath(a)), skeleton: sk && !own });
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
