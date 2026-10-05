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
//   lintRule(ruleXml, format) -> [{ kind, detail, known?, occurrences }]
import { DOMParser } from '@xmldom/xmldom';
import i18n from '../../src/i18n/index.js';
import { formatLintFinding, lintRuleFindings } from '../../src/utils/ruleLint.js';

function parseXml(text) {
  const messages = [];
  const doc = new DOMParser({ errorHandler: (_l, msg) => messages.push(msg) }).parseFromString(text, 'text/xml');
  if (messages.length) throw new Error(messages[0].replace(/^\[xmldom \w+\]\s*/, '').split('\n')[0]);
  return doc;
}
const t = i18n.getFixedT('en');

export const escCell = (s) => String(s).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

export function lintRule(ruleXml, format) {
  return lintRuleFindings(ruleXml, format, { parseXml }).map((f) => {
    const { kind, detail } = formatLintFinding(f, t);
    return { kind, detail, ...(f.known ? { known: true } : {}), code: f.code, occurrences: f.occurrences };
  });
}
