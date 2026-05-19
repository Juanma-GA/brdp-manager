import { sendMessageStream } from "./llmAPI.js";

let _schemaSummaryCache = null;

async function loadSchemaSummary() {
  if (_schemaSummaryCache) return _schemaSummaryCache;
  const res = await fetch("/brex-schema-summary-4-2.json?v=" + Date.now());
  if (!res.ok) throw new Error("Could not load brex-schema-summary-4-2.json");
  _schemaSummaryCache = await res.json();
  return _schemaSummaryCache;
}

export function buildBREXPrompt(validatedBRDPs, projectConfig, schemaSummary) {
  const { few_shot_examples, ...schemaSummaryWithoutExamples } = schemaSummary;
  const schemaJSON = JSON.stringify(schemaSummaryWithoutExamples, null, 2);

  const fewShotBlock = (schemaSummary.few_shot_examples || []).map((ex, i) => {
    const flag = ex.allowedObjectFlag;
    const labels = [];
    if (flag === "0") labels.push("prohibited");
    else if (flag === "1") labels.push("mandatory");
    else labels.push("no flag");
    if (ex.objectPath && ex.objectPath.includes("[")) labels.push("complex XPath");
    if (ex.objectValues && ex.objectValues.length > 1) labels.push("multi value");

    const objectValueLines = (ex.objectValues || [])
      .map(v => `  <objectValue valueForm="single" valueAllowed="${v}"/>`)
      .join("\n");

    const flagAttr = flag != null ? ` allowedObjectFlag="${flag}"` : "";

    return `### Example ${i + 1} — ${labels.join(", ")}
INPUT id: ${ex.id}
OUTPUT:
<structureObjectRule id="${ex.id}" brSeverityLevel="brsl01">
  <brDecisionRef brDecisionIdentNumber="${ex.id}"/>
  <objectPath${flagAttr}>${ex.objectPath}</objectPath>
  <objectUse>${ex.objectUse}</objectUse>
${objectValueLines}</structureObjectRule>`;
  }).join("\n\n");

  const system = `You are an S1000D Issue 4.2 expert. Generate a valid BREX Data Module XML.

Follow this schema structure exactly:
${schemaJSON}

STRICT RULES:
1. Output ONLY the XML — no markdown fences, no \`\`\`xml tags, no explanation, no preamble.
2. First character must be: <?xml version="1.0" encoding="UTF-8"?>
3. Use the exact dmodule opening tag from dmodule_opening_tag in the schema.
4. infoCode is always 022.
5. Structure: content > brex > contextRules > structureObjectRuleGroup > structureObjectRule
    There is NO brexDoc element. There is NO brexDmRules element.
    <brex> contains contextRules and/or nonContextRules directly.
6. contextRules has attribute rulesContext (use empty string: rulesContext="").
7. Each BRDP = one structureObjectRule inside contextRules > structureObjectRuleGroup.
8. Child order in structureObjectRule: brDecisionRef → objectPath → objectUse → objectValue.
9. brDecisionRef uses ATTRIBUTE: <brDecisionRef brDecisionIdentNumber="BRDP-001"/> — NOT text content.
10. allowedObjectFlag: "0"=prohibited, "1"=mandatory (must/shall/required), "2"=optional.
11. objectUse = one sentence summarising the decision.
12. Use the todayDate value provided in the user message for issueDate. Format: year="YYYY" month="MM" day="DD".
13. techName = project name; infoName = "Business Rules Exchange".
14. qualityAssurance: <qualityAssurance><unverified/></qualityAssurance>
15. applic: <applic><displayText><simplePara>All</simplePara></displayText></applic>

## Few-shot examples: BRDP id → structureObjectRule
Use these real validated examples as reference for structure, XPath patterns and objectValue formatting.

${fewShotBlock}`;

  const brdpLines = validatedBRDPs
    .map((b, i) =>
      `${i + 1}. ID: ${b.id}\n   Definition: ${b.definition}\n   Proposal: ${b.proposal}\n   Validation: ${b.validation}`
    )
    .join("\n\n");

  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  const user = `Generate a BREX Data Module XML with this project configuration:

modelIdentCode: ${projectConfig.modelIdentCode || "UNKNOWN"}
systemDiffCode: ${projectConfig.systemDiffCode || "A"}
issueNumber: ${projectConfig.issueNumber || "001"}
inWork: ${projectConfig.inWork || "00"}
languageIsoCode: ${projectConfig.languageIsoCode || "en"}
countryIsoCode: ${projectConfig.countryIsoCode || "US"}
securityClassification: ${projectConfig.securityClassification || "01"}
enterpriseCode: ${projectConfig.enterpriseCode || ""}
projectName: ${projectConfig.projectName || projectConfig.modelIdentCode || "Project"}
todayDate: ${todayStr}

Include these ${validatedBRDPs.length} BRDP rule(s):

${brdpLines}

Output ONLY the XML starting with <?xml`;

  return { system, user };
}

