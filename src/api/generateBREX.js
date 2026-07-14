import { sendMessageStream } from "./llmAPI.js";
import { getApprovalsForFormat } from "./approvals.js";

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
16. Each structureObjectRule must contain EXACTLY ONE objectPath element. If a BRDP requires multiple XPath expressions, generate multiple separate structureObjectRule elements each with the same brDecisionRef, but with UNIQUE id attributes: use suffix -b, -c, -d for the additional rules (e.g. id="BRDP-S1-00093-b", id="BRDP-S1-00093-c"). The first rule keeps the original id. NEVER repeat the same id value in more than one structureObjectRule. This also applies when multiple objectPath elements share the same allowedObjectFlag value — each objectPath must still be in its own separate structureObjectRule with a unique id.
17. objectValue ONLY allows two attributes: valueAllowed and valueForm. valueForm MUST be one of: single, range, pattern. NEVER use list, regex, conditional, multiple or any other value. NEVER add a condition attribute or any other attribute to objectValue.
18. If a BRDP has no clear XPath target (procedural rules, references to external standards, general policies), place it in nonContextRules — NOT in structureObjectRule. nonContextRules is a sibling of contextRules, directly inside <brex>. The exact structure is:
<nonContextRules>
  <nonContextRule id="BRDP-xxx" brSeverityLevel="brsl01">
    <brDecisionRef brDecisionIdentNumber="BRDP-xxx"/>
    <simplePara>One sentence describing the rule.</simplePara>
  </nonContextRule>
</nonContextRules>
NEVER put nonContextRule inside structureObjectRule. NEVER generate a structureObjectRule without objectPath.
19. The id attribute of structureObjectRule must be globally unique across the entire document. NEVER use the same id value twice. If you split a BRDP into multiple structureObjectRule elements, only the first keeps the BRDP id. Additional rules use BRDP-id-b, BRDP-id-c, etc.
20. NEVER invent attributes not in the schema. objectPath only allows allowedObjectFlag (values: 0, 1, 2) — no other attributes allowed on objectPath. Inside <simplePara> text, NEVER use raw XML tags: escape element names as &lt;elementName&gt; instead of <elementName>.
21. dmStatus issueType attribute: use issueType="new" (this is always a newly generated document). If used at all, valid values are only: new, changed, deleted, revised, status, rinstate-changed, rinstate-revised, rinstate-status.

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
8. Each structureObjectRule must contain EXACTLY ONE objectPath element. If a BRDP requires multiple XPath expressions, generate multiple separate structureObjectRule elements each with the same brDecisionRef, but with UNIQUE id attributes: use suffix -b, -c, -d for the additional rules (e.g. id="BRDP-S1-00093-b", id="BRDP-S1-00093-c"). The first rule keeps the original id. NEVER repeat the same id value in more than one structureObjectRule. This also applies when multiple objectPath elements share the same allowedObjectFlag value — each objectPath must still be in its own separate structureObjectRule with a unique id.
9. objectValue ONLY allows two attributes: valueAllowed and valueForm. valueForm MUST be one of: single, range, pattern. NEVER use list, regex, conditional, multiple or any other value. NEVER add a condition attribute or any other attribute to objectValue.
10. If a BRDP has no clear XPath target (procedural rules, references to external standards, general policies), output it as a nonContextRule — NOT as a structureObjectRule. The exact structure to output is:
<nonContextRule id="BRDP-xxx" brSeverityLevel="brsl01">
  <brDecisionRef brDecisionIdentNumber="BRDP-xxx"/>
  <simplePara>One sentence describing the rule.</simplePara>
