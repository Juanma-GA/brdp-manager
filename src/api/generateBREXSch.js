import { sendMessageStream } from "./llmAPI.js";
import { extractXML, checkWellFormed } from "./generateBREX.js";

let _schemaSummaryCacheSch = null;

async function loadSchemaSummarySch() {
  if (_schemaSummaryCacheSch) return _schemaSummaryCacheSch;
  const res = await fetch("/brex-schema-summary-sch.json?v=" + Date.now());
  if (!res.ok) throw new Error("Failed to load brex-schema-summary-sch.json");
  _schemaSummaryCacheSch = await res.json();
  return _schemaSummaryCacheSch;
}

export function buildBREXPromptSch(validatedBRDPs, projectConfig, schemaSummary) {
  const { few_shot_examples, ...schemaSummaryWithoutExamples } = schemaSummary;
  const schemaJSON = JSON.stringify(schemaSummaryWithoutExamples, null, 2);

  const fewShotBlock = (schemaSummary.few_shot_examples || []).map((ex, i) => {
    const labels = [];
    if (ex.assert_test === "false()") labels.push("prohibited");
    else if (ex.assert_test.includes("exists(")) labels.push("allowed values");
    else labels.push("mandatory");
    if (ex.rule_context.includes("[")) labels.push("complex XPath");

    return `### Example ${i + 1} — ${labels.join(", ")}
INPUT id: ${ex.id}
OUTPUT:
<!-- ${ex.id} -->
<sch:pattern id="${ex.pattern_id}">
  <sch:rule context="${ex.rule_context}">
    <sch:assert id="${ex.id}" role="error" test="${ex.assert_test}">${ex.assert_message}</sch:assert>
  </sch:rule>
</sch:pattern>`;
  }).join("\n\n");

  const system = `You are a Schematron 1.0 (ISO/IEC 19757-3) expert. Generate a valid Schematron XML validation schema.

Follow this schema structure exactly:
${schemaJSON}

STRICT RULES:
1. Output ONLY the Schematron XML — no markdown fences, no explanation, no preamble.
2. First line must be: <?xml version='1.0' encoding='UTF-8'?>
3. Open with exactly the file_header from the schema. Close with file_footer.
4. Each BRDP = one sch:pattern block.
5. pattern id must be lowercase: brdp-a1-NNNNN
6. assert id must be uppercase: BRDP-A1-NNNNN
7. Each sch:pattern contains exactly one sch:rule and one sch:assert.
8. For prohibited rules (flag=0 in BREX): full XPath condition goes in sch:rule @context, test is always false()
9. For allowed values rules: element or attribute goes in @context, test is an exists() OR chain: exists(node[(string(.) = 'val1') or (string(.) = 'val2')])
10. assert message = the objectUse text of the BRDP.
11. role is always "error".
12. Do not include any DM identification header — output is sch:schema wrapper with patterns only.

## Few-shot examples: BRDP id → sch:pattern
Use these real validated examples as reference for structure, XPath patterns and assertion formatting.

${fewShotBlock}`;

  const brdpLines = validatedBRDPs
    .map((b, i) =>
      `${i + 1}. ID: ${b.id}\n   Definition: ${b.definition}\n   Proposal: ${b.proposal}\n   Validation: ${b.validation}`
    )
    .join("\n\n");

  const user = `Generate a Schematron 1.0 validation schema with this project configuration:

modelIdentCode: ${projectConfig.modelIdentCode || "UNKNOWN"}
projectName: ${projectConfig.projectName || projectConfig.modelIdentCode || "Project"}

Include these ${validatedBRDPs.length} BRDP rule(s):

${brdpLines}

Output ONLY the XML starting with <?xml`;

  return { system, user };
}

export async function generateBREXSch(brdps, projectConfig, options = {}) {
  const {
    apiKey,
    modelName,
    provider = "Anthropic",
    customEndpoint = "",
    onlyValidated = true,
    onChunk,
    abortController,
  } = options;

  if (!apiKey) throw new Error("API key is required. Please configure it in Settings.");
  if (!projectConfig?.modelIdentCode) {
    throw new Error("Project configuration is incomplete. Please fill in Settings.");
  }

  const targetBRDPs = onlyValidated
    ? brdps.filter((b) => b.validation?.toLowerCase().trim() === "validated")
    : brdps;

  if (targetBRDPs.length === 0) {
    throw new Error(
      onlyValidated
        ? "No validated BRDPs found. Validate at least one BRDP before generating."
        : "No BRDPs available to generate from."
    );
  }

  const schemaSummary = await loadSchemaSummarySch();
  const { system, user } = buildBREXPromptSch(targetBRDPs, projectConfig, schemaSummary);
  const messages = [{ role: "user", content: user }];

  let rawResponse;
  try {
    rawResponse = await sendMessageStream(
      messages,
      apiKey,
      modelName,
      provider,
      system,
      onChunk,
      abortController,
      {
        customEndpoint,
      }
    );
  } catch (err) {
    throw new Error(`LLM call failed: ${err.message}`);
  }

  const xml = extractXML(rawResponse);
  if (!xml) throw new Error("The model returned an empty response. Check your API key and model settings.");

  const { valid, error } = checkWellFormed(xml);
  return { xml, valid, error, brdpCount: targetBRDPs.length };
}
