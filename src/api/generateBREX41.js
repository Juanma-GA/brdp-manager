import { extractXML, checkWellFormed } from "./generateBREX.js";
import { getApprovalsForFormat } from "./approvals.js";

let _schemaSummaryCache41 = null;

export async function loadSchemaSummary41() {
  if (_schemaSummaryCache41) return _schemaSummaryCache41;
  const res = await fetch("/brex-schema-summary-4-1.json?v=" + Date.now());
  if (!res.ok) throw new Error("Could not load brex-schema-summary-4-1.json");
  _schemaSummaryCache41 = await res.json();
  return _schemaSummaryCache41;
}

export function buildBREXPromptChunk41(chunkBRDPs, projectConfig, schemaSummary) {
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
<structureObjectRule id="${ex.id}">
  <objectPath${flagAttr}>${ex.objectPath}</objectPath>
  <objectUse>${ex.objectUse}</objectUse>
${objectValueLines}</structureObjectRule>`;
  }).join("\n\n");

  const system = `You are an S1000D Issue 4.1 expert generating structureObjectRule elements for a BREX Data Module.

Follow this schema structure exactly:
${schemaJSON}

STRICT RULES:
1. Output ONLY raw structureObjectRule XML elements — no XML declaration, no dmodule wrapper, no markdown.
2. Each BRDP = one structureObjectRule element.
3. Child order in structureObjectRule: objectPath → objectUse → objectValue.
4. allowedObjectFlag: "0"=prohibited, "1"=mandatory, "2"=optional.
5. objectUse = one sentence summarising the decision.
6. Start output directly with <structureObjectRule — no preamble.
7. Each structureObjectRule must contain EXACTLY ONE objectPath element. If a BRDP requires multiple XPath expressions, generate multiple separate structureObjectRule elements with UNIQUE id attributes: use suffix -b, -c, -d for the additional rules (e.g. id="BRDP-S1-00093-b", id="BRDP-S1-00093-c"). The first rule keeps the original id. NEVER repeat the same id value in more than one structureObjectRule. This also applies when multiple objectPath elements share the same allowedObjectFlag value — each objectPath must still be in its own separate structureObjectRule with a unique id.
8. objectValue ONLY allows two attributes: valueAllowed and valueForm. valueForm MUST be one of: single, range, pattern. NEVER use list, regex, conditional, multiple or any other value. NEVER add a condition attribute or any other attribute to objectValue.
9. If a BRDP has no clear XPath target (procedural rules, references to external standards, general policies), output it as a nonContextRule — NOT as a structureObjectRule. The exact structure to output is:
<nonContextRule id="BRDP-xxx">
  <simplePara>One sentence describing the rule.</simplePara>
</nonContextRule>
assembleChunks41() will place it correctly inside <nonContextRules>.
NEVER put nonContextRule inside structureObjectRule. NEVER generate a structureObjectRule without objectPath.
10. The id attribute of structureObjectRule must be globally unique across the entire document. NEVER use the same id value twice. If you split a BRDP into multiple structureObjectRule elements, only the first keeps the BRDP id. Additional rules use BRDP-id-b, BRDP-id-c, etc.
11. NEVER invent attributes not in the schema. objectPath only allows allowedObjectFlag (values: 0, 1, 2) — no other attributes allowed on objectPath. There is NO brDecisionRef element and NO brSeverityLevel attribute in S1000D 4.1. Inside <simplePara> text, NEVER use raw XML tags: escape element names as &lt;elementName&gt; instead of <elementName>.

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

function escapeXMLContent41(xml) {
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

function splitMultipleObjectPaths41(xml) {
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
    const objectUseMatch = rule.full.match(/<objectUse>[\s\S]*?<\/objectUse>/);
    const objectValueMatch = rule.full.match(/<objectValue[^>]*\/>/);

    if (!idMatch) continue;

    const baseId = idMatch[1];
    const objectUse = objectUseMatch ? objectUseMatch[0] : '';
    const objectValue = objectValueMatch ? objectValueMatch[0] : '';
    const suffixes = ['', '-b', '-c', '-d', '-e'];

    const newRules = paths.map((path, i) => {
      const newId = baseId + (suffixes[i] || `-${i}`);
      const lines = [
        `<structureObjectRule id="${newId}">`,
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

function assembleChunks41(baseXml, additionalRules) {
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

const MAX_RETRIES_41 = 2;

// Batch-fetches every frozen approval for the given format in one request
// (GET /api/approvals/format/:format) instead of one call per BRDP. Same
// safe-degrade philosophy as generateBREX301.js's fetchApprovalsMap301: a
// fetch failure falls back to "no approvals" instead of aborting generation
// -- affected BRDPs simply go through the normal LLM/safety-net path, so
// coverage is never at risk, only the deterministic-injection optimization
// for that run.
async function fetchApprovalsMap41(format) {
  try {
    const rows = await getApprovalsForFormat(format);
    return new Map(rows.map((r) => [r.brdp_id, r]));
  } catch (err) {
    console.error(`Failed to fetch rule approvals for format ${format}:`, err);
    return new Map();
  }
}

export async function generateSingleRule41(brdp, projectConfig, schemaSummary, callLLM) {
  const { system, user } = buildBREXPromptChunk41([brdp], projectConfig, schemaSummary);
  for (let attempt = 0; attempt < MAX_RETRIES_41; attempt++) {
    const raw = await callLLM(system, user);
    if (!raw) continue;
    const escaped = raw.trim()
      .replace(/\s+allowedObjectFlagContext="[^"]*"/g, '');
    const escapedContent = escapeXMLContent41(escaped);
    const splitContent = splitMultipleObjectPaths41(escapedContent);

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
  console.warn(`Could not generate rule for ${brdp.id} after ${MAX_RETRIES_41} attempts`);
  return null;
}

// ===== Finalización determinista del documento (S1000D 4.1) =====

function forceDmoduleTag41(xml, dmoduleOpeningTag) {
  if (!dmoduleOpeningTag) return xml;
  return xml.replace(/<dmodule\b[^>]*>/, dmoduleOpeningTag);
}

function forceIssueType41(xml) {
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

function fixFlagPlacement41(xml) {
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

function promoteOrphanSplitRules41(xml) {
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

function dedupeNonContextRules41(xml) {
  const seen = new Set();
  return xml.replace(/<nonContextRule\b[^>]*id="([^"]+)"[\s\S]*?<\/nonContextRule>/g, (full, id) => {
    if (seen.has(id)) return '';
    seen.add(id);
    return full;
  });
}

function resolveDmCodeFields41(projectConfig) {
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

function forceDmCodeFields41(xml, fields) {
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

function dropRedundantNonContextRules41(xml) {
  // Si un BRDP ya existe como structureObjectRule (ejecutable), elimina su nonContextRule
  // redundante para no duplicar el id xs:ID. Gana la regla ejecutable.
  const sorBase = new Set(
    [...xml.matchAll(/<structureObjectRule id="([^"]+)"/g)].map(m => m[1].replace(/-[bcde]$/, ''))
  );
  return xml.replace(/<nonContextRule\b[^>]*id="([^"]+)"[\s\S]*?<\/nonContextRule>/g, (full, id) => {
    return sorBase.has(id.replace(/-[bcde]$/, '')) ? '' : full;
  });
}

function finalizeDocument41(xml, projectConfig, schemaSummary) {
  xml = forceDmoduleTag41(xml, schemaSummary && schemaSummary.dmodule_opening_tag);
  xml = forceIssueType41(xml);
  xml = fixFlagPlacement41(xml);
  xml = promoteOrphanSplitRules41(xml);
  xml = forceDmCodeFields41(xml, resolveDmCodeFields41(projectConfig));
  xml = dropRedundantNonContextRules41(xml);
  xml = dedupeNonContextRules41(xml);
  return xml;
}

// Deterministic empty document skeleton -- see buildEmptyDocument in
// generateBREX.js for the full rationale; 4.1's header structure is
// identical to 4.2's (confirmed against brex-schema-summary-4-1.json's
// "structure" key), only structureObjectRule/nonContextRule differ (no
// brDecisionRef/brSeverityLevel in 4.1).
function esc41(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildEmptyDocument41(projectConfig, schemaSummary) {
  const cfg = projectConfig || {};
  const dmCodeFields = resolveDmCodeFields41(cfg);
  const dmCodeAttrs = Object.entries(dmCodeFields).map(([k, v]) => `${k}="${esc41(v)}"`).join(' ');
  const languageIsoCode = esc41(cfg.languageIsoCode || 'en');
  const countryIsoCode = esc41(cfg.countryIsoCode || 'US');
  const issueNumber = esc41(cfg.issueNumber || '001');
  const inWork = esc41(cfg.inWork || '00');
  const securityClassification = esc41(cfg.securityClassification || '01');
  const enterpriseCode = esc41(cfg.enterpriseCode || '');
  const projectName = esc41(cfg.projectName || cfg.modelIdentCode || 'Project');
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  const openingTag = (schemaSummary && schemaSummary.dmodule_opening_tag) || '<dmodule>';
  const rpcAttr = enterpriseCode ? ` enterpriseCode="${enterpriseCode}"` : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
${openingTag}
<identAndStatusSection>
<dmAddress>
<dmIdent>
<dmCode ${dmCodeAttrs}/>
<language languageIsoCode="${languageIsoCode}" countryIsoCode="${countryIsoCode}"/>
<issueInfo issueNumber="${issueNumber}" inWork="${inWork}"/>
</dmIdent>
<dmAddressItems>
<issueDate year="${year}" month="${month}" day="${day}"/>
<dmTitle>
<techName>${projectName}</techName>
<infoName>Business Rules Exchange</infoName>
</dmTitle>
</dmAddressItems>
</dmAddress>
<dmStatus issueType="new">
<security securityClassification="${securityClassification}"/>
<responsiblePartnerCompany${rpcAttr}/>
<originator${rpcAttr}/>
<applic><displayText><simplePara>All</simplePara></displayText></applic>
<brexDmRef>
<dmRef>
<dmRefIdent>
<dmCode ${dmCodeAttrs}/>
<issueInfo issueNumber="${issueNumber}" inWork="${inWork}"/>
</dmRefIdent>
</dmRef>
</brexDmRef>
<qualityAssurance><unverified/></qualityAssurance>
</dmStatus>
</identAndStatusSection>
<content>
<brex>
<contextRules rulesContext="">
<structureObjectRuleGroup>
</structureObjectRuleGroup>
</contextRules>
</brex>
</content>
</dmodule>`;
}

function pruneEmptyContainers41(xml) {
  xml = xml.replace(/<structureObjectRuleGroup>\s*<\/structureObjectRuleGroup>/g, '');
  xml = xml.replace(/<contextRules\b[^>]*>\s*<\/contextRules>/g, '');
  return xml;
}

// Pure deterministic assembler -- no LLM call, ever. See generateBREX.js's
// generateBREX() for the full design rationale (identical here, only the
// element vocabulary differs). generateSingleRule41 and the prompt builders
// above still exist, unchanged, for the BRDP Assistant's "Suggest Rule" mode.
export async function generateBREX41(brdps, projectConfig, options = {}) {
  const {
    onlyValidated = true,
    approvals: approvalsOverride,
    approvalsFormat = 'BREX-4.1',
    schemaSummary: schemaSummaryOverride,
  } = options;

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

  const schemaSummary = schemaSummaryOverride || (await loadSchemaSummary41());

  const approvalById = approvalsOverride
    ? (approvalsOverride instanceof Map ? approvalsOverride : new Map(approvalsOverride.map((a) => [a.brdp_id, a])))
    : await fetchApprovalsMap41(approvalsFormat);

  const approvedBRDPs = [];
  const unapprovedBRDPs = [];
  for (const brdp of targetBRDPs) {
    if (approvalById.get(brdp.id)?.status === 'approved') approvedBRDPs.push(brdp);
    else unapprovedBRDPs.push(brdp);
  }

  let finalXml = buildEmptyDocument41(projectConfig, schemaSummary);

  if (approvedBRDPs.length > 0) {
    const approvedXml = approvedBRDPs.map((b) => approvalById.get(b.id).rule_xml).join('\n');
    finalXml = assembleChunks41(finalXml, approvedXml);
  }

  finalXml = pruneEmptyContainers41(finalXml);

  if (unapprovedBRDPs.length > 0) {
    const comments = unapprovedBRDPs
      .map((b) => `<!-- ${b.id}: pendiente de aprobación de regla, no incluida en este documento -->`)
      .join('\n');
    finalXml = finalXml.replace('</brex>', comments + '\n</brex>');
  }

  finalXml = finalizeDocument41(finalXml, projectConfig, schemaSummary);

  const { valid, error } = checkWellFormed(finalXml);

  return { xml: finalXml, valid, error, brdpCount: targetBRDPs.length };
}
