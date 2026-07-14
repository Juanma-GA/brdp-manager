import { sendMessageStream } from "./llmAPI.js";
import { extractXML, checkWellFormed } from "./generateBREX.js";
import { getApprovalsForFormat } from "./approvals.js";

let _schemaSummaryCache301 = null;

async function loadSchemaSummary301() {
  if (_schemaSummaryCache301) return _schemaSummaryCache301;
  const res = await fetch("/brex-schema-summary-3-0-1.json?v=" + Date.now());
  if (!res.ok) throw new Error("Failed to load brex-schema-summary-3-0-1.json");
  _schemaSummaryCache301 = await res.json();
  return _schemaSummaryCache301;
}

export function buildBREXPrompt301(validatedBRDPs, projectConfig, schemaSummary) {
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

    const objvalLines = (ex.objectValues || [])
      .map(v => `  <objval val1="${v}" valtype="single"/>`)
      .join("\n");

    const flagAttr = ex.allowedObjectFlag != null ? ` objappl="${ex.allowedObjectFlag}"` : "";

    return `### Example ${i + 1} — ${labels.join(", ")}
INPUT id: ${ex.id}
OUTPUT:
<objrule id="${ex.id}">
  <objpath${flagAttr}>${ex.objectPath}</objpath>
  <objuse>${ex.objectUse}</objuse>
${objvalLines}</objrule>`;
  }).join("\n\n");

  const system = `You are an S1000D Issue 3.0.1 expert. Generate a valid BREX Data Module XML.

Follow this schema structure exactly:
${schemaJSON}

STRICT RULES:
1. Output ONLY the XML — no markdown fences, no \`\`\`xml tags, no explanation, no preamble.
2. First character must be: <?xml version="1.0" encoding="UTF-8"?>
3. Use the exact dmodule opening tag from dmodule_opening_tag in the schema.
4. incode is always 022.
5. Structure: content > brex > contextrules > structrules > objrule
   There is NO structureObjectRuleGroup. There is NO nonContextRules element.
   <brex> contains one or more <contextrules> elements directly.
   <contextrules> contains <structrules>.
   <structrules> contains all <objrule> elements.
6. Each BRDP = one objrule with attribute id equal to the BRDP identifier.
7. There is NO brDecisionRef element in 3.0.1 — the BRDP id goes in objrule @id ONLY.
8. Child order in objrule: objpath -> objuse -> objval (one per allowed value).
9. objappl attribute inside objpath: "0"=prohibited, "1"=mandatory. NO other values allowed.
10. objval format: <objval val1="VALUE" valtype="single"/>
    objval ONLY allows attributes: val1, val2, valtype.
    valtype MUST be "single" or "range" ONLY. NEVER use pattern, list, regex, conditional or multiple.
    val2 is only used when valtype="range".
    NEVER add any other attribute to objval.
11. objuse = one sentence summarising the decision.
12. Use the todayDate value for issdate attributes. Format: year="YYYY" month="MM" day="DD".
13. techname = project name; infoname = "Business rules".
14. qa: <qa><unverif/></qa>
15. applic: <applic><displaytext><p>All</p></displaytext></applic>
16. brexref/refdm/avee must contain the same child elements as dmc/avee (self-reference).
17. dmaddres child order: dmc -> dmtitle -> issno -> issdate -> language
18. issno attributes: issno="001" inwork="00" type="new"
19. status child order: security -> rpc -> orig -> applic -> brexref -> qa
20. Each objrule must contain EXACTLY ONE objpath element. If a BRDP requires multiple XPath
    expressions, generate multiple separate objrule elements with UNIQUE id attributes using
    suffixes -b, -c, -d (e.g. id="BRDP-A1-00093-b"). The first rule keeps the original id.
    NEVER repeat the same id value in more than one objrule.
21. The id attribute of objrule must be globally unique across the entire document.
    NEVER use the same id value twice.
22. NEVER invent attributes not in the schema. objpath only allows objappl (values: 0 or 1).
    NO other attributes allowed on objpath.
23. S1000D 3.0.1 does NOT have a nonContextRules element. If a BRDP has no clear XPath target,
    generate a valid objrule with a best-effort XPath, then add an XML comment immediately after it
    for traceability, in this exact form (one single line, NEVER use double hyphens "--" inside):
    <!-- nonContextRule id="BRDP-xxx": one sentence describing the conceptual rule -->
24. NEVER use issueType="original". Use type="new" in issno instead.
25. Inside text content of any element, NEVER use raw XML special characters.
    Escape them as: &lt; &gt; &amp;

## Few-shot examples: BRDP id -> objrule
Use these real validated examples as reference for structure, XPath patterns and objval formatting.

${fewShotBlock}`;

  const brdpLines = validatedBRDPs
    .map((b, i) =>
      `${i + 1}. ID: ${b.id}\n   Definition: ${b.definition}\n   Proposal: ${b.proposal}\n   Validation: ${b.validation}`
    )
    .join("\n\n");

  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  const user = `Generate a BREX Data Module XML (S1000D 3.0.1) with this project configuration:

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

export function buildBREXPromptChunk301(chunkBRDPs, projectConfig, schemaSummary) {
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

    const objvalLines = (ex.objectValues || [])
      .map(v => `  <objval val1="${v}" valtype="single"/>`)
      .join("\n");

    const flagAttr = ex.allowedObjectFlag != null ? ` objappl="${ex.allowedObjectFlag}"` : "";

    return `### Example ${i + 1} — ${labels.join(", ")}
