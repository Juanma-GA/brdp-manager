import { generateSingleRule as generateSingleRule42, loadSchemaSummary as loadSchemaSummary42 } from "./generateBREX.js";
import { generateSingleRule41, loadSchemaSummary41 } from "./generateBREX41.js";
import { generateSingleRule301, loadSchemaSummary301 } from "./generateBREX301.js";
import { generateSingleRule as generateSingleRuleDITA, loadSchemaSummary as loadSchemaSummaryDITA } from "./generateSchematronDITA.js";

// Normalizes the 4 generators' single-rule helpers -- each with its own
// signature and return shape (see CLAUDE.md) -- into one call returning a
// plain rule_xml string, for the BRDP Assistant's "Suggest Rule" mode
// (generates one rule for one BRDP, under human control, outside the mass
// chunking/verification/retry pipeline that Generate uses).
//
// A project's rule_approvals live under its BREX format id
// (BREX-4.2/BREX-4.1/BREX-3.0.1) regardless of whether the Generate page's
// output selector is set to BREX or Schematron -- a single approved rule
// set feeds both outputs (docs request), and conversion to <sch:pattern>
// only ever happens once, over the whole assembled document, in
// generateBREXSch.js -- so this helper never needs to know or care which
// output kind the caller will eventually pick.
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
    case "BREX-3.0.1": {
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