</nonContextRule>
assembleChunks() will place it correctly inside <nonContextRules>.
NEVER put nonContextRule inside structureObjectRule. NEVER generate a structureObjectRule without objectPath.
11. The id attribute of structureObjectRule must be globally unique across the entire document. NEVER use the same id value twice. If you split a BRDP into multiple structureObjectRule elements, only the first keeps the BRDP id. Additional rules use BRDP-id-b, BRDP-id-c, etc.
12. NEVER invent attributes not in the schema. objectPath only allows allowedObjectFlag (values: 0, 1, 2) — no other attributes allowed on objectPath. Inside <simplePara> text, NEVER use raw XML tags: escape element names as &lt;elementName&gt; instead of <elementName>.

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

  // Escape text content of simplePara
  xml = xml.replace(/<simplePara>([\s\S]*?)<\/simplePara>/g,
    (_, c) => `<simplePara>${escapeText(c)}</simplePara>`);

  return xml;
}

function splitMultipleObjectPaths(xml) {
  const original = xml;
  const rulePattern = /<structureObjectRule[\s\S]*?<\/structureObjectRule>/g;

  const rules = [];
  let match;
  while ((match = rulePattern.exec(original)) !== null) {
    rules.push({ full: match[0], start: match.index, end: match.index + match[0].length });
  }

  const replacements = [];
  for (const rule of rules) {
    const paths = [...rule.full.matchAll(/<objectPath[^>]*>[\s\S]*?<\/objectPath>/g)];
    if (paths.length <= 1) continue;

    const idMatch = rule.full.match(/id="([^"]+)"/);
    const severityMatch = rule.full.match(/brSeverityLevel="([^"]+)"/);
    const brDecisionMatch = rule.full.match(/<brDecisionRef[^>]*\/>/);
    const objectUseMatch = rule.full.match(/<objectUse>[\s\S]*?<\/objectUse>/);
    const objectValueMatch = rule.full.match(/<objectValue[^>]*\/>/);

    if (!idMatch || !brDecisionMatch) continue;

    const baseId = idMatch[1];
    const severity = severityMatch ? severityMatch[1] : 'brsl01';
    const brDecision = brDecisionMatch[0];
    const objectUse = objectUseMatch ? objectUseMatch[0] : '';
    const objectValue = objectValueMatch ? objectValueMatch[0] : '';
    const suffixes = ['', '-b', '-c', '-d', '-e'];

    const newRules = paths.map((path, i) => {
      const newId = baseId + (suffixes[i] || `-${i}`);
      const lines = [
        `<structureObjectRule id="${newId}" brSeverityLevel="${severity}">`,
        `  ${brDecision}`,
        `  ${path[0]}`,
      ];
      if (objectUse) lines.push(`  ${objectUse}`);
      if (objectValue) lines.push(`  ${objectValue}`);
      lines.push(`</structureObjectRule>`);
      return lines.join('\n');
    }).join('\n');

    replacements.push({ start: rule.start, end: rule.end, replacement: newRules });
  }

  // Aplicar replacements de atrás hacia adelante para no desplazar índices
  let result = original;
  for (let i = replacements.length - 1; i >= 0; i--) {
    const { start, end, replacement } = replacements[i];
    result = result.slice(0, start) + replacement + result.slice(end);
  }

  return result;
}

const XML_FOOTER = `
</structureObjectRuleGroup>
</contextRules>
</brex>
</content>
</dmodule>`;

