import { ruleEnters } from '../utils/generatePlan.js';
import { checkWellFormed, pendingApprovalComment } from "./generateBREX.js";
import { getApprovalsForFormat } from "./approvals.js";
import { mergeContextBlocks, splitRuleXmlPieces } from "../utils/ruleWrappers.js";
import { countEmptySchemaContextBlocks, rewriteApprovedRulesSchemaUrls, schemaContextUrl, schemaLocationOf, setDmoduleSchemaLocation } from "../utils/ruleSchemaContext.js";

let _schemaSummaryCache301 = null;

export async function loadSchemaSummary301() {
  if (_schemaSummaryCache301) return _schemaSummaryCache301;
  const res = await fetch("/brex-schema-summary-3-0-1.json?v=" + Date.now());
  if (!res.ok) throw new Error("Failed to load brex-schema-summary-3-0-1.json");
  _schemaSummaryCache301 = await res.json();
  return _schemaSummaryCache301;
}

function sanitizeNonContextComments301(xml) {
  // Un comentario XML no puede contener "--". Colapsamos runs de guiones y normalizamos.
  return xml.replace(/<!--([\s\S]*?)-->/g, (full, inner) => {
    const clean = inner.replace(/--+/g, '-').trim();
    return `<!-- ${clean} -->`;
  });
}

