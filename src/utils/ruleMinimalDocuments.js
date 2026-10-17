// Mejoras F, Part 1.1: the rule run on the document the application builds
// for each schema of the standard with NOTHING written for the test -- the
// same assembly as the examples (assembleExample: the skeleton's path, its
// titled elements and the minimal identification and status section), with
// an empty insertion point. By code, no LLM. The skeletons come with the
// standard's element graph (GET /api/schema-cards/graph, `skeletons`),
// loaded once per standard.
//
// Real cases (S1000D 3.0.1):
//   BRDP-EXT-02770  /*[not(self::dmodule)]   rejects pm, ddn, dml, comment
//   BRDP-EXT-02719  //*[text()[contains(., '  ')]]   rejects the indentation
//                   whitespace of every document the application builds
//   the corrected rule offered for BRDP-EXT-02651, objappl="1" on
//                   //reqconds[…]: rejects a descript data module that has
//                   nothing written in it
//
// → { available, results: [{ schema, status, selectedNodePaths, reason }],
//     accepted: [schemas], rejected: [schemas], counted }
//   status: 'accepted' | 'rejected' | 'not_applicable' (a context-scoped
//   rule on another schema) | 'not_executable' (e.g. a path anchored on
//   another root) | 'error'. Only accepted and rejected count.
//   available: false without skeletons (no graph, or none for the standard).
import { supportsSchemaContext } from './ruleSchemaContext.js';
import { assembleExample } from './ruleTestSkeleton.js';
import { parseXmlDocument, runRuleOnFragment } from './ruleTestEngine.js';

// The minimal document of one schema, or null.
export function minimalDocument(graph, standard, schema, schemaLocation = null) {
  const skeleton = graph?.skeletons?.[schema];
  if (!skeleton?.path?.length) return null;
  const placement = {
    path: skeleton.path,
    insertion: skeleton.path[skeleton.path.length - 1],
    titled: skeleton.titled || [],
    metadata: skeleton.metadata ? { element: skeleton.metadata.element, tree: skeleton.metadata.tree, insertion: false } : null,
    contentInsertion: true,
  };
  return assembleExample({ standard, schema, schemaLocation, placement, content: '' });
}

export function minimalDocumentRuns(ruleXml, format, graph, { standard, schemaLocation = null, parseXml = parseXmlDocument } = {}) {
  const schemas = Object.keys(graph?.skeletons || {}).sort();
  if (schemas.length === 0) return { available: false, results: [], accepted: [], rejected: [], counted: 0 };
  const results = [];
  for (const schema of schemas) {
    const doc = minimalDocument(graph, standard, schema, schemaLocation);
    if (!doc?.xml) continue;
    let status;
    let selectedNodePaths = [];
    let reason = null;
    try {
      // DITA: no schema URL on the root, the schema is given as the type.
      const r = runRuleOnFragment(ruleXml, format, doc.xml, supportsSchemaContext(standard) ? null : schema, { parseXml, schemaLocation });
      selectedNodePaths = r.selectedNodePaths || [];
      if (r.notApplicable) {
        status = 'not_applicable';
      } else if (r.status === 'rejected' || r.status === 'accepted') {
        status = r.status;
      } else if (r.status === 'error') {
        status = 'error';
        reason = r.runtimeErrors?.[0] || null;
      } else {
        status = 'not_executable';
        reason = r.notExecutableReason || null;
      }
    } catch (err) {
      status = 'error';
      reason = err?.message || String(err);
    }
    results.push({ schema, status, selectedNodePaths, reason, xml: doc.xml, skeletonNodePaths: doc.skeletonNodePaths });
  }
  const accepted = results.filter((r) => r.status === 'accepted').map((r) => r.schema);
  const rejected = results.filter((r) => r.status === 'rejected').map((r) => r.schema);
  return { available: true, results, accepted, rejected, counted: accepted.length + rejected.length };
}

// Mejoras F, Part 1.1 (c): the schemas whose minimal document the new rule
// rejects and the previous one accepted -- the corrected rule rejects a
// document of that type with nothing written for the test.
export function newlyRejectedMinimalDocuments(previousRuns, nextRuns) {
  if (!previousRuns?.available || !nextRuns?.available) return [];
  const before = new Map(previousRuns.results.map((r) => [r.schema, r.status]));
  return nextRuns.rejected.filter((s) => before.get(s) === 'accepted');
}