function assembleChunks(baseXml, additionalRules) {
  // Extraer structureObjectRule (igual que antes)
  const structureRules = [];
  const rulePattern = /<structureObjectRule[\s\S]*?<\/structureObjectRule>/g;
  let match;
  while ((match = rulePattern.exec(additionalRules)) !== null) {
    structureRules.push(match[0]);
  }

  // Extraer nonContextRule sueltos de los chunks
  const nonContextRules = [];
  const nonContextPattern = /<nonContextRule[\s\S]*?<\/nonContextRule>/g;
  while ((match = nonContextPattern.exec(additionalRules)) !== null) {
    nonContextRules.push(match[0]);
  }

  const cleanedStructure = structureRules.join('\n');
  const cleanedNonContext = nonContextRules.join('\n');

  if (!cleanedStructure.trim() && !cleanedNonContext.trim()) return baseXml;

  // Strip footer del baseXml (igual que antes)
  const footerTags = ['</structureObjectRuleGroup>', '</contextRules>', '</nonContextRules>', '</brex>', '</content>', '</dmodule>'];
  let stripped = baseXml;
  for (const tag of footerTags) {
    const idx = stripped.lastIndexOf(tag);
    if (idx !== -1) {
      stripped = stripped.slice(0, idx);
    }
  }
  const lastStructure = stripped.lastIndexOf('</structureObjectRule>');
  const lastNonContext = stripped.lastIndexOf('</nonContextRule>');
  const lastAny = Math.max(lastStructure, lastNonContext);
  if (lastAny !== -1) {
    const endTag = lastStructure >= lastNonContext
      ? '</structureObjectRule>'
      : '</nonContextRule>';
    stripped = stripped.slice(0, lastAny + endTag.length);
  }

  // Construir el bloque nonContextRules si hay reglas sin contexto
  let nonContextBlock = '';
  if (cleanedNonContext.trim()) {
    // Recopilar TODOS los ids ya presentes en el documento (safety net global)
    const globalIds = new Set();
    const globalIdPattern = /\bid="([^"]+)"/g;
    let gMatch;
    while ((gMatch = globalIdPattern.exec(stripped)) !== null) {
      globalIds.add(gMatch[1]);
    }

    // Verificar si baseXml ya tiene <nonContextRules> del chunk 1
    const hasExisting = baseXml.includes('<nonContextRules>');
    if (hasExisting) {
      // Extraer las que ya hay en baseXml y combinar
      const existingMatch = baseXml.match(/<nonContextRules>([\s\S]*?)<\/nonContextRules>/);
      const existingContent = existingMatch ? existingMatch[1] : '';

      // Filtrar nonContextRule duplicados contra ids globales
      const deduped = (cleanedNonContext.match(/<nonContextRule[\s\S]*?<\/nonContextRule>/g) || [])
        .filter(rule => {
          const m = rule.match(/\bid="([^"]+)"/);
          return m ? !globalIds.has(m[1]) : true;
        })
        .join('\n');

      nonContextBlock = `\n<nonContextRules>\n${existingContent}${deduped.trim() ? '\n' + deduped : ''}\n</nonContextRules>`;
    } else {
      // Filtrar cleanedNonContext contra ids globales incluso sin existing block
      const deduped = (cleanedNonContext.match(/<nonContextRule[\s\S]*?<\/nonContextRule>/g) || [])
        .filter(rule => {
          const m = rule.match(/\bid="([^"]+)"/);
          return m ? !globalIds.has(m[1]) : true;
        })
        .join('\n');
      nonContextBlock = deduped.trim() ? `\n<nonContextRules>\n${deduped}\n</nonContextRules>` : '';
    }
  } else if (baseXml.includes('<nonContextRules>')) {
    // chunk 1 generó nonContextRules pero chunks adicionales no tienen más — preservar
    const existingMatch = baseXml.match(/<nonContextRules>([\s\S]*?)<\/nonContextRules>/);
    nonContextBlock = existingMatch ? `\n${existingMatch[0]}` : '';
  }

  // Ensamblar footer correcto
  const footer = `\n</structureObjectRuleGroup>\n</contextRules>${nonContextBlock}\n</brex>\n</content>\n</dmodule>`;

  return stripped + '\n' + (cleanedStructure || '') + footer;
}

const CHUNK_SIZE = 10;
const MAX_RETRIES = 2;

function verifyChunkRules(rawResponse, expectedIds) {
  const foundIds = new Set([
    ...[...rawResponse.matchAll(/<structureObjectRule id="([^"]+)"/g)].map(m => m[1]),
    ...[...rawResponse.matchAll(/<nonContextRule id="([^"]+)"/g)].map(m => m[1])
  ]);
  const validExpected = new Set(expectedIds);
  const missing = expectedIds.filter(id => !foundIds.has(id));
  const invented = [...foundIds].filter(id => !validExpected.has(id));
  return { missing, invented };
}

