import { checkWellFormed } from "./generateBREX.js";
import { getApprovalsForFormat } from "./approvals.js";

let _schemaSummaryCache301 = null;

export async function loadSchemaSummary301() {
  if (_schemaSummaryCache301) return _schemaSummaryCache301;
  const res = await fetch("/brex-schema-summary-3-0-1.json?v=" + Date.now());
  if (!res.ok) throw new Error("Failed to load brex-schema-summary-3-0-1.json");
  _schemaSummaryCache301 = await res.json();
  return _schemaSummaryCache301;
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

const MAX_RETRIES_301 = 2;

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

export async function generateSingleRule301(brdp, projectConfig, schemaSummary, callLLM) {
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

// Deterministic empty document skeleton for S1000D 3.0.1 -- built directly
// from projectConfig per the element order in the STRICT RULES this file's
// prompts used to enforce on the LLM (dmaddres: dmc -> dmtitle -> issno ->
// issdate -> language; status: security -> rpc -> orig -> applic -> brexref
// -> qa) and cross-checked against sources/S3.0.1/brex.xsd directly. avee
// children are emitted as empty self-closing placeholders -- forceAveeFields301
// (already run by finalizeDocument301) fills both the ident dmc/avee and the
// brexref/refdm/avee self-reference identically, exactly as it already does
// for LLM-authored avee tags, so the values aren't duplicated here.
// <contextrules> is always present (S1000D 3.0.1's <brex> requires at least
// one), but its <structrules> child (which itself requires at least one
// <objrule> when present) starts empty and is pruned away by
// pruneEmptyContainers301 if no approved BRDP produced one.
function esc301(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const AVEE_PLACEHOLDER_301 =
  '<modelic/><sdc/><chapnum/><section/><subsect/><subject/><discode/><discodev/><incode/><incodev/><itemloc/>';

function buildEmptyDocument301(projectConfig, schemaSummary) {
  const cfg = projectConfig || {};
  const languageIsoCode = esc301(cfg.languageIsoCode || 'en');
  const countryIsoCode = esc301(cfg.countryIsoCode || 'US');
  const issueNumber = esc301(cfg.issueNumber || '001');
  const inWork = esc301(cfg.inWork || '00');
  const securityClassification = esc301(cfg.securityClassification || '01');
  const enterpriseCode = esc301(cfg.enterpriseCode || '');
  const projectName = esc301(cfg.projectName || cfg.modelIdentCode || 'Project');
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  const openingTag = (schemaSummary && schemaSummary.dmodule_opening_tag) || '<dmodule>';
  const rpcAttr = enterpriseCode ? ` rpcname="${enterpriseCode}"` : '';
  const origAttr = enterpriseCode ? ` origname="${enterpriseCode}"` : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
${openingTag}
<idstatus>
<dmaddres>
<dmc><avee>${AVEE_PLACEHOLDER_301}</avee></dmc>
<dmtitle><techname>${projectName}</techname><infoname>Business rules</infoname></dmtitle>
<issno issno="${issueNumber}" inwork="${inWork}" type="new"/>
<issdate year="${year}" month="${month}" day="${day}"/>
<language language="${languageIsoCode}" country="${countryIsoCode}"/>
</dmaddres>
<status>
<security class="${securityClassification}"/>
<rpc${rpcAttr}>${enterpriseCode}</rpc>
<orig${origAttr}>${enterpriseCode}</orig>
<applic><displaytext><p>All</p></displaytext></applic>
<brexref><refdm><avee>${AVEE_PLACEHOLDER_301}</avee></refdm></brexref>
<qa><unverif/></qa>
</status>
</idstatus>
<content>
<brex>
<contextrules>
<structrules>
</structrules>
</contextrules>
</brex>
</content>
</dmodule>`;
}

function pruneEmptyContainers301(xml) {
  return xml.replace(/<structrules>\s*<\/structrules>/g, '');
}

// Pure deterministic assembler -- no LLM call, ever. See generateBREX.js's
// generateBREX() for the full design rationale. generateSingleRule301 and
// the prompt builders above still exist, unchanged, for the BRDP Assistant's
// "Suggest Rule" mode and for generateBREXSch.js (which reuses this same
// function with approvalsFormat: 'SCH-S1000D' -- its simplification is
// inherited automatically from this one, nothing else needed there).
export async function generateBREX301(brdps, projectConfig, options = {}) {
  const {
    onlyValidated = true,
    approvals: approvalsOverride,
    approvalsFormat = 'BREX-3.0.1',
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

  const schemaSummary = schemaSummaryOverride || (await loadSchemaSummary301());

  const approvalById = approvalsOverride
    ? (approvalsOverride instanceof Map ? approvalsOverride : new Map(approvalsOverride.map((a) => [a.brdp_id, a])))
    : await fetchApprovalsMap301(approvalsFormat);

  const approvedBRDPs = [];
  const unapprovedBRDPs = [];
  for (const brdp of targetBRDPs) {
    if (approvalById.get(brdp.id)?.status === 'approved') approvedBRDPs.push(brdp);
    else unapprovedBRDPs.push(brdp);
  }

  let finalXml = buildEmptyDocument301(projectConfig, schemaSummary);

  if (approvedBRDPs.length > 0) {
    const approvedXml = approvedBRDPs.map((b) => approvalById.get(b.id).rule_xml).join('\n');
    finalXml = assembleChunks301(finalXml, approvedXml);
  }

  finalXml = pruneEmptyContainers301(finalXml);

  if (unapprovedBRDPs.length > 0) {
    const comments = unapprovedBRDPs
      .map((b) => `<!-- ${b.id}: pendiente de aprobación de regla, no incluida en este documento -->`)
      .join('\n');
    finalXml = finalXml.replace('</brex>', comments + '\n</brex>');
  }

  finalXml = finalizeDocument301(finalXml, projectConfig, schemaSummary);

  const { valid, error } = checkWellFormed(finalXml);

  return { xml: finalXml, valid, error, brdpCount: targetBRDPs.length };
}
