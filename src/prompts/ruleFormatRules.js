// Per-format rules for writing ONE general rule (docs request, Suggest
// Rule round). The knowledge comes from the STRICT RULES of the prompts
// Generate's generators used when they still called the LLM (removed in
// Barrido final 4: Generate only assembles approved rules today), narrowed
// to what one general rule needs: no chunking/assembly instructions, no
// id-suffix splitting across several rules, and no "can't be generated"
// fallback (a nonContextRule / traceability comment), which Suggest Rule
// replaces with its own NOT_CHECKABLE answer (suggestRulePrompt.js). This
// is the only source of per-format rule-writing instructions in the app.
import { queryBindingForStandard } from '../api/generateSchematronDITA.js';

// Rule 4/5 of the BREX blocks (Suggest Rule adjustments round): a real
// Mistral run expressed "only these values" as an objectPath predicate
// ([.!="a" and .!="b"]) instead of objectValue, and wrote attribute names
// in objectUse without "@". The example uses an invented, generic
// attribute (@acmeCode, ac01/ac02) so it can't be copied into a real rule.
const BREX_4X_OBJECT_USE = `4. <objectUse> = one sentence stating the decision. Inside it, write attribute names as @name and element names as &lt;name&gt; — never a raw tag, never a bare name.`;

const BREX_4X_VALUE_LIST = `5. When the Proposal limits an attribute or element to a list of values: objectPath selects that attribute/element with allowedObjectFlag="2", and there is one <objectValue valueForm="single" valueAllowed="…"> per allowed value, with ONLY the attributes valueAllowed and valueForm. Never express the list as a predicate in objectPath (such as [. != 'a' and . != 'b']). valueForm is "single", "range" or "pattern" — never list, regex, conditional or multiple. Minimal example (invented attribute, not from this BRDP) for "@acmeCode shall only take ac01 or ac02":
   <objectPath allowedObjectFlag="2">//@acmeCode</objectPath>
   <objectUse>The attribute @acmeCode only takes the values ac01 and ac02.</objectUse>
   <objectValue valueForm="single" valueAllowed="ac01">ac01</objectValue>
   <objectValue valueForm="single" valueAllowed="ac02">ac02</objectValue>`;

// Rule 6 of the BREX blocks (schema-location encargo, Part 3): the old
// wording ("a literal < or & must be escaped as &lt; / &amp;"), next to
// rule 4 (&lt;name&gt; in objectUse) and a Proposal that writes <emphasis>,
// produced <objectPath>//&lt;emphasis&gt;</objectPath> in all three passes
// of a real Mistral run -- not XPath. The generic name (acmeElement) keeps
// the examples from being copied into a real rule.
const BREX_4X_PATH_NAMES = `6. Inside objectPath, write element and attribute names bare, exactly as in XPath — no angle brackets and no escaping: //emphasis, //@emphasisType. &lt;name&gt; is only for objectUse text, never for objectPath. &lt; and &amp; are used in objectPath only for a literal < or & that belongs to the expression itself (the less-than operator, or an & inside a string), e.g. //para[count(x) &lt; 3]. Example (invented element, not from this BRDP):
   Correct: <objectPath allowedObjectFlag="0">//acmeElement</objectPath>
   Wrong:   <objectPath allowedObjectFlag="0">//&lt;acmeElement&gt;</objectPath>`;

// Rule 7 of the BREX blocks (Mejoras D, Part 2.5): BRDP-EXT-02815 wrote
// //figure//legend/deflist/term[not(. = //figure//graphic//hotspot/@apsname)]
// for "de su <figure>" -- //figure inside the condition is every figure of
// the document, not the term's own.
const brexOwnAncestor = (pathElement) => `7. When the decision relates an element to another one of "its" X (its <figure>, the <table> it is in), reach X inside the condition of ${pathElement} with ancestor::X, never with //X: //X is every X of the document.`;

// Rule 8 of the BREX blocks and 13 of Schematron (Mejoras F, Part 1.5):
// BRDP-EXT-02719, //*[text()[contains(., '  ')]], rejected every document
// -- the indentation between elements is text too.
const TEXT_NODES_LINE = 'The indentation and line breaks between elements are text nodes too: a rule on text looks at text() and never counts the nodes that are only spaces or line breaks (keep them out with text()[normalize-space(.)]).';