// Batch-fetches every frozen approval for the given format in one request
// (GET /api/approvals/format/:format) instead of one call per BRDP. Same
// safe-degrade philosophy as generateBREX301.js's fetchApprovalsMap301: a
// fetch failure falls back to "no approvals" instead of aborting generation
// -- affected BRDPs simply go through the normal LLM/safety-net path, so
// coverage is never at risk, only the deterministic-injection optimization
// for that run.
async function fetchApprovalsMap(format) {
  try {
    const rows = await getApprovalsForFormat(format);
    return new Map(rows.map((r) => [r.brdp_id, r]));
  } catch (err) {
    console.error(`Failed to fetch rule approvals for format ${format}:`, err);
    return new Map();
  }
}

async function generateSingleRule(brdp, projectConfig, schemaSummary, callLLM) {
  const { system, user } = buildBREXPromptChunk([brdp], projectConfig, schemaSummary);
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const raw = await callLLM(system, user);
    if (!raw) continue;
    const escaped = raw.trim()
      .replace(/\s+allowedObjectFlagContext="[^"]*"/g, '')
      .replace(/<brDecisionIdentNumber brDecisionIdentNumber="([^"]+)"\/>/g, '<brDecisionRef brDecisionIdentNumber="$1"/>');
    const escapedContent = escapeXMLContent(escaped);
    const splitContent = splitMultipleObjectPaths(escapedContent);

    // Intentar structureObjectRule primero
    const ruleMatch = splitContent.match(/<structureObjectRule[\s\S]*?<\/structureObjectRule>/);
    if (ruleMatch) {
      const idMatch = ruleMatch[0].match(/structureObjectRule id="([^"]+)"/);
      if (idMatch && idMatch[1] === brdp.id) {
        return { type: 'structure', xml: ruleMatch[0] };
      }
    }

    // Aceptar nonContextRule si el LLM decide que no hay XPath claro
    const nonContextMatch = splitContent.match(/<nonContextRule[\s\S]*?<\/nonContextRule>/);
    if (nonContextMatch) {
      const idMatch = nonContextMatch[0].match(/nonContextRule id="([^"]+)"/);
      if (idMatch && idMatch[1] === brdp.id) {
        return { type: 'nonContext', xml: nonContextMatch[0] };
      }
    }
  }
  console.warn(`Could not generate rule for ${brdp.id} after ${MAX_RETRIES} attempts`);
  return null;
}

// ===== Finalización determinista del documento (S1000D 4.2) =====

function forceDmoduleTag(xml, dmoduleOpeningTag) {
  if (!dmoduleOpeningTag) return xml;
  return xml.replace(/<dmodule\b[^>]*>/, dmoduleOpeningTag);
}

function forceIssueType(xml) {
  // issueType es metadato boilerplate de cabecera (no depende del proyecto ni
  // de los BRDPs) y este generador SIEMPRE produce un documento nuevo, así que
  // se fuerza determinísticamente a "new" -- no se deja al LLM ningún margen
  // de decisión aquí. La STRICT RULE del prompt es solo una guía suave para
  // reducir ruido; la garantía real de corrección viene de esta función.
  return xml.replace(/<dmStatus\b([^>]*)>/, (full, attrs) => {
    const newAttrs = /\bissueType="[^"]*"/.test(attrs)
      ? attrs.replace(/\bissueType="[^"]*"/, 'issueType="new"')
      : `${attrs} issueType="new"`;
    return `<dmStatus${newAttrs}>`;
  });
}

function fixFlagPlacement(xml) {
  // mueve allowedObjectFlag de structureObjectRule (inválido) a su objectPath
  return xml.replace(/<structureObjectRule\b[^>]*>[\s\S]*?<\/structureObjectRule>/g, (rule) => {
    const om = rule.match(/<structureObjectRule\b([^>]*)>/);
    if (!om) return rule;
    const fm = om[1].match(/\sallowedObjectFlag="([012])"/);
    if (!fm) return rule;
    const flag = fm[1];
    let fixed = rule.replace(/(<structureObjectRule\b[^>]*?)\sallowedObjectFlag="[012]"([^>]*>)/, '$1$2');
    let injected = false;
    fixed = fixed.replace(/<objectPath\b([^>]*)>/, (pm, pa) => {
      if (injected) return pm;
      injected = true;
      if (/allowedObjectFlag=/.test(pa)) return pm;
      return `<objectPath allowedObjectFlag="${flag}"${pa}>`;
    });
    return fixed;
  });
}

