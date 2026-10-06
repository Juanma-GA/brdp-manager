// Lint of ONE stored rule for the scripts -- scripts/lint-curated-templates.mjs
// (the curated Excel templates) and scripts/lint-rules-stdin.mjs (the rules
// stored in the database, behind backend/scripts/lint_stored_rules.py). The
// checks live in src/utils/ruleLint.js (Barrido final 2/2: the "Test rule"
// panel and the suggested rule show them too); this wrapper gives them the
// xmldom parser and the English texts.
//
// Once per rule: a problem found in several places of the same rule is ONE
// finding, its detail lists every place and `occurrences` says how many.
//
//   lintRule(ruleXml, format, { graph? }) -> [{ kind, detail, known?, occurrences }]
//   (the paths are checked against the standard's element graph, read
//   through the backend's Python -- scripts/lib/schemaGraph.mjs)
import { DOMParser } from '@xmldom/xmldom';
import i18n from '../../src/i18n/index.js';
import { formatLintFinding, lintRuleFindings } from '../../src/utils/ruleLint.js';
import { schemaGraph } from './schemaGraph.mjs';

function parseXml(text) {
  const messages = [];
  const doc = new DOMParser({ errorHandler: (_l, msg) => messages.push(msg) }).parseFromString(text, 'text/xml');
  if (messages.length) throw new Error(messages[0].replace(/^\[xmldom \w+\]\s*/, '').split('\n')[0]);
  return doc;
}
const t = i18n.getFixedT('en');

export const escCell = (s) => String(s).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

// The standard whose element graph checks a rule's paths (Mejoras C): the
// two DITA standards share one graph.
const GRAPH_STANDARD = { 'BREX-4.2': 'S1000D 4.2', 'BREX-4.1': 'S1000D 4.1', 'BREX-3.0.1': 'S1000D 3.0.1', 'SCH-DITA': 'DITA 1.3 Xpath2.0' };

// options.graph: false skips the path check (no Python needed).
export function lintRule(ruleXml, format, options = {}) {
  const graph = options.graph === false || !GRAPH_STANDARD[format] ? null : options.graph || schemaGraph(GRAPH_STANDARD[format]);
  return lintRuleFindings(ruleXml, format, { parseXml, graph }).map((f) => {
    const { kind, detail } = formatLintFinding(f, t);
    return { kind, detail, ...(f.known ? { known: true } : {}), code: f.code, occurrences: f.occurrences };
  });
}