export function extractXML(rawResponse) {
  if (!rawResponse) return "";
  let text = rawResponse.trim();
  text = text.replace(/^```(?:xml)?\s*/i, "").replace(/\s*```\s*$/, "");
  const xmlStart = text.indexOf("<?xml");
  if (xmlStart > 0) text = text.slice(xmlStart);
  const lastClose = text.lastIndexOf(">");
  if (lastClose !== -1 && lastClose < text.length - 1) {
    text = text.slice(0, lastClose + 1);
  }
  return text.trim();
}

export function checkWellFormed(xmlString) {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlString, "application/xml");
    const parserError = doc.querySelector("parsererror");
    if (parserError) {
      const msg = parserError.textContent || "XML is not well-formed";
      const lineMatch = msg.match(/line[:\s]+(\d+)/i);
      const lineHint = lineMatch ? ` (line ${lineMatch[1]})` : "";
      return { valid: false, error: msg.split("\n")[0].trim() + lineHint };
    }
    return { valid: true, error: null };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

export function buildBREXPromptChunk(chunkBRDPs, projectConfig, schemaSummary) {
  const { few_shot_examples, ...schemaSummaryWithoutExamples } = schemaSummary;
  const schemaJSON = JSON.stringify(schemaSummaryWithoutExamples, null, 2);

  const fewShotBlock = (schemaSummary.few_shot_examples || []).map((ex, i) => {
    const flag = ex.allowedObjectFlag;
    const labels = [];
    if (flag === "0") labels.push("prohibited");
    else if (flag === "1") labels.push("mandatory");
    else labels.push("no flag");
    if (ex.objectPath && ex.objectPath.includes("[")) labels.push("complex XPath");
    if (ex.objectValues && ex.objectValues.length > 1) labels.push("multi value");
    const objectValueLines = (ex.objectValues || [])
      .map(v => `  <objectValue valueForm="single" valueAllowed="${v}"/>`)
      .join("\n");
    const flagAttr = flag != null ? ` allowedObjectFlag="${flag}"` : "";
    return `### Example ${i + 1} — ${labels.join(", ")}
INPUT id: ${ex.id}
OUTPUT:
<structureObjectRule id="${ex.id}" brSeverityLevel="brsl01">
  <brDecisionRef brDecisionIdentNumber="${ex.id}"/>
  <objectPath${flagAttr}>${ex.objectPath}</objectPath>
  <objectUse>${ex.objectUse}</objectUse>
${objectValueLines}</structureObjectRule>`;
  }).join("\n\n");

  const system = `You are an S1000D Issue 4.2 expert generating structureObjectRule elements for a BREX Data Module.

Follow this schema structure exactly:
${schemaJSON}

STRICT RULES:
1. Output ONLY raw structureObjectRule XML elements — no XML declaration, no dmodule wrapper, no markdown.
2. Each BRDP = one structureObjectRule element.
3. Child order in structureObjectRule: brDecisionRef → objectPath → objectUse → objectValue.
4. brDecisionRef uses ATTRIBUTE: <brDecisionRef brDecisionIdentNumber="BRDP-001"/> — NOT text content.
5. allowedObjectFlag: "0"=prohibited, "1"=mandatory, "2"=optional.
6. objectUse = one sentence summarising the decision.
7. Start output directly with <structureObjectRule — no preamble.

## Few-shot examples: BRDP id → structureObjectRule
${fewShotBlock}`;

  const brdpLines = chunkBRDPs
    .map((b, i) =>
      `${i + 1}. ID: ${b.id}\n   Definition: ${b.definition}\n   Proposal: ${b.proposal}\n   Validation: ${b.validation}`
    )
    .join("\n\n");

  const user = `Generate structureObjectRule elements for these ${chunkBRDPs.length} BRDPs:

${brdpLines}

Output ONLY the structureObjectRule elements, starting directly with <structureObjectRule`;

  return { system, user };
}