function assembleChunks301(baseXml, additionalRules) {
  // S1000D 3.0.1 ALSO allows multiple <contextrules context="..."> as
  // siblings under <brex> -- confirmed directly against
  // sources/S3.0.1/brex.xsd (brexType: contextrules maxOccurs="unbounded"),
  // same mechanism as 4.x's contextRules/rulesContext, just lowercase
  // element/attribute names and "context" instead of "rulesContext". Not
  // dead code: this is the real 3.0.1 equivalent, not an assumption.
  // The rules are taken apart by splitRuleXmlPieces (src/utils/
  // ruleWrappers.js, the same scan the Excel import and
  // normalize_rule_wrappers.py use to store them clean): complete
  // <contextrules context="..."> blocks whole (a <contextrules> without a
  // context is the generic container, only a wrapper), and every objrule
  // and nonContextRule comment wherever it sits, in document order
  // (traceability), so a legacy wrapper (<rules>, a bare <structrules>)
  // never hides one.
  const contextRulesBlocks = [];
  const pieces = [];
  for (const piece of splitRuleXmlPieces(additionalRules, 'BREX-3.0.1')) {
    if (piece.kind === 'block') contextRulesBlocks.push(piece.text);
    else if (piece.kind === 'rule') pieces.push(piece.text);
    else if (piece.kind === 'noncontext') pieces.push(sanitizeNonContextComments301(piece.text));
  }
  // One block per schema: blocks with the same context (already in the
  // project's "Schema location" form) are joined in BRDP order where the
  // first one was (mergeContextBlocks, src/utils/ruleWrappers.js).
  const mergedBlocks = mergeContextBlocks(contextRulesBlocks, 'BREX-3.0.1');
  const contextRulesSiblings = mergedBlocks.length ? '\n' + mergedBlocks.join('\n') : '';
  if (!pieces.length && !contextRulesBlocks.length) return baseXml;

  // Insertar las piezas sueltas justo antes de </structrules> para
  // preservar todo lo que ya hay dentro, luego los bloques con contexto
  // como hermanos justo después del </contextrules> genérico que ya
  // cerró (uno por esquema, ya unidos arriba).
  const idx = baseXml.lastIndexOf('</structrules>');
  if (idx !== -1) {
    let assembled = baseXml.slice(0, idx) + (pieces.length ? pieces.join('\n') + '\n' : '') + baseXml.slice(idx);
    if (contextRulesSiblings) {
      const genericCloseIdx = assembled.indexOf('</contextrules>', idx);
      const insertAt = genericCloseIdx !== -1 ? genericCloseIdx + '</contextrules>'.length : -1;
      if (insertAt !== -1) {
        assembled = assembled.slice(0, insertAt) + contextRulesSiblings + assembled.slice(insertAt);
      }
    }
    return assembled;
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
  return (
    stripped +
    '\n' +
    (pieces.length ? pieces.join('\n') + '\n' : '') +
    '</structrules>\n</contextrules>' +
    contextRulesSiblings +
    '\n</brex>\n</content>\n</dmodule>'
  );
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
  const pickIfValid = (val, pattern, def) =>
    (typeof val === 'string' && pattern.test(val)) ? val : def;
  return {
    modelic:  pickIfValid(cfg.modelIdentCode, /^[A-Za-z0-9]{2,14}$/, cfg.modelIdentCode || 'UNKNOWN'),
    sdc:      pickIfValid(cfg.systemDiffCode, /^[A-Za-z0-9]{1,4}$/, 'A'),
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

// Reviewed against multiple <contextrules> siblings (assembleChunks301()'s
// context-scoped blocks): none of these functions reference "contextrules"
// at all, they operate on dmodule/objrule/avee elements/comments directly
// with global (/g) regexes, so which <contextrules> parent an objrule sits
// under is irrelevant to any of them.
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
// pruneEmptyContainers301 if no approved BRDP produced one. Additional
// <contextrules context="..."> siblings can appear alongside this generic
// one -- extracted verbatim from an approved BRDP's rule_xml by
// assembleChunks301() (brex.xsd confirms contextrules maxOccurs="unbounded",
// same mechanism as 4.x's contextRules/rulesContext) -- this generic one is
// unaffected either way.
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

// Safe with multiple <contextrules> siblings now possible
// (assembleChunks301()'s context-scoped blocks): `>\s*<` between open/close
// with no [\s\S]* wildcard means this can only match a genuinely empty
// <structrules></structrules> pair, wherever it occurs -- it never spans
// into a different, content-bearing block. A freshly-extracted context
// block always carries the real content it was extracted with, so its own
// <structrules> (if it has one) is never empty either.
function pruneEmptyContainers301(xml) {
  return xml.replace(/<structrules>\s*<\/structrules>/g, '');
}

// Pure deterministic assembler -- no LLM call, ever. See generateBREX.js's
// generateBREX() for the full design rationale. generateBREXSch.js can
// reuse this same function, or generateBREX41/generateBREX depending on the
// project's real standard, as its base generator.
export async function generateBREX301(brdps, projectConfig, options = {}) {
  const {
    onlyValidated = true,
    includeDrafts = false,
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
    if (ruleEnters(approvalById.get(brdp.id), includeDrafts)) approvedBRDPs.push(brdp);
    else unapprovedBRDPs.push(brdp);
  }

  // Schema URLs follow the project's CURRENT "Schema location" (output only;
  // the stored rules are never changed): context blocks and allowed values
  // recognized as schema URLs are rewritten, the rest is reported
  // (src/utils/ruleSchemaContext.js, rewriteRuleSchemaUrls).
  const schemaLocation = schemaLocationOf(projectConfig, 'S1000D 3.0.1');
  let schemaUrls = { location: schemaLocation, rewritten: [], unrecognized: [], mixed: [] };
  const schemaRewrite = (list) => {
    const r = rewriteApprovedRulesSchemaUrls(
      list.map((b) => ({ id: b.id, identifier: b.identifier || b.id, xml: approvalById.get(b.id).rule_xml })),
      'BREX-3.0.1',
      'S1000D 3.0.1',
      schemaLocation
    );
    schemaUrls = r.schemaUrls;
    return r.rules;
  };

  let finalXml = buildEmptyDocument301(projectConfig, schemaSummary);

  if (approvedBRDPs.length > 0) {
    const approvedXml = schemaRewrite(approvedBRDPs).map((r) => r.xml).join('\n');
    finalXml = assembleChunks301(finalXml, approvedXml);
  }

  finalXml = pruneEmptyContainers301(finalXml);

  if (unapprovedBRDPs.length > 0) {
    const comments = unapprovedBRDPs
      .map(pendingApprovalComment)
      .join('\n');
    finalXml = finalXml.replace('</brex>', comments + '\n</brex>');
  }

  finalXml = finalizeDocument301(finalXml, projectConfig, schemaSummary);
  finalXml = setDmoduleSchemaLocation(finalXml, schemaContextUrl('S1000D 3.0.1', 'brex', schemaLocation));

  const { valid, error } = checkWellFormed(finalXml);

  // Safety net (HR7): never expected -- the general block has no scope
  // attribute -- but reported if an empty one ever reaches the output.
  const emptyContextBlocks = countEmptySchemaContextBlocks(finalXml);

  return { xml: finalXml, valid, error, brdpCount: targetBRDPs.length, ruleCount: approvedBRDPs.length, schemaUrls, emptyContextBlocks };
}