function promoteOrphanSplitRules(xml) {
  const ids = new Set([...xml.matchAll(/<structureObjectRule id="([^"]+)"/g)].map(m => m[1]));
  const promoted = new Set();
  return xml.replace(/<structureObjectRule id="([^"]+)"/g, (full, id) => {
    const m = id.match(/^(.*)-([bcde])$/);
    if (!m) return full;
    const base = m[1];
    if (ids.has(base) || promoted.has(base)) return full;
    promoted.add(base);
    return `<structureObjectRule id="${base}"`;
  });
}

function dedupeNonContextRules(xml) {
  const seen = new Set();
  return xml.replace(/<nonContextRule\b[^>]*id="([^"]+)"[\s\S]*?<\/nonContextRule>/g, (full, id) => {
    if (seen.has(id)) return '';
    seen.add(id);
    return full;
  });
}

function resolveDmCodeFields(projectConfig) {
  const cfg = projectConfig || {};
  const up = v => (typeof v === 'string' ? v.toUpperCase() : v);
  const useIfValid = (v, p, d) => { const u = up(v); return (typeof u === 'string' && p.test(u)) ? u : d; };
  const mic = up(cfg.modelIdentCode);
  return {
    modelIdentCode: (typeof mic === 'string' && /^[A-Z0-9]{2,14}$/.test(mic)) ? mic : (mic || 'UNKNOWN'),
    systemDiffCode: useIfValid(cfg.systemDiffCode, /^[A-Z0-9]{1,4}$/, 'A'),
    systemCode: '00',
    subSystemCode: '0',
    subSubSystemCode: '0',
    assyCode: '00',
    disassyCode: '00',
    disassyCodeVariant: '0A',
    infoCode: '022',
    infoCodeVariant: 'A',
    itemLocationCode: 'D',
  };
}

function forceDmCodeFields(xml, fields) {
  return xml.replace(/<dmCode\b[^>]*?\/?>/g, (tag) => {
    let t = tag;
    for (const [a, val] of Object.entries(fields)) {
      const re = new RegExp('\\s' + a + '="[^"]*"');
      if (re.test(t)) t = t.replace(re, ' ' + a + '="' + val + '"');
      else t = t.replace(/\s*\/?>$/, m => ' ' + a + '="' + val + '"' + m);
    }
    return t;
  });
}

function dropRedundantNonContextRules(xml) {
  // Si un BRDP ya existe como structureObjectRule (ejecutable), elimina su nonContextRule
  // redundante para no duplicar el id xs:ID. Gana la regla ejecutable.
  const sorBase = new Set(
    [...xml.matchAll(/<structureObjectRule id="([^"]+)"/g)].map(m => m[1].replace(/-[bcde]$/, ''))
  );
  return xml.replace(/<nonContextRule\b[^>]*id="([^"]+)"[\s\S]*?<\/nonContextRule>/g, (full, id) => {
    return sorBase.has(id.replace(/-[bcde]$/, '')) ? '' : full;
  });
}

function finalizeDocument(xml, projectConfig, schemaSummary) {
  xml = forceDmoduleTag(xml, schemaSummary && schemaSummary.dmodule_opening_tag);
  xml = forceIssueType(xml);
  xml = fixFlagPlacement(xml);
  xml = promoteOrphanSplitRules(xml);
  xml = forceDmCodeFields(xml, resolveDmCodeFields(projectConfig));
  xml = dropRedundantNonContextRules(xml);
  xml = dedupeNonContextRules(xml);
  return xml;
}