function escapeXMLContent(xml) {
  const escapeText = (content) => {
    const unescaped = content
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'");
    return unescaped
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  };

  // Escape text content of objectUse
  xml = xml.replace(/<objectUse>([\s\S]*?)<\/objectUse>/g,
    (_, c) => `<objectUse>${escapeText(c)}</objectUse>`);

  // Escape text content of objectPath (preserving attributes)
  xml = xml.replace(/(<objectPath[^>]*>)([\s\S]*?)(<\/objectPath>)/g,
    (_, open, c, close) => `${open}${escapeText(c)}${close}`);

  // Escape text content of objectValue valueAllowed attribute is already an attribute so skip
  // But escape any objectValue text content if present
  xml = xml.replace(/(<objectValue[^>]*>)([\s\S]*?)(<\/objectValue>)/g,
    (_, open, c, close) => `${open}${escapeText(c)}${close}`);

  return xml;
}

const XML_FOOTER = `
</structureObjectRuleGroup>
</contextRules>
</brex>
</content>
</dmodule>`;

function assembleChunks(baseXml, additionalRules) {
  // Extract only complete structureObjectRule elements from additional rules
  const completeRules = [];
  const rulePattern = /<structureObjectRule[\s\S]*?<\/structureObjectRule>/g;
  let match;
  while ((match = rulePattern.exec(additionalRules)) !== null) {
    completeRules.push(match[0]);
  }
  const cleaned = completeRules.join('\n');
  if (!cleaned.trim()) return baseXml;

  // Strip footer from baseXml (everything from </structureObjectRuleGroup> onwards)
  // to avoid duplicating or misplacing the closing tags
  const footerTags = ['</structureObjectRuleGroup>', '</contextRules>', '</brex>', '</content>', '</dmodule>'];
  let stripped = baseXml;
  for (const tag of footerTags) {
    const idx = stripped.lastIndexOf(tag);
    if (idx !== -1) {
      stripped = stripped.slice(0, idx);
    }
  }
  // Also strip any trailing whitespace/newlines after the last complete rule
  const lastRule = stripped.lastIndexOf('</structureObjectRule>');
  if (lastRule !== -1) {
    stripped = stripped.slice(0, lastRule + '</structureObjectRule>'.length);
  }

  return stripped + '\n' + cleaned + XML_FOOTER;
}

const CHUNK_SIZE = 25;

export async function generateBREX(brdps, projectConfig, options = {}) {
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

  const schemaSummary = await loadSchemaSummary();

  // Split into chunks
  const chunks = [];
  for (let i = 0; i < targetBRDPs.length; i += CHUNK_SIZE) {
    chunks.push(targetBRDPs.slice(i, i + CHUNK_SIZE));
  }

  const callLLM = async (system, user) => {
    const messages = [{ role: "user", content: user }];
    try {
      return await sendMessageStream(
        messages, apiKey, modelName, provider, system,
        onChunk, abortController, { customEndpoint, maxTokens: 8000 }
      );
    } catch (err) {
      throw new Error(`LLM call failed: ${err.message}`);
    }
  };

  // Chunk 1: full DM with first CHUNK_SIZE BRDPs
  const { system: sys1, user: usr1 } = buildBREXPrompt(chunks[0], projectConfig, schemaSummary);
  const raw1 = await callLLM(sys1, usr1);
  let finalXml = escapeXMLContent(extractXML(raw1));
  if (!finalXml) throw new Error("The model returned an empty response on chunk 1.");

  // Chunks 2..N: rules only
  for (let i = 1; i < chunks.length; i++) {
    const { system: sysN, user: usrN } = buildBREXPromptChunk(chunks[i], projectConfig, schemaSummary);
    const rawN = await callLLM(sysN, usrN);
    if (rawN && rawN.trim()) {
      const cleanedRawN = escapeXMLContent(rawN.trim());
      finalXml = assembleChunks(finalXml, '\n' + cleanedRawN);
    }
  }

  // Ensure XML footer is present (in case of single chunk or truncation)
  if (!finalXml.includes('</dmodule>')) {
    const lastRule = finalXml.lastIndexOf('</structureObjectRule>');
    if (lastRule !== -1) {
      finalXml = finalXml.slice(0, lastRule + '</structureObjectRule>'.length) + XML_FOOTER;
    }
  }

  const { valid, error } = checkWellFormed(finalXml);
  return { xml: finalXml, valid, error, brdpCount: targetBRDPs.length };
}
