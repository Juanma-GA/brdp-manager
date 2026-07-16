import { generateSingleRule as generateSingleRule42, loadSchemaSummary as loadSchemaSummary42 } from "./generateBREX.js";
import { generateSingleRule41, loadSchemaSummary41 } from "./generateBREX41.js";
import { generateSingleRule301, loadSchemaSummary301 } from "./generateBREX301.js";
import { generateSingleRule as generateSingleRuleDITA, loadSchemaSummary as loadSchemaSummaryDITA } from "./generateSchematronDITA.js";

// Normalizes the 5 generators' single-rule helpers -- each with its own
// signature and return shape (see CLAUDE.md) -- into one call returning a
// plain rule_xml string, for the BRDP Assistant's "Suggest Rule" mode
// (generates one rule for one BRDP, under human control, outside the mass
// chunking/verification/retry pipeline that Generate uses).
//
// SCH-S1000D reuses generateSingleRule301 as-is (the raw <objrule> fragment,
// NOT converted through brexToSchematron()): rule_approvals for that format
// are keyed 'SCH-S1000D' but store the same <objrule> shape as BREX-3.0.1 --
// see the approvalsFormat comment in generateBREX301.js. Conversion to
// <sch:pattern> happens once, over the whole assembled document, in
// generateBREXSch.js; converting a lone fragment here would produce a
// <sch:pattern> that generateBREX301's assembler can't splice back into a
// BREX <structrules> section.
export async function generateSuggestedRule(brdp, format, projectConfig, callLLM) {
  switch (format) {
    case "BREX-4.2": {
      const schemaSummary = await loadSchemaSummary42();
      const result = await generateSingleRule42(brdp, projectConfig, schemaSummary, callLLM);
      return result ? result.xml : null;
    }
    case "BREX-4.1": {
      const schemaSummary = await loadSchemaSummary41();
      const result = await generateSingleRule41(brdp, projectConfig, schemaSummary, callLLM);
      return result ? result.xml : null;
    }
    case "BREX-3.0.1":
    case "SCH-S1000D": {
      const schemaSummary = await loadSchemaSummary301();
      return await generateSingleRule301(brdp, projectConfig, schemaSummary, callLLM);
    }
    case "SCH-DITA": {
      const schemaSummary = await loadSchemaSummaryDITA();
      const result = await generateSingleRuleDITA(brdp, schemaSummary, callLLM);
      return result ? result.xml : null;
    }
    default:
      throw new Error(`Suggest Rule is not supported for format "${format}".`);
  }
}