INPUT id: ${ex.id}
OUTPUT:
<objrule id="${ex.id}">
  <objpath${flagAttr}>${ex.objectPath}</objpath>
  <objuse>${ex.objectUse}</objuse>
${objvalLines}</objrule>`;
  }).join("\n\n");

  const system = `You are an S1000D Issue 3.0.1 expert generating objrule elements for a BREX Data Module.

Follow this schema structure exactly:
${schemaJSON}

STRICT RULES:
1. Output ONLY raw objrule XML elements — no XML declaration, no dmodule wrapper, no markdown.
2. Each BRDP = one objrule element.
3. Child order in objrule: objpath -> objuse -> objval (one per allowed value).
4. There is NO brDecisionRef in 3.0.1. The BRDP id goes in objrule @id ONLY.
5. objappl attribute inside objpath: "0"=prohibited, "1"=mandatory. NO other values allowed.
6. objuse = one sentence summarising the decision.
7. Start output directly with <objrule — no preamble.
8. Each objrule must contain EXACTLY ONE objpath element. If a BRDP requires multiple XPath
   expressions, generate multiple separate objrule elements with UNIQUE id attributes using
   suffixes -b, -c, -d (e.g. id="BRDP-A1-00093-b"). The first rule keeps the original id.
   NEVER repeat the same id value in more than one objrule.
9. objval ONLY allows attributes: val1, val2, valtype.
   valtype MUST be "single" or "range" ONLY. NEVER use pattern, list, regex, conditional or multiple.
   val2 is only used when valtype="range".
   NEVER add any other attribute to objval.
10. The id attribute of objrule must be globally unique. NEVER use the same id value twice.
11. NEVER invent attributes not in the schema. objpath only allows objappl (values: 0 or 1).
12. S1000D 3.0.1 does NOT have a nonContextRules element. If a BRDP has no clear XPath target,
    generate a valid objrule with a best-effort XPath, then add an XML comment immediately after it
    for traceability, in this exact form (one single line, NEVER use double hyphens "--" inside):
    <!-- nonContextRule id="BRDP-xxx": one sentence describing the conceptual rule -->
13. Inside text content of any element, NEVER use raw XML special characters.
    Escape them as: &lt; &gt; &amp;

## Few-shot examples: BRDP id -> objrule
${fewShotBlock}`;

  const brdpLines = chunkBRDPs
    .map((b, i) =>
      `${i + 1}. ID: ${b.id}\n   Definition: ${b.definition}\n   Proposal: ${b.proposal}\n   Validation: ${b.validation}`
    )
    .join("\n\n");

  const user = `Generate objrule elements for these ${chunkBRDPs.length} BRDPs:

${brdpLines}

