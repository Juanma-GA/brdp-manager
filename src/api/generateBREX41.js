import { ruleEnters } from '../utils/generatePlan.js';
import { checkWellFormed, pendingApprovalComment } from "./generateBREX.js";
import { mergeContextBlocks, splitRuleXmlPieces } from "../utils/ruleWrappers.js";
import { numberApprovedRulesDuplicateIds, splitApprovedRulesMultiPath } from "../utils/ruleSplit.js";
import { countEmptySchemaContextBlocks, rewriteApprovedRulesSchemaUrls, schemaContextUrl, schemaLocationOf, setDmoduleSchemaLocation } from "../utils/ruleSchemaContext.js";

let _schemaSummaryCache41 = null;

async function loadSchemaSummary41() {
  if (_schemaSummaryCache41) return _schemaSummaryCache41;
  const res = await fetch("/brex-schema-summary-4-1.json?v=" + Date.now());
  if (!res.ok) throw new Error("Could not load brex-schema-summary-4-1.json");
  _schemaSummaryCache41 = await res.json();
  return _schemaSummaryCache41;
}

function assembleChunks41(baseXml, additionalRules) {
  // S1000D 4.1 allows multiple <contextRules rulesContext="..."> as
  // siblings under <brex> (brex4.1.xsd: contextRules maxOccurs="unbounded",
  // same as 4.2), each scoped to a specific schema. See assembleChunks()
  // in generateBREX.js for the full rationale (identical here). The rules
  // are taken apart by splitRuleXmlPieces (src/utils/ruleWrappers.js, the
  // same scan the Excel import and normalize_rule_wrappers.py use to store
  // them clean): complete context blocks whole, and every loose
  // structureObjectRule / nonContextRule wherever it sits, so a legacy
  // wrapper (<rules>, a bare <structureObjectRuleGroup>) never hides one.
  // A <contextRules> with an empty rulesContext is not a block, only a
  // wrapper: its rules go into the general <contextRules> (no attribute,
  // see buildEmptyDocument41).
  const contextRulesBlocks = [];
  const structureRules = [];
  const nonContextRules = [];
  for (const piece of splitRuleXmlPieces(additionalRules, 'BREX-4.1')) {
    if (piece.kind === 'block') contextRulesBlocks.push(piece.text);
    else if (piece.kind === 'rule') structureRules.push(piece.text);
    else if (piece.kind === 'noncontext') nonContextRules.push(piece.text);
  }

  const cleanedStructure = structureRules.join('\n');
  const cleanedNonContext = nonContextRules.join('\n');

  if (!cleanedStructure.trim() && !cleanedNonContext.trim() && contextRulesBlocks.length === 0) return baseXml;

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
      const deduped = (cleanedNonContext.match(/<nonContextRule(?![a-zA-Z])[\s\S]*?<\/nonContextRule>/g) || [])
        .filter(rule => {
          const m = rule.match(/\bid="([^"]+)"/);
          return m ? !globalIds.has(m[1]) : true;
        })
        .join('\n');

      nonContextBlock = `\n<nonContextRules>\n${existingContent}${deduped.trim() ? '\n' + deduped : ''}\n</nonContextRules>`;
    } else {
      // Filtrar cleanedNonContext contra ids globales incluso sin existing block
      const deduped = (cleanedNonContext.match(/<nonContextRule(?![a-zA-Z])[\s\S]*?<\/nonContextRule>/g) || [])
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

  // contextRules with a real rulesContext go as siblings, one per schema:
  // blocks with the same rulesContext (already in the project's "Schema
  // location" form) are joined in BRDP order where the first one was
  // (mergeContextBlocks, src/utils/ruleWrappers.js; see assembleChunks()
  // in generateBREX.js). They must come after the generic <contextRules>
  // and before nonContextBlock (schema sequence is contextRules* then
  // nonContextRules?).
  const mergedBlocks = mergeContextBlocks(contextRulesBlocks, 'BREX-4.1');
  const contextRulesSiblings = mergedBlocks.length ? '\n' + mergedBlocks.join('\n') : '';

  // Ensamblar footer correcto
  const footer = `\n</structureObjectRuleGroup>\n</contextRules>${contextRulesSiblings}${nonContextBlock}\n</brex>\n</content>\n</dmodule>`;

  return stripped + '\n' + (cleanedStructure || '') + footer;
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
  const pickIfValid = (v, p, d) => { const u = up(v); return (typeof u === 'string' && p.test(u)) ? u : d; };
  const mic = up(cfg.modelIdentCode);
  return {
    modelIdentCode: (typeof mic === 'string' && /^[A-Z0-9]{2,14}$/.test(mic)) ? mic : (mic || 'UNKNOWN'),
    systemDiffCode: pickIfValid(cfg.systemDiffCode, /^[A-Z0-9]{1,4}$/, 'A'),
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

// Reviewed against multiple <contextRules> siblings -- none of these
// functions reference "contextRules" at all, see finalizeDocument() in
// generateBREX.js for the full reasoning (identical here).
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
// identical to 4.2's, only structureObjectRule/nonContextRule differ (no
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
<contextRules>
<structureObjectRuleGroup>
</structureObjectRuleGroup>
</contextRules>
</brex>
</content>
</dmodule>`;
}

// Safe with multiple <contextRules> siblings -- see pruneEmptyContainers()
// in generateBREX.js for the full rationale (identical here).
function pruneEmptyContainers41(xml) {
  xml = xml.replace(/<structureObjectRuleGroup>\s*<\/structureObjectRuleGroup>/g, '');
  xml = xml.replace(/<contextRules\b[^>]*>\s*<\/contextRules>/g, '');
  return xml;
}

// Pure deterministic assembler -- no LLM call, ever. See generateBREX.js's
// generateBREX() for the full design rationale (identical here, only the
// element vocabulary differs).
export async function generateBREX41(brdps, projectConfig, options = {}) {
  const {
    onlyValidated = true,
    includeDrafts = false,
    approvals: approvalsOverride,
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

  // The caller passes the project's rule approvals for this format
  // (GeneratePage.jsx loads them from /api/projects/{id}/approvals/{format}/export).
  if (!approvalsOverride) throw new Error("The project's rule approvals are required to generate.");
  const approvalById = approvalsOverride instanceof Map
    ? approvalsOverride
    : new Map(approvalsOverride.map((a) => [a.brdp_id, a]));

  const approvedBRDPs = [];
  const unapprovedBRDPs = [];
  for (const brdp of targetBRDPs) {
    if (ruleEnters(approvalById.get(brdp.id), includeDrafts)) approvedBRDPs.push(brdp);
    else unapprovedBRDPs.push(brdp);
  }

  // Schema URLs follow the project's CURRENT "Schema location" (output only;
  // the stored rules are never changed): context blocks and allowed values
  // recognized as schema URLs are rewritten, the rest is reported
  // (src/utils/ruleSchemaContext.js, rewriteRuleSchemaUrls).
  const schemaLocation = schemaLocationOf(projectConfig, 'S1000D 4.1');
  let schemaUrls = { location: schemaLocation, rewritten: [], unrecognized: [], mixed: [] };
  let multiPath = { split: [], invalid: [] };
  let duplicateIds = { numbered: [], clashes: [] };
  const schemaRewrite = (list) => {
    const r = rewriteApprovedRulesSchemaUrls(
      list.map((b) => ({ id: b.id, identifier: b.identifier || b.id, xml: approvalById.get(b.id).rule_xml })),
      'BREX-4.1',
      'S1000D 4.1',
      schemaLocation
    );
    schemaUrls = r.schemaUrls;
    // Mejoras A, Part 3: one objectPath per rule element in the output.
    const s = splitApprovedRulesMultiPath(r.rules, 'BREX-4.1');
    multiPath = s.multiPath;
    // Mejoras B, Part 4.3: one id per rule element (xs:ID).
    const d = numberApprovedRulesDuplicateIds(s.rules, 'BREX-4.1');
    duplicateIds = d.duplicateIds;
    return d.rules;
  };

  let finalXml = buildEmptyDocument41(projectConfig, schemaSummary);

  if (approvedBRDPs.length > 0) {
    const approvedXml = schemaRewrite(approvedBRDPs).map((r) => r.xml).join('\n');
    finalXml = assembleChunks41(finalXml, approvedXml);
  }

  finalXml = pruneEmptyContainers41(finalXml);

  if (unapprovedBRDPs.length > 0) {
    const comments = unapprovedBRDPs
      .map(pendingApprovalComment)
      .join('\n');
    finalXml = finalXml.replace('</brex>', comments + '\n</brex>');
  }

  finalXml = finalizeDocument41(finalXml, projectConfig, schemaSummary);
  finalXml = setDmoduleSchemaLocation(finalXml, schemaContextUrl('S1000D 4.1', 'brex', schemaLocation));

  const { valid, error } = checkWellFormed(finalXml);

  // Safety net (HR7): never expected -- the general block has no scope
  // attribute -- but reported if an empty one ever reaches the output.
  const emptyContextBlocks = countEmptySchemaContextBlocks(finalXml);

  return { xml: finalXml, valid, error, brdpCount: targetBRDPs.length, ruleCount: approvedBRDPs.length, schemaUrls, emptyContextBlocks, multiPath, duplicateIds };
}