// Rule 9 of the BREX blocks (Mejoras F, Part 2.2a): BRDP-EXT-02636, "every
// <row> inside <tbody> must have @rowsep='0'", was corrected to
// objappl="1" on //tbody/row/@rowsep with a value -- validators do not
// agree on that form (some reject a document with no <row> at all). The
// opposite, forbidden, means the same in every validator.
// Remates de Mejoras G, Part 1.2: with several values, the list as a
// condition (X[not(@a='v1' or @a='v2')]) hid the values in a predicate --
// the list goes in its own rule (rule 5) and a second rule makes the
// attribute required, unless the schema already does.
const brexValueOnEvery = ({ pathElement, flagAttr, oneValue, listRule, requiredRule }) => `9. When the Proposal says every <X> must carry @a with a given value: forbid the opposite with ${flagAttr}="0" on X[not(@a='v')] — one rule. With SEVERAL allowed values, two rules: {ID}-1 with the list (rule 5: ${pathElement} selects X/@a, one value per allowed value) and {ID}-2 with ${flagAttr}="0" on X[not(@a)], so the attribute must be there; when SCHEMA FACTS say @a is required in <X>, write only {ID}-1. Never the list as a condition (X[not(@a='v1' or @a='v2')]) and never ${flagAttr}="1" with values. Examples (invented names, not from this BRDP):
   "every <acmeElement> shall carry @acmeAttr with the value 1":
   ${oneValue}
   "every <acmeElement> shall carry @acmeAttr with the value 1 or 2":
   {ID}-1: ${listRule}
   {ID}-2: ${requiredRule}`;

const BREX_4X_VALUE_ON_EVERY = brexValueOnEvery({
  pathElement: 'objectPath',
  flagAttr: 'allowedObjectFlag',
  oneValue: `<objectPath allowedObjectFlag="0">//acmeElement[not(@acmeAttr='1')]</objectPath>`,
  listRule: `<objectPath allowedObjectFlag="2">//acmeElement/@acmeAttr</objectPath> with <objectValue valueForm="single" valueAllowed="1">1</objectValue> and <objectValue valueForm="single" valueAllowed="2">2</objectValue>`,
  requiredRule: `<objectPath allowedObjectFlag="0">//acmeElement[not(@acmeAttr)]</objectPath>`,
});

const BREX_301_VALUE_ON_EVERY = brexValueOnEvery({
  pathElement: 'objpath',
  flagAttr: 'objappl',
  oneValue: `<objpath objappl="0">//acmeElement[not(@acmeAttr='1')]</objpath>`,
  listRule: `<objpath>//acmeElement/@acmeAttr</objpath> with <objval valtype="single" val1="1"/> and <objval valtype="single" val1="2"/>`,
  requiredRule: `<objpath objappl="0">//acmeElement[not(@acmeAttr)]</objpath>`,
});

// Rule 10 of the BREX blocks and 14 of Schematron (Mejoras G, Part 1.5):
// BRDP-EXT-02792's corrected rule compared normalize-space() of
// ancestor::applic/displaytext/p, and <displaytext> holds any number of <p>
// -- with two, XPath 2.0 stops with an error and XPath 1.0 reads the first.
const SEVERAL_NODES_LINE = 'A text function (normalize-space, string, concat, contains…) takes ONE node: never give it a path that can return several (a child that can repeat, or //x that can appear more than once). For "any of them" use some $x in … satisfies …; for the first, add [1].';

const BREX_42 = `FORMAT — S1000D Issue 4.2 BREX: <structureObjectRule> elements (normally one).
1. Normally output one <structureObjectRule id="{ID}" brSeverityLevel="brsl01">. When the Proposal makes several independent requirements, write one <structureObjectRule> per requirement, with ids {ID}-1, {ID}-2…, each with its own <objectPath> and its <objectUse>; never two <objectPath> in one rule. Never a context block (<contextRules>: when the rule is limited to some schemas, the application adds it), a <nonContextRule>, or a dmodule wrapper. {ID} is the BRDP's ID.
2. Child order: <brDecisionRef brDecisionIdentNumber="{ID}"/> → <objectPath> → <objectUse> → <objectValue> (zero or more). brDecisionRef carries the ID as an ATTRIBUTE, never as text.
3. Exactly ONE <objectPath> per rule. Its only attribute is allowedObjectFlag: "0" = the selected nodes are prohibited, "1" = mandatory, "2" = optional. No other attribute on objectPath.
${BREX_4X_OBJECT_USE}
${BREX_4X_VALUE_LIST}
${BREX_4X_PATH_NAMES}
${brexOwnAncestor('objectPath')}
8. ${TEXT_NODES_LINE}
${BREX_4X_VALUE_ON_EVERY}
10. ${SEVERAL_NODES_LINE}`;