Output ONLY the objrule elements, starting directly with <objrule`;

  return { system, user };
}

function sanitizeNonContextComments301(xml) {
  // Un comentario XML no puede contener "--". Colapsamos runs de guiones y normalizamos.
  return xml.replace(/<!--([\s\S]*?)-->/g, (full, inner) => {
    const clean = inner.replace(/--+/g, '-').trim();
    return `<!-- ${clean} -->`;
  });
}

function escapeXMLContent301(xml) {
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

  xml = xml.replace(/<objuse>([\s\S]*?)<\/objuse>/g,
    (_, c) => `<objuse>${escapeText(c)}</objuse>`);
  xml = xml.replace(/(<objpath[^>]*>)([\s\S]*?)(<\/objpath>)/g,
    (_, open, c, close) => `${open}${escapeText(c)}${close}`);
  xml = xml.replace(/(<objval[^>]*>)([\s\S]*?)(<\/objval>)/g,
    (_, open, c, close) => `${open}${escapeText(c)}${close}`);

  return xml;
}

function splitMultipleObjPaths301(xml) {
  const original = xml;
  const rulePattern = /<objrule[\s\S]*?<\/objrule>/g;

  const rules = [];
  let match;
  while ((match = rulePattern.exec(original)) !== null) {
    rules.push({ full: match[0], start: match.index, end: match.index + match[0].length });
  }

  const replacements = [];
  for (const rule of rules) {
    const paths = [...rule.full.matchAll(/<objpath[^>]*>[\s\S]*?<\/objpath>/g)];
    if (paths.length <= 1) continue;

    const idMatch = rule.full.match(/id="([^"]+)"/);
    const objuseMatch = rule.full.match(/<objuse>[\s\S]*?<\/objuse>/);
    const objvalMatch = rule.full.match(/<objval[^>]*\/>/);
    const suffixes = ['', '-b', '-c', '-d', '-e'];

    if (!idMatch) continue;

    const baseId = idMatch[1];
    const objuse = objuseMatch ? objuseMatch[0] : '';
    const objval = objvalMatch ? objvalMatch[0] : '';

    const newRules = paths.map((path, i) => {
      const newId = baseId + (i < suffixes.length ? suffixes[i] : `-${i}`);
      const lines = [
        `<objrule id="${newId}">`,
        `  ${path[0]}`,
      ];
      if (objuse) lines.push(`  ${objuse}`);
      if (objval) lines.push(`  ${objval}`);
      lines.push(`</objrule>`);
      return lines.join('\n');
    }).join('\n');

    replacements.push({ start: rule.start, end: rule.end, replacement: newRules });
  }

  let result = original;
  for (let i = replacements.length - 1; i >= 0; i--) {
    const { start, end, replacement } = replacements[i];
    result = result.slice(0, start) + replacement + result.slice(end);
  }

  return result;
}

const XML_FOOTER_301 = `
</structrules>
</contextrules>
</brex>
</content>
</dmodule>`;

function assembleChunks301(baseXml, additionalRules) {
  // Extrae objrule Y comentarios nonContextRule en orden de documento (preserva trazabilidad)
  const piecePattern = /<objrule[\s\S]*?<\/objrule>|<!--\s*nonContextRule[\s\S]*?-->/g;
  const pieces = [];
  let m;
  while ((m = piecePattern.exec(additionalRules)) !== null) {
    let piece = m[0];
    if (piece.startsWith('<!--')) piece = sanitizeNonContextComments301(piece);
    pieces.push(piece);
  }
  if (!pieces.length) return baseXml;

  // Insertar justo antes de </structrules> para preservar todo lo que ya hay dentro
  const idx = baseXml.lastIndexOf('</structrules>');
  if (idx !== -1) {
    return baseXml.slice(0, idx) + pieces.join('\n') + '\n' + baseXml.slice(idx);
  }

  // Fallback: XML truncado sin </structrules> — reconstruir footer
  const footerTags = ['</contextrules>', '</brex>', '</content>', '</dmodule>'];
  let stripped = baseXml;
  for (const tag of footerTags) {
    const i2 = stripped.lastIndexOf(tag);
    if (i2 !== -1) stripped = stripped.slice(0, i2);
  }
  const lastObj = stripped.lastIndexOf('</objrule>');
  const lastComment = stripped.lastIndexOf('-->');
  const lastAny = Math.max(lastObj, lastComment);
  if (lastAny !== -1) {
    const endLen = lastObj >= lastComment ? '</objrule>'.length : '-->'.length;
    stripped = stripped.slice(0, lastAny + endLen);
  }
  return stripped + '\n' + pieces.join('\n') + XML_FOOTER_301;
}

const CHUNK_SIZE_301 = 10;
const MAX_RETRIES_301 = 2;

function verifyChunkRules301(rawResponse, expectedIds) {
  const foundIds = new Set(
    [...rawResponse.matchAll(/<objrule id="([^"]+)"/g)].map(m => m[1])
  );
  const validExpected = new Set(expectedIds);
  const missing = expectedIds.filter(id => !foundIds.has(id));
  const invented = [...foundIds].filter(id => !validExpected.has(id));
  return { missing, invented };
}

// Batch-fetches every frozen approval for the given format in one request
// (GET /api/approvals/format/:format) instead of one call per BRDP. Same
// safe-degrade philosophy as generateSchematronDITA.js's fetchApprovalsMap:
// a fetch failure falls back to "no approvals" instead of aborting
// generation -- affected BRDPs simply go through the normal LLM/safety-net
// path, so coverage is never at risk, only the deterministic-injection
// optimization for that run.
async function fetchApprovalsMap301(format) {
  try {
    const rows = await getApprovalsForFormat(format);
    return new Map(rows.map((r) => [r.brdp_id, r]));
  } catch (err) {
    console.error(`Failed to fetch rule approvals for format ${format}:`, err);
    return new Map();
  }
}

async function generateSingleRule301(brdp, projectConfig, schemaSummary, callLLM) {
  const { system, user } = buildBREXPromptChunk301([brdp], projectConfig, schemaSummary);
  for (let attempt = 0; attempt < MAX_RETRIES_301; attempt++) {
    const raw = await callLLM(system, user);
    if (!raw) continue;
    const sanitized = raw.trim()
      .replace(/\s+allowedObjectFlagContext="[^"]*"/g, '')
      .replace(/<brDecisionIdentNumber brDecisionIdentNumber="([^"]+)"\/>/g, '');
    const escaped = escapeXMLContent301(sanitized);
    const split = splitMultipleObjPaths301(escaped);

    const ruleMatch = split.match(/<objrule[\s\S]*?<\/objrule>/);
    if (ruleMatch) {
      const idMatch = ruleMatch[0].match(/objrule id="([^"]+)"/);
      if (idMatch && idMatch[1] === brdp.id) {
        // Conservar tambien un comentario de trazabilidad si el LLM lo añadió
        const commentMatch = split.match(/<!--\s*nonContextRule[\s\S]*?-->/);
        return ruleMatch[0] + (commentMatch ? '\n' + sanitizeNonContextComments301(commentMatch[0]) : '');
      }
    }
  }
  console.warn(`Could not generate objrule for ${brdp.id} after ${MAX_RETRIES_301} attempts`);
  return null;
}

// ===== Finalización determinista del documento (S1000D 3.0.1) =====

function forceDmoduleTag301(xml, dmoduleOpeningTag) {
  if (!dmoduleOpeningTag) return xml;
  return xml.replace(/<dmodule\b[^>]*>/, dmoduleOpeningTag);
}

function fixObjapplPlacement301(xml) {
  return xml.replace(/<objrule\b[^>]*>[\s\S]*?<\/objrule>/g, (rule) => {
    const openMatch = rule.match(/<objrule\b([^>]*)>/);
    if (!openMatch) return rule;
    const apMatch = openMatch[1].match(/\sobjappl="([01])"/);
    if (!apMatch) return rule;
    const flag = apMatch[1];
    let fixed = rule.replace(/(<objrule\b[^>]*?)\sobjappl="[01]"([^>]*>)/, '$1$2');
    let injected = false;
    fixed = fixed.replace(/<objpath\b([^>]*)>/, (pm, pattrs) => {
      if (injected) return pm;
      injected = true;
      if (/objappl=/.test(pattrs)) return pm;
      return `<objpath objappl="${flag}"${pattrs}>`;
    });
    return fixed;
  });
}

function resolveAveeFields301(projectConfig) {
  const cfg = projectConfig || {};
  const useIfValid = (val, pattern, def) =>
    (typeof val === 'string' && pattern.test(val)) ? val : def;
  return {
    modelic:  useIfValid(cfg.modelIdentCode, /^[A-Za-z0-9]{2,14}$/, cfg.modelIdentCode || 'UNKNOWN'),
    sdc:      useIfValid(cfg.systemDiffCode, /^[A-Za-z0-9]{1,4}$/, 'A'),
    chapnum:  '00',
    section:  '0',
    subsect:  '0',
    subject:  '00',
    discode:  '00',
    discodev: '00A',
    incode:   '022',
    incodev:  'A',
    itemloc:  'D',
  };
}

function forceAveeFields301(xml, fields) {
  for (const [el, val] of Object.entries(fields)) {
    xml = xml.replace(new RegExp(`<${el}\\s*/>`, 'g'), `<${el}>${val}</${el}>`);
    xml = xml.replace(new RegExp(`<${el}>[\\s\\S]*?</${el}>`, 'g'), `<${el}>${val}</${el}>`);
  }
  return xml;
}

// Promueve la primera regla split huérfana (id-b/-c sin su id base) al id base, restaurando trazabilidad
function promoteOrphanSplitRules301(xml) {
  const ids = new Set([...xml.matchAll(/<objrule id="([^"]+)"/g)].map(m => m[1]));
  const promoted = new Set();
  return xml.replace(/<objrule id="([^"]+)"/g, (full, id) => {
    const m = id.match(/^(.*)-([bcde])$/);
    if (!m) return full;
    const base = m[1];
    if (ids.has(base) || promoted.has(base)) return full;
    promoted.add(base);
    return `<objrule id="${base}"`;
  });
}

// Elimina comentarios nonContextRule duplicados por id (conserva el primero)
function dedupeNonContextComments301(xml) {
  const seen = new Set();
  return xml.replace(/[ \t]*<!--\s*nonContextRule id="([^"]+)":[\s\S]*?-->\n?/g, (full, id) => {
    if (seen.has(id)) return '';
    seen.add(id);
    return full;
  });
}

function finalizeDocument301(xml, projectConfig, schemaSummary) {
  xml = forceDmoduleTag301(xml, schemaSummary && schemaSummary.dmodule_opening_tag);
  xml = fixObjapplPlacement301(xml);
  xml = promoteOrphanSplitRules301(xml);
  xml = forceAveeFields301(xml, resolveAveeFields301(projectConfig));
  xml = dedupeNonContextComments301(xml);
  return xml;
}

export async function generateBREX301(brdps, projectConfig, options = {}) {
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

  const schemaSummary = schemaSummaryOverride || (await loadSchemaSummary301());

  // A BRDP with a frozen approval for approvalsFormat (see src/api/approvals.js
  // and CLAUDE.md's rule_approvals design) is injected verbatim into the
  // assembled BREX 3.0.1 document and never sent to the LLM. approvalsFormat
  // is caller-supplied rather than hardcoded, because this same function
  // serves two different user-facing formats depending on the caller: called
  // directly for the "BREX -- S1000D 3.0.1" format (its own future approvals
  // key, not wired yet) and via generateBREXSch.js for "Schematron 1.0 --
  // S1000D" (approvalsFormat: 'SCH-S1000D') -- the frozen <objrule> is the
  // same shape either way, brexToSchematron() deterministically turns it into
  // the same <sch:pattern> downstream. Omitting approvalsFormat (today's
  // direct-3.0.1 call site) skips the fetch entirely -- no behavior change.
  const approvalById = approvalsOverride
    ? (approvalsOverride instanceof Map ? approvalsOverride : new Map(approvalsOverride.map((a) => [a.brdp_id, a])))
    : (approvalsFormat ? await fetchApprovalsMap301(approvalsFormat) : new Map());

  const approvedBRDPs = [];
  const llmBRDPs = [];
  for (const brdp of targetBRDPs) {
    if (approvalById.has(brdp.id)) approvedBRDPs.push(brdp);
    else llmBRDPs.push(brdp);
  }

  // Scoped to llmBRDPs (not targetBRDPs): if the LLM ever echoes an approved
  // BRDP's id anyway (it was never given that BRDP in any prompt), it must be
  // treated as invented and stripped -- otherwise it would duplicate the
  // objrule injected separately below for the same id.
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

  // Conserva ids validos y sus variantes con sufijo -b/-c/-d/-e (reglas divididas)
  const removeInvented = (xml) =>
    xml.replace(/<objrule[\s\S]*?<\/objrule>/g, (match) => {
      const idMatch = match.match(/objrule id="([^"]+)"/);
      if (!idMatch) return '';
      const baseId = idMatch[1].replace(/-[bcde]$/, '');
      return (validSet.has(idMatch[1]) || validSet.has(baseId)) ? match : '';
    });

  const chunks = [];
  for (let i = 0; i < llmBRDPs.length; i += CHUNK_SIZE_301) {
    chunks.push(llmBRDPs.slice(i, i + CHUNK_SIZE_301));
  }
  // Every BRDP may have a frozen approval and none need the LLM -- chunk 1 is
  // still generated (header-only, zero rules) since it's the only path that
  // produces the document skeleton; approved objrules are injected afterward.
  if (chunks.length === 0) chunks.push([]);

  // Chunk 1: DM completo
  const { system: sys1, user: usr1 } = buildBREXPrompt301(chunks[0], projectConfig, schemaSummary);
  const raw1 = await callLLM(sys1, usr1);
  let finalXml = extractXML(raw1);
  if (!finalXml) throw new Error("The model returned an empty response on chunk 1.");

  finalXml = finalXml.replace(/\s+allowedObjectFlagContext="[^"]*"/g, '');
  finalXml = finalXml.replace(/<brDecisionIdentNumber brDecisionIdentNumber="([^"]+)"\/>/g, '');
  finalXml = escapeXMLContent301(finalXml);
  finalXml = splitMultipleObjPaths301(finalXml);
  finalXml = sanitizeNonContextComments301(finalXml);

  const { missing: missing1, invented: invented1 } = verifyChunkRules301(finalXml, chunks[0].map(b => b.id));
  if (invented1.length > 0) finalXml = removeInvented(finalXml);
  for (const missingId of missing1) {
    const brdp = chunks[0].find(b => b.id === missingId);
    if (brdp) {
      const rule = await generateSingleRule301(brdp, projectConfig, schemaSummary, callLLM);
      if (rule) finalXml = assembleChunks301(finalXml, '\n' + rule);
    }
  }

  // Chunks 2..N: solo objrule (+ comentarios de trazabilidad)
  for (let i = 1; i < chunks.length; i++) {
    const { system: sysN, user: usrN } = buildBREXPromptChunk301(chunks[i], projectConfig, schemaSummary);
    const rawN = await callLLM(sysN, usrN);

    let escapedN = (rawN && rawN.trim() ? rawN.trim() : '')
      .replace(/\s+allowedObjectFlagContext="[^"]*"/g, '')
      .replace(/<brDecisionIdentNumber brDecisionIdentNumber="([^"]+)"\/>/g, '');
    escapedN = escapeXMLContent301(escapedN);
    escapedN = splitMultipleObjPaths301(escapedN);

    const { missing: missingN, invented: inventedN } = verifyChunkRules301(escapedN, chunks[i].map(b => b.id));
    if (inventedN.length > 0) escapedN = removeInvented(escapedN);
    finalXml = assembleChunks301(finalXml, '\n' + escapedN);

    for (const missingId of missingN) {
      const brdp = chunks[i].find(b => b.id === missingId);
      if (brdp) {
        const rule = await generateSingleRule301(brdp, projectConfig, schemaSummary, callLLM);
        if (rule) finalXml = assembleChunks301(finalXml, '\n' + rule);
      }
    }
  }

  // Inject frozen approvals verbatim -- never re-escaped or rebuilt, same as
  // any already-generated objrule. Must happen before the coverage sweep so
  // `present` picks these ids up and doesn't treat them as missing.
  if (approvedBRDPs.length > 0) {
    const approvedXml = approvedBRDPs
      .map(b => approvalById.get(b.id).rule_xml)
      .join('\n');
    finalXml = assembleChunks301(finalXml, approvedXml);
  }

  // Barrido final de cobertura: ningún BRDP debe perderse en silencio
  {
    const present = new Set(
      [...finalXml.matchAll(/<objrule id="([^"]+)"/g)].map(m => m[1].replace(/-[bcde]$/, ''))
    );
    const stillMissing = targetBRDPs.filter(b =>
      !present.has(b.id) && !finalXml.includes('nonContextRule id="' + b.id + '"')
    );
    for (const brdp of stillMissing) {
      const rule = await generateSingleRule301(brdp, projectConfig, schemaSummary, callLLM);
      if (rule) {
        finalXml = assembleChunks301(finalXml, '\n' + rule);
      } else {
        // Red de seguridad: nunca perder un BRDP -> comentario de trazabilidad
        const desc = String(brdp.definition || brdp.proposal || 'Regla sin contexto')
          .replace(/--+/g, '-').replace(/[\r\n]+/g, ' ').trim().slice(0, 300);
        finalXml = assembleChunks301(finalXml, '\n<!-- nonContextRule id="' + brdp.id + '": ' + desc + ' -->');
      }
    }
  }

  // Garantizar footer
  if (!finalXml.includes('</dmodule>')) {
    const lastRule = finalXml.lastIndexOf('</objrule>');
    if (lastRule !== -1) {
      finalXml = finalXml.slice(0, lastRule + '</objrule>'.length) + XML_FOOTER_301;
    }
  }

  // Finalización determinista: tag dmodule, objappl en objpath, campos avee
  finalXml = finalizeDocument301(finalXml, projectConfig, schemaSummary);

  const { valid, error } = checkWellFormed(finalXml);
  return { xml: finalXml, valid, error, brdpCount: targetBRDPs.length };
}