export async function generateBREX(brdps, projectConfig, options = {}) {
  const {
    apiKey,
    modelName,
    provider = "Anthropic",
    customEndpoint = "",
    onlyValidated = true,
    onChunk,
    abortController,
    approvals: approvalsOverride,
    approvalsFormat,
    schemaSummary: schemaSummaryOverride,
    callLLM: callLLMOverride,
  } = options;

  if (!callLLMOverride && !apiKey) {
    throw new Error("API key is required. Please configure it in Settings.");
  }
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

  const schemaSummary = schemaSummaryOverride || (await loadSchemaSummary());

  // A BRDP with a frozen approval for approvalsFormat (see src/api/approvals.js
  // and CLAUDE.md's rule_approvals design) is injected verbatim and never
  // sent to the LLM. approvalsFormat is caller-supplied, not hardcoded, so
  // GenerateModal.jsx's direct "BREX -- S1000D 4.2" call site controls its
  // own approvals key ('BREX-4.2') explicitly -- omitting it skips the fetch
  // entirely, so existing callers are unaffected until they opt in.
  const approvalById = approvalsOverride
    ? (approvalsOverride instanceof Map ? approvalsOverride : new Map(approvalsOverride.map((a) => [a.brdp_id, a])))
    : (approvalsFormat ? await fetchApprovalsMap(approvalsFormat) : new Map());

  const approvedBRDPs = [];
  const llmBRDPs = [];
  for (const brdp of targetBRDPs) {
    if (approvalById.has(brdp.id)) approvedBRDPs.push(brdp);
    else llmBRDPs.push(brdp);
  }

  // Scoped to llmBRDPs (not targetBRDPs): if the LLM ever echoes an approved
  // BRDP's id anyway (it was never given that BRDP in any prompt), it must be
  // treated as invented and stripped -- otherwise it would duplicate the
  // rule injected separately below for the same id.
  const validSet = new Set(llmBRDPs.map(b => b.id));

  const callLLM =
    callLLMOverride ||
    (async (system, user) => {
      const messages = [{ role: "user", content: user }];
      try {
        return await sendMessageStream(
          messages, apiKey, modelName, provider, system,
          onChunk, abortController, { customEndpoint, maxTokens: 8000 }
        );
      } catch (err) {
        throw new Error(`LLM call failed: ${err.message}`);
      }
    });

  const removeInvented = (xml) =>
    xml.replace(/<structureObjectRule[\s\S]*?<\/structureObjectRule>/g, (match) => {
      const idMatch = match.match(/structureObjectRule id="([^"]+)"/);
      return (idMatch && validSet.has(idMatch[1])) ? match : '';
    });

  // Split into chunks of CHUNK_SIZE
  const chunks = [];
  for (let i = 0; i < llmBRDPs.length; i += CHUNK_SIZE) {
    chunks.push(llmBRDPs.slice(i, i + CHUNK_SIZE));
  }
  // Every BRDP may have a frozen approval and none need the LLM -- chunk 1 is
  // still generated (header-only, zero rules) since it's the only path that
  // produces the document skeleton; approved rules are injected afterward.
  if (chunks.length === 0) chunks.push([]);

  // Chunk 1: full DM
  const { system: sys1, user: usr1 } = buildBREXPrompt(chunks[0], projectConfig, schemaSummary);
  const raw1 = await callLLM(sys1, usr1);
  let finalXml = extractXML(raw1);
  finalXml = finalXml.replace(/\s+allowedObjectFlagContext="[^"]*"/g, '');
  finalXml = finalXml.replace(/<brDecisionIdentNumber brDecisionIdentNumber="([^"]+)"\/>/g, '<brDecisionRef brDecisionIdentNumber="$1"/>');
  finalXml = escapeXMLContent(finalXml);
  finalXml = splitMultipleObjectPaths(finalXml);
  if (!finalXml) throw new Error("The model returned an empty response on chunk 1.");

  // Verify and fix chunk 1
  const { missing: missing1, invented: invented1 } = verifyChunkRules(finalXml, chunks[0].map(b => b.id));
  if (invented1.length > 0) finalXml = removeInvented(finalXml);
  for (const missingId of missing1) {
    const brdp = chunks[0].find(b => b.id === missingId);
    if (brdp) {
      const rule = await generateSingleRule(brdp, projectConfig, schemaSummary, callLLM);
      if (rule) finalXml = assembleChunks(finalXml, '\n' + rule.xml);
    }
  }

  // Chunks 2..N: rules only
  for (let i = 1; i < chunks.length; i++) {
    const { system: sysN, user: usrN } = buildBREXPromptChunk(chunks[i], projectConfig, schemaSummary);
    const rawN = await callLLM(sysN, usrN);

    let escapedN = (rawN && rawN.trim() ? rawN.trim() : '').replace(/\s+allowedObjectFlagContext="[^"]*"/g, '')
      .replace(/<brDecisionIdentNumber brDecisionIdentNumber="([^"]+)"\/>/g, '<brDecisionRef brDecisionIdentNumber="$1"/>');
    escapedN = escapeXMLContent(escapedN);
    escapedN = splitMultipleObjectPaths(escapedN);
    const { missing: missingN, invented: inventedN } = verifyChunkRules(escapedN, chunks[i].map(b => b.id));
    if (inventedN.length > 0) escapedN = removeInvented(escapedN);
    finalXml = assembleChunks(finalXml, '\n' + escapedN);

    // Retry missing individually
    for (const missingId of missingN) {
      const brdp = chunks[i].find(b => b.id === missingId);
      if (brdp) {
        const rule = await generateSingleRule(brdp, projectConfig, schemaSummary, callLLM);
        if (rule) finalXml = assembleChunks(finalXml, '\n' + rule.xml);
      }
    }
  }

  // Inject frozen approvals verbatim -- never re-escaped or rebuilt, same as
  // any already-generated rule. Must happen before the coverage sweep so
  // `present`/`presentNonCtx` pick these ids up and don't treat them as
  // missing.
  if (approvedBRDPs.length > 0) {
    const approvedXml = approvedBRDPs
      .map(b => approvalById.get(b.id).rule_xml)
      .join('\n');
    finalXml = assembleChunks(finalXml, approvedXml);
  }

  // Barrido final de cobertura: ningún BRDP debe perderse en silencio
  {
    const present = new Set(
      [...finalXml.matchAll(/<structureObjectRule id="([^"]+)"/g)].map(m => m[1].replace(/-[bcde]$/, ''))
    );
    const presentNonCtx = new Set(
      [...finalXml.matchAll(/<nonContextRule\b[^>]*id="([^"]+)"/g)].map(m => m[1])
    );
    const stillMissing = targetBRDPs.filter(b => !present.has(b.id) && !presentNonCtx.has(b.id));
    for (const brdp of stillMissing) {
      const rule = await generateSingleRule(brdp, projectConfig, schemaSummary, callLLM);
      if (rule) {
        finalXml = assembleChunks(finalXml, '\n' + rule.xml);
      } else {
        // Red de seguridad: nunca perder un BRDP -> nonContextRule formal de trazabilidad
        const desc = String(brdp.definition || brdp.proposal || 'Regla sin contexto')
          .replace(/[\r\n]+/g, ' ')
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .trim().slice(0, 300);
        const safety = '<nonContextRule id="' + brdp.id + '" brSeverityLevel="brsl01">'
          + '<brDecisionRef brDecisionIdentNumber="' + brdp.id + '"/>'
          + '<simplePara>' + desc + '</simplePara></nonContextRule>';
        finalXml = assembleChunks(finalXml, '\n' + safety);
      }
    }
  }

  // Ensure footer
  if (!finalXml.includes('</dmodule>')) {
    const lastRule = finalXml.lastIndexOf('</structureObjectRule>');
    if (lastRule !== -1) {
      finalXml = finalXml.slice(0, lastRule + '</structureObjectRule>'.length) + XML_FOOTER;
    }
  }

  // Finalización determinista: tag dmodule, allowedObjectFlag en objectPath,
  // promoción de huérfanos, campos dmCode, dedup de nonContextRule
  finalXml = finalizeDocument(finalXml, projectConfig, schemaSummary);

  const { valid, error } = checkWellFormed(finalXml);
  return { xml: finalXml, valid, error, brdpCount: targetBRDPs.length };
}