const BREX_41 = `FORMAT — S1000D Issue 4.1 BREX: <structureObjectRule> elements (normally one).
1. Normally output one <structureObjectRule id="{ID}">. When the Proposal makes several independent requirements, write one <structureObjectRule> per requirement, with ids {ID}-1, {ID}-2…, each with its own <objectPath> and its <objectUse>; never two <objectPath> in one rule. Never a context block (<contextRules>: when the rule is limited to some schemas, the application adds it), a <nonContextRule>, or a dmodule wrapper. {ID} is the BRDP's ID.
2. Child order: <objectPath> → <objectUse> → <objectValue> (zero or more). There is NO brDecisionRef element and NO brSeverityLevel attribute in S1000D 4.1.
3. Exactly ONE <objectPath> per rule. Its only attribute is allowedObjectFlag: "0" = the selected nodes are prohibited, "1" = mandatory, "2" = optional. No other attribute on objectPath.
${BREX_4X_OBJECT_USE}
${BREX_4X_VALUE_LIST}
${BREX_4X_PATH_NAMES}
${brexOwnAncestor('objectPath')}
8. ${TEXT_NODES_LINE}
${BREX_4X_VALUE_ON_EVERY}
10. ${SEVERAL_NODES_LINE}`;

// 3.0.1 gets the same reinforcement, adapted: objappl only has 0/1 (no
// "optional") and is optional itself in the 3.0.1 BREX schema -- the real
// value-list rules of the curated 3.0.1 template omit it unless the node
// is also mandatory.
const BREX_301 = `FORMAT — S1000D Issue 3.0.1 BREX: <objrule> elements (normally one).
1. Normally output one <objrule id="{ID}">. When the Proposal makes several independent requirements, write one <objrule> per requirement, with ids {ID}-1, {ID}-2…, each with its own <objpath> and its <objuse>; never two <objpath> in one rule. Never a context block (<contextrules>: when the rule is limited to some schemas, the application adds it) or a dmodule wrapper. {ID} is the BRDP's ID. There is NO brDecisionRef in 3.0.1.
2. Child order: <objpath> → <objuse> → <objval> (one per allowed value, zero or more).
3. Exactly ONE <objpath> per rule. Its only attribute is objappl: "0" = the selected nodes are prohibited, "1" = mandatory. NO other values (there is no "optional" in 3.0.1).
4. <objuse> = one sentence stating the decision. Inside it, write attribute names as @name and element names as &lt;name&gt; — never a raw tag, never a bare name. Escape &lt; &gt; &amp;.
5. When the Proposal limits an attribute or element to a list of values: objpath selects that attribute/element, and there is one <objval valtype="single" val1="…"> per allowed value, with ONLY the attributes val1, val2 and valtype; valtype is "single" or "range" (val2 only for "range") — never pattern, list, regex, conditional or multiple. Leave objappl out; when every <X> must carry the attribute with one of the values, see rule 9. Never express the list as a predicate in objpath (such as [. != 'a' and . != 'b']). Minimal example (invented attribute, not from this BRDP) for "@acmecode shall only take ac01 or ac02":
   <objpath>//@acmecode</objpath>
   <objuse>The attribute @acmecode only takes the values ac01 and ac02.</objuse>
   <objval valtype="single" val1="ac01"/>
   <objval valtype="single" val1="ac02"/>
6. Inside objpath, write element and attribute names bare, exactly as in XPath — no angle brackets and no escaping: //emphasis, //@emph. &lt;name&gt; is only for objuse text, never for objpath. &lt; and &amp; are used in objpath only for a literal < or & that belongs to the expression itself (the less-than operator, or an & inside a string), e.g. //para[count(x) &lt; 3]. Example (invented element, not from this BRDP):
   Correct: <objpath objappl="0">//acmeElement</objpath>
   Wrong:   <objpath objappl="0">//&lt;acmeElement&gt;</objpath>
${brexOwnAncestor('objpath')}
8. ${TEXT_NODES_LINE}
${BREX_301_VALUE_ON_EVERY}
10. ${SEVERAL_NODES_LINE}`;

