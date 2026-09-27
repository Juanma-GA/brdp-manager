// Per-format rules for writing ONE general rule (docs request, Suggest
// Rule round). The knowledge comes from the STRICT RULES of Generate's
// generators -- buildBREXPromptChunk (generateBREX.js, 4.2),
// buildBREXPromptChunk41 (generateBREX41.js), buildBREXPromptChunk301
// (generateBREX301.js) and STRICT_RULES (generateSchematronDITA.js) --
// narrowed to what one general rule needs: no chunking/assembly
// instructions, no id-suffix splitting across several rules, and no
// "can't be generated" fallback (a nonContextRule / traceability comment),
// which Suggest Rule replaces with its own NOT_CHECKABLE answer
// (suggestRulePrompt.js). The generators still carry their own copies;
// they switch to this module in the final sweep that removes the dead
// generateSuggestedRule.js/useChat.js/ChatPanel.jsx chain.
import { queryBindingForStandard } from '../api/generateSchematronDITA.js';

const BREX_42 = `FORMAT — S1000D Issue 4.2 BREX: exactly ONE <structureObjectRule> element.
1. Output exactly one <structureObjectRule id="{ID}" brSeverityLevel="brsl01"> — never a <contextRules> wrapper, a <nonContextRule>, or a dmodule wrapper. {ID} is the BRDP's ID.
2. Child order: <brDecisionRef brDecisionIdentNumber="{ID}"/> → <objectPath> → <objectUse> → <objectValue> (zero or more). brDecisionRef carries the ID as an ATTRIBUTE, never as text.
3. Exactly ONE <objectPath>. Its only attribute is allowedObjectFlag: "0" = the selected nodes are prohibited, "1" = mandatory, "2" = optional. No other attribute on objectPath.
4. <objectUse> = one sentence stating the decision. Inside it, write element names as &lt;elementName&gt;, never a raw tag.
5. <objectValue> only when the Proposal lists the values allowed for the node objectPath selects: one per value, with ONLY the attributes valueAllowed and valueForm; valueForm is "single", "range" or "pattern" — never list, regex, conditional or multiple.
6. Inside objectPath, a literal < or & must be escaped as &lt; / &amp;.`;

const BREX_41 = `FORMAT — S1000D Issue 4.1 BREX: exactly ONE <structureObjectRule> element.
1. Output exactly one <structureObjectRule id="{ID}"> — never a <contextRules> wrapper, a <nonContextRule>, or a dmodule wrapper. {ID} is the BRDP's ID.
2. Child order: <objectPath> → <objectUse> → <objectValue> (zero or more). There is NO brDecisionRef element and NO brSeverityLevel attribute in S1000D 4.1.
3. Exactly ONE <objectPath>. Its only attribute is allowedObjectFlag: "0" = the selected nodes are prohibited, "1" = mandatory, "2" = optional. No other attribute on objectPath.
4. <objectUse> = one sentence stating the decision. Inside it, write element names as &lt;elementName&gt;, never a raw tag.
5. <objectValue> only when the Proposal lists the values allowed for the node objectPath selects: one per value, with ONLY the attributes valueAllowed and valueForm; valueForm is "single", "range" or "pattern" — never list, regex, conditional or multiple.
6. Inside objectPath, a literal < or & must be escaped as &lt; / &amp;.`;

const BREX_301 = `FORMAT — S1000D Issue 3.0.1 BREX: exactly ONE <objrule> element.
1. Output exactly one <objrule id="{ID}"> — never a dmodule wrapper. {ID} is the BRDP's ID. There is NO brDecisionRef in 3.0.1.
2. Child order: <objpath> → <objuse> → <objval> (one per allowed value, zero or more).
3. Exactly ONE <objpath>. Its only attribute is objappl: "0" = the selected nodes are prohibited, "1" = mandatory. NO other values (there is no "optional" in 3.0.1).
4. <objuse> = one sentence stating the decision. Inside it, escape &lt; &gt; &amp;.
5. <objval> only when the Proposal lists the values allowed for the node objpath selects, with ONLY the attributes val1, val2 and valtype; valtype is "single" or "range" (val2 only for "range") — never pattern, list, regex, conditional or multiple.
6. Inside objpath, a literal < or & must be escaped as &lt; / &amp;.`;

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
4. Absolute prohibition of an element with no exceptions -> context targets the forbidden element itself, test="false()".
5. Closed list of permitted values -> test="@attr = ('v1','v2','v3')". Never a regex for a short closed list.
6. Attribute format constraint -> matches(@attr, '^...$', 'i'), anchored, applied to the attribute that ACTUALLY carries that data.
7. Nesting-depth limit -> count(ancestor::element-name) compared with a relational operator. Never nested positional predicates.
8. sch:assert fires its message when test is FALSE (phrase test as what MUST be true); sch:report fires when test is TRUE (what must NOT happen). Never invert the polarity.
9. role="error" for absolute prohibitions/mandates ("must", "shall not", "is required"); role="warning" for recommendations ("should", "recommend", "consider").
10. Inside sch:assert/sch:report message text, write element names as &lt;elementName&gt;. Inside test, context and sch:let/@value, a literal < or & must be escaped as &lt; / &amp; (count(...) &lt; 2, never a raw <).
11. Never write a vacuous test (e.g. two nearly identical expressions compared with each other) — if the only way to "check" the decision is vacuous, the decision is not checkable.
12. Row-by-row check across columns of a DITA/CALS table -> resolve each column by its header TEXT with <sch:let name="colX" value="tgroup/thead/row[1]/entry[normalize-space(.) = 'Header Text']/@colname"/> placed before the checks, and express "for every row" with "every $row in tgroup/tbody/row satisfies (...)" — never by column position.`;
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
