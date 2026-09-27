// Suggest Rule validation -- XPath syntax (schema-location encargo, Part 3).
// A real Mistral run wrote <objectPath>//&lt;emphasis&gt;</objectPath>: the
// name check (ruleNameCheck.js) extracts "emphasis", which IS a real 4.2
// element, so nothing was flagged -- the expression itself is not XPath.
// This checks that every XPath expression of a rule (objectPath/objpath in
// BREX, @context and @test in Schematron -- extractRuleXPaths(), already
// entity-decoded) parses.
//
// Parser: fontoxpath (XPath 3.1), the same code in the browser and in plain
// Node (scripts/run-prompt-eval.mjs's xpath_valid check), so the app and the
// eval suite always agree. document.createExpression was not used: it is
// XPath 1.0 only and would reject valid DITA Schematron XPath 2.0/3.0
// (`every $r in … satisfies`, `('a','b')`, inline functions) and block
// Accept on correct rules. Consequence, accepted: XPath 2.0+ syntax in a
// BREX objectPath is not reported (only real syntax errors are).
//
// Only syntax errors count (XPST0003). Static errors that are normal in a
// rule fragment -- an undeclared $variable (sch:let), a prefix (xlink:,
// sch:, xs:) or a function this parser doesn't register (matches/3, doc) --
// and dynamic errors (no context item) never make an expression invalid.
import fontoxpath from 'fontoxpath';
import { extractRuleXPaths } from './ruleNameCheck.js';

const SYNTAX_ERROR = 'XPST0003';

export function isXPathSyntaxValid(expression) {
  try {
    fontoxpath.evaluateXPath(expression, null, null, null, fontoxpath.evaluateXPath.ANY_TYPE, {
      language: fontoxpath.evaluateXPath.XPATH_3_1_LANGUAGE,
    });
    return true;
  } catch (err) {
    return !String(err?.message || '').includes(SYNTAX_ERROR);
  }
}

// The rule's XPath expressions that are not syntactically valid (after
// undoing the XML escapes), in document order, without duplicates.
export function invalidRuleXPaths(ruleXml) {
  const invalid = [];
  for (const expression of extractRuleXPaths(ruleXml)) {
    if (!isXPathSyntaxValid(expression) && !invalid.includes(expression)) invalid.push(expression);
  }
  return invalid;
}