function schDita(standard) {
  const queryBinding = queryBindingForStandard(standard);
  const xpathLine =
    queryBinding === 'xslt3'
      ? 'The document is validated with queryBinding="xslt3": XPath 3.0 is available (inline functions, the "!" map operator, "=>").'
      : 'The document is validated with queryBinding="xslt2": use XPath 2.0 only — never XPath 3.0-only syntax (inline function(...) expressions, the "!" map operator, "=>", map{}/array{}).';
  return `FORMAT — ISO Schematron for DITA 1.3: exactly ONE <sch:pattern> block.
1. Output exactly one <sch:pattern id="p-{ID}"> containing ONE <sch:rule context="...">. {ID} is the BRDP's ID. No <sch:schema> wrapper, no XML comments. ${xpathLine}
2. If the decision needs more than one independent check, put them all inside that SAME sch:rule as separate sch:assert/sch:report elements. Each sch:assert/sch:report has id="{ID}", or "{ID}-slug" with a short descriptive slug when there is more than one — never the same id twice.
3. context MUST be a valid match pattern: an element name, a union of element names with "|", and predicates on that node. NEVER start context with a reverse axis (ancestor::, parent::, preceding::, preceding-sibling::) — put ancestor/parent checks inside test instead.
4. sch:rule/@context selects the elements to check; sch:assert/@test states the condition they must meet. Never put the condition in @context and pair it with test="false()". Example (invented names, not from this BRDP) for "every <acmeElement> shall carry @acmeAttr":
   Correct: <sch:rule context="acmeElement"><sch:assert id="{ID}" test="@acmeAttr" role="error">…</sch:assert></sch:rule>
   Wrong:   <sch:rule context="acmeElement[not(@acmeAttr)]"><sch:assert id="{ID}" test="false()" role="error">…</sch:assert></sch:rule>
   test="false()" is only for an absolute prohibition of an element with no exceptions: context is the forbidden element itself, with no predicate.
5. Closed list of permitted values -> test="@attr = ('v1','v2','v3')". Never a regex for a short closed list.
6. Attribute format constraint -> matches(@attr, '^...$', 'i'), anchored, applied to the attribute that ACTUALLY carries that data.
7. Nesting-depth limit -> count(ancestor::element-name) compared with a relational operator. Never nested positional predicates.
8. sch:assert fires its message when test is FALSE (phrase test as what MUST be true); sch:report fires when test is TRUE (what must NOT happen). Never invert the polarity.
9. role="error" for absolute prohibitions/mandates ("must", "shall not", "is required"); role="warning" for recommendations ("should", "recommend", "consider").
10. Inside sch:assert/sch:report message text, write element names as &lt;elementName&gt;. Inside test, context and sch:let/@value, a literal < or & must be escaped as &lt; / &amp; (count(...) &lt; 2, never a raw <).
11. Never write a vacuous test (e.g. two nearly identical expressions compared with each other) — if the only way to "check" the decision is vacuous, the decision is not checkable.
12. Row-by-row check across columns of a DITA/CALS table -> resolve each column by its header TEXT with <sch:let name="colX" value="tgroup/thead/row[1]/entry[normalize-space(.) = 'Header Text']/@colname"/> placed before the checks, and express "for every row" with "every $row in tgroup/tbody/row satisfies (...)" — never by column position.
13. ${TEXT_NODES_LINE}
14. ${SEVERAL_NODES_LINE}`;
}

// `format` is the rule_approvals format id (STANDARD_TO_RULE_FORMAT);
// `standard` only matters for SCH-DITA (XPath 2.0 vs 3.0).
export function ruleFormatRules(format, standard) {
  switch (format) {
    case 'BREX-4.2':
      return BREX_42;
    case 'BREX-4.1':
      return BREX_41;
    case 'BREX-3.0.1':
      return BREX_301;
    case 'SCH-DITA':
      return schDita(standard);
    default:
      throw new Error(`No rule format rules for "${format}".`);
  }
}
