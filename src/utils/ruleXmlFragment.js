// Wraps a stored rule_xml fragment (one or several root elements) in a
// <root> element so it can be parsed as a document. Moved verbatim from
// src/api/generateBREX.js (which re-exports it) so pure modules such as
// src/utils/ruleTestEngine.js can use it without importing the API client.

// Matches a qualified-name-shaped `prefix:local` occurrence (tag or
// attribute name) -- requires a letter/underscore start on both sides so
// it can't mistake something like a bare "12:34" for a namespace prefix
// (an NCName can't start with a digit). See checkWellFormed() in
// src/api/generateBREX.js for why this is needed; mirrors
// _wrap_rule_xml_fragment in backend/app/api/routes/approvals.py exactly,
// keep both in sync.
const QNAME_RE = /\b([A-Za-z_][\w.-]*):([A-Za-z_][\w.-]*)/g;

export function wrapRuleXmlFragment(xmlString) {
  // Also declares (with a dummy, well-formedness-only URI) any namespace
  // prefix the fragment actually USES but never declares itself --
  // confirmed empirically necessary for real native Schematron content
  // (<sch:pattern>/<sch:rule>/<sch:assert>): generateSchematronDITA.js's
  // finalizeSchematronDocument() only ever declares xmlns:sch on the
  // outer <sch:schema> wrapper, so an approved rule_xml fragment is only
  // valid XML once embedded there -- checked standalone (here, in the
  // manual rule editor, RecordsPage.jsx) it would otherwise fail with
  // "namespace prefix sch not declared" even though the exact same
  // content is perfectly well-formed in its real, final context.
  // Detected generically (any `prefix:name` usage) rather than hardcoding
  // "sch" specifically, so it also covers a BREX document using another
  // prefix, and costs nothing for a prefix-free BREX fragment (no match
  // -> no extra declaration, unchanged from before).
  const prefixes = new Set();
  for (const m of xmlString.matchAll(QNAME_RE)) {
    if (m[1] !== "xml" && m[1] !== "xmlns") prefixes.add(m[1]);
  }
  const nsDecls = [...prefixes]
    .sort()
    .map((p) => ` xmlns:${p}="urn:x-wellformed-check:${p}"`)
    .join("");
  return `<root${nsDecls}>${xmlString}</root>`;
}
