import { ruleEnters } from '../utils/generatePlan.js';
import { wrapRuleXmlFragment } from "../utils/ruleXmlFragment.js";
import { mergeContextBlocks, splitRuleXmlPieces } from "../utils/ruleWrappers.js";
import { numberApprovedRulesDuplicateIds, splitApprovedRulesMultiPath } from "../utils/ruleSplit.js";
import { countEmptySchemaContextBlocks, rewriteApprovedRulesSchemaUrls, schemaContextUrl, schemaLocationOf, setDmoduleSchemaLocation } from "../utils/ruleSchemaContext.js";

let _schemaSummaryCache = null;

async function loadSchemaSummary() {
  if (_schemaSummaryCache) return _schemaSummaryCache;
  const res = await fetch("/brex-schema-summary-4-2.json?v=" + Date.now());
  if (!res.ok) throw new Error("Could not load brex-schema-summary-4-2.json");
  _schemaSummaryCache = await res.json();
  return _schemaSummaryCache;
}

// wrapRuleXmlFragment lives in src/utils/ruleXmlFragment.js (pure, no API
// imports) so the rule test engine can use it too; re-exported here for the
// existing callers.
export { wrapRuleXmlFragment };

// Comment left in the generated BREX for a BRDP without a Verified rule
// (shared by the 4.2, 4.1 and 3.0.1 generators). Uses the BRDP's identifier
// (BRDP-EXT-00031), never its internal UUID (brdp.id), and is in English
// like the rest of the generated document. An identifier is user data, so
// "--" (never legal inside an XML comment) and a trailing "-" are neutralized.
export function pendingApprovalComment(brdp) {
  const identifier = String(brdp.identifier || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/-{2,}/g, '—')
    .replace(/-+$/, '')
    .trim();
  return `<!-- ${identifier}: rule pending approval, not included in this document -->`;
}

export function checkWellFormed(xmlString) {
  try {
    const parser = new DOMParser();
    // A rule_xml fragment (never has an <?xml ...?> declaration, unlike a
    // full assembled document) can legitimately have multiple XML-sibling
    // roots since this round's rulesContext support -- a loose
    // <structureObjectRule> alongside one or more complete
    // <contextRules rulesContext="..."> blocks in the very same cell (e.g.
    // BRDP-S1-00006). Confirmed empirically that DOMParser otherwise
    // rejects that with "Extra content at the end of the document", same
    // as lxml server-side (see _xml_well_formed_error in approvals.py) --
    // wrapping in a throwaway <root> fixes it for fragments without
    // changing anything for a real document (detected by its <?xml
    // declaration), which already always has exactly one root and is
    // parsed unwrapped, unchanged from before.
    const isFragment = !xmlString.trim().startsWith("<?xml");
    const toParse = isFragment ? wrapRuleXmlFragment(xmlString) : xmlString;
    const doc = parser.parseFromString(toParse, "application/xml");
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

// Parses one approved BRDP's rule_xml fragment into a throwaway <root>
// wrapper element -- same wrapping trick checkWellFormed() already uses,
// needed for exactly the same reason: a fragment can legitimately have
// several XML-sibling roots (a loose <structureObjectRule> alongside one or
// more complete <contextRules rulesContext="..."> blocks, e.g.
// BRDP-S1-00006's real Lufthansa data), which a parser rejects unwrapped.
// Throws a clear, BRDP-attributed error on malformed input instead of
// letting a single corrupt fragment silently corrupt the whole assembled
// document (or, with the old regex approach, corrupt unrelated content via
// a runaway match) -- the caller (assembleChunks) lets this propagate so
// generateBREX() fails loudly, naming the one responsible BRDP, rather than
// returning a document that looks fine but is quietly missing or mangled.
function parseRuleFragment(brdpId, xmlFragment) {
  const doc = new DOMParser().parseFromString(`<root>${xmlFragment}</root>`, 'application/xml');
  const parserError = doc.querySelector('parsererror');
  if (parserError) {
    const msg = (parserError.textContent || 'XML is not well-formed').split('\n')[0].trim();
    throw new Error(`Malformed rule_xml for ${brdpId}: ${msg}`);
  }
  return doc.documentElement;
}

// DOM-based assembler -- replaces an earlier regex/text-splicing
// implementation that mis-extracted <structureObjectRule> as a prefix match
// inside <structureObjectRuleGroup> (real bug, Lufthansa 78-BRDP BREX,
// fixed with an anchor as a stopgap; see git history). Operating on real
// parsed nodes instead of substrings removes that whole bug class: a tag
// name can never again be confused with another tag name that happens to
// start with the same characters.
//
// approvedRules: array of { id, xml } -- one entry per approved BRDP,
// parsed individually (rather than one giant pre-joined string) so a
// malformed rule_xml is attributed to the exact BRDP that produced it.
//
// Mutates and returns baseDoc (a Document already parsed from
// buildEmptyDocument()'s output) rather than a string -- the caller
// serializes once, after every BRDP has been placed.
function assembleChunks(baseDoc, approvedRules) {
  // S1000D 4.2 allows multiple <contextRules rulesContext="..."> as
  // siblings under <brex> (brex4.2.xsd: contextRules maxOccurs="unbounded"),
  // each scoped to a specific schema (e.g. proced.xsd, fault.xsd). A real
  // approved BRDP's rule_xml can carry one of these complete blocks
  // (extracted from a real customer BREX, e.g. Lufthansa) alongside or
  // instead of a loose structureObjectRule/nonContextRule.
  const structureNodes = [];
  const nonContextNodes = [];
  const contextRulesNodes = [];
  const contextBlockTexts = [];

  for (const { id, xml } of approvedRules) {
    if (!xml || !xml.trim()) continue;
    // Well-formedness first, attributed to this BRDP.
    parseRuleFragment(id, xml);

    // Real hand-authored rule_xml (confirmed against the actual Lufthansa
    // 78-BRDP dataset) doesn't always put structureObjectRule/
    // nonContextRule as DIRECT children of the fragment -- some rows wrap
    // them in an extra container of their own (a bare <rules>, or even a
    // stray <structureObjectRuleGroup>) that has no meaning here. The
    // fragment is taken apart by splitRuleXmlPieces (src/utils/
    // ruleWrappers.js, the same scan the Excel import and
    // normalize_rule_wrappers.py use to store rules clean): complete
    // <contextRules rulesContext="..."> blocks whole (nothing inside them
    // taken again as a loose rule), and every structureObjectRule /
    // nonContextRule wherever it sits. A <contextRules> with an empty or
    // missing rulesContext is only a wrapper, never a block: its rules go
    // into buildEmptyDocument()'s own general <contextRules> (no attribute
    // -- s1kd-brexcheck applies a block only if it has no rulesContext or
    // it equals the DM's schema, so rulesContext="" would apply nowhere).
    // Each piece is parsed on its own.
    for (const piece of splitRuleXmlPieces(xml, 'BREX-4.2')) {
      if (piece.kind === 'comment') continue;
      const node = parseRuleFragment(id, piece.text).firstElementChild;
      if (piece.kind === 'block') contextBlockTexts.push({ id, text: piece.text });
      else if (piece.kind === 'rule') structureNodes.push(node);
      else nonContextNodes.push(node);
    }
  }

  // One block per schema: blocks with the same rulesContext (already in the
  // project's "Schema location" form) are joined, in BRDP order, where the
  // first of them was (mergeContextBlocks, src/utils/ruleWrappers.js).
  // Each merged block is parsed again; a block's own text was already
  // checked above, so a failure here can only come from the merge.
  const blockTexts = mergeContextBlocks(contextBlockTexts.map((b) => b.text), 'BREX-4.2');
  for (const text of blockTexts) {
    contextRulesNodes.push(parseRuleFragment('merged context block', text).firstElementChild);
  }

  if (!structureNodes.length && !nonContextNodes.length && !contextRulesNodes.length) return baseDoc;

  const genericContextRules = baseDoc.querySelector('contextRules:not([rulesContext])');
  const group = genericContextRules.querySelector('structureObjectRuleGroup');

  // Loose structureObjectRule nodes go into the generic group, inserted
  // before its existing (whitespace-only) last child so that trailing
  // whitespace still ends up right before </structureObjectRuleGroup>.
  const groupTrailingNode = group.lastChild;
  structureNodes.forEach((node, i) => {
    group.insertBefore(baseDoc.createTextNode(i === 0 ? '\n\n' : '\n'), groupTrailingNode);
    group.insertBefore(baseDoc.importNode(node, true), groupTrailingNode);
  });

  const brexEl = baseDoc.querySelector('brex');
  const brexTrailingNode = brexEl.lastChild;

  // The <contextRules rulesContext="..."> blocks, already merged into one
  // per schema above. brex4.2.xsd would permit repeated blocks for the same
  // schema (maxOccurs="unbounded"), but a real BREX has one per schema and
  // the round trip original -> AI Extract -> Generate must give that back
  // (Lufthansa: one proced block with 4 rules, not 4 blocks of 1). They
  // must come AFTER the generic
  // <contextRules> and BEFORE nonContextRules: brexElemType's sequence is
  // contextRules* then nonContextRules? (also confirmed against the
  // schema) -- nonContextRules can never precede a contextRules sibling.
  for (const crNode of contextRulesNodes) {
    brexEl.insertBefore(baseDoc.createTextNode('\n'), brexTrailingNode);
    brexEl.insertBefore(baseDoc.importNode(crNode, true), brexTrailingNode);
  }

  if (nonContextNodes.length) {
    // "Already present in the document" dedup -- ids that existed in
    // baseDoc BEFORE this call (never any, in practice, since
    // buildEmptyDocument()'s skeleton carries no rule elements; kept for
    // parity with the original safety net in case that ever changes).
    // Same-batch duplicates across approvedRules are intentionally NOT
    // deduped here -- that is dedupeNonContextRules()'s job, applied
    // globally after assembly, in finalizeDocument().
    const globalIds = new Set(
      Array.from(baseDoc.querySelectorAll('[id]')).map((el) => el.getAttribute('id'))
    );
    const toAdd = nonContextNodes.filter((node) => {
      const nid = node.getAttribute('id');
      return !nid || !globalIds.has(nid);
    });

    if (toAdd.length) {
      let ncContainer = baseDoc.querySelector('nonContextRules');
      if (ncContainer) {
        // Pre-existing container (dead path today -- buildEmptyDocument()
        // never emits one -- kept only so this never crashes if that
        // changes): append after its current content.
        const ncTrailingNode = ncContainer.lastChild;
        for (const node of toAdd) {
          ncContainer.insertBefore(baseDoc.createTextNode('\n'), ncTrailingNode);
          ncContainer.insertBefore(baseDoc.importNode(node, true), ncTrailingNode);
        }
      } else {
        ncContainer = baseDoc.createElement('nonContextRules');
        ncContainer.appendChild(baseDoc.createTextNode('\n'));
        toAdd.forEach((node, i) => {
          if (i > 0) ncContainer.appendChild(baseDoc.createTextNode('\n'));
          ncContainer.appendChild(baseDoc.importNode(node, true));
        });
        ncContainer.appendChild(baseDoc.createTextNode('\n'));
        brexEl.insertBefore(baseDoc.createTextNode('\n'), brexTrailingNode);
        brexEl.insertBefore(ncContainer, brexTrailingNode);
      }
    }
  }

  return baseDoc;
}

// Serializing the whole Document (rather than splicing strings) can
// reorder the <dmodule> root's own attributes (confirmed empirically:
// Chrome's XMLSerializer groups xmlns:* declarations separately from plain
// attributes) -- harmless here because forceDmoduleTag() (finalizeDocument,
// called right after this) unconditionally overwrites that entire opening
// tag with schemaSummary's exact literal string regardless of what this
// produced. The one difference serialization does NOT self-heal anywhere
// else in the pipeline is dropping the newline between the XML declaration
// and <dmodule -- restored explicitly here.
function serializeDocument(doc) {
  const xml = new XMLSerializer().serializeToString(doc);
  return xml.replace(/(<\?xml[^>]*\?>)\s*(<dmodule\b)/, '$1\n$2');
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

// Reviewed against the possibility of multiple <contextRules> siblings
// (assembleChunks()'s rulesContext blocks): none of forceDmoduleTag/
// forceIssueType/fixFlagPlacement/promoteOrphanSplitRules/forceDmCodeFields/
// dropRedundantNonContextRules/dedupeNonContextRules reference the literal
// string "contextRules" at all -- they operate on dmodule/dmStatus/dmCode/
// structureObjectRule/nonContextRule elements directly, scanning the whole
// document with global (/g) regexes, so which <contextRules> parent a rule
// happens to sit under is irrelevant to any of them. No single-container
// assumption exists here to fix.
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

// Deterministic empty document skeleton -- everything the LLM used to author
// in "chunk 1" (identAndStatusSection, dmStatus boilerplate, empty rule
// containers), built directly from projectConfig + schemaSummary. Ident
// fields go through resolveDmCodeFields() (already exists for correcting an
// LLM-authored dmCode) so both the ident dmCode and the brexDmRef self-
// reference dmCode always match. structureObjectRuleGroup starts empty --
// pruneEmptyContainers() removes it afterward if no BRDP ends up there.
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildEmptyDocument(projectConfig, schemaSummary) {
  const cfg = projectConfig || {};
  const dmCodeFields = resolveDmCodeFields(cfg);
  const dmCodeAttrs = Object.entries(dmCodeFields).map(([k, v]) => `${k}="${esc(v)}"`).join(' ');
  const languageIsoCode = esc(cfg.languageIsoCode || 'en');
  const countryIsoCode = esc(cfg.countryIsoCode || 'US');
  const issueNumber = esc(cfg.issueNumber || '001');
  const inWork = esc(cfg.inWork || '00');
  const securityClassification = esc(cfg.securityClassification || '01');
  const enterpriseCode = esc(cfg.enterpriseCode || '');
  const projectName = esc(cfg.projectName || cfg.modelIdentCode || 'Project');
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

// contextRules/structureObjectRuleGroup are optional under <brex> -- if no
// approved BRDP produced a structureObjectRule (e.g. every approval was a
// nonContextRule, or there were none at all), an empty
// structureObjectRuleGroup would violate its own required-child schema rule,
// so it (and then contextRules, if that leaves it empty too) is dropped
// rather than left dangling-empty. Safe with multiple <contextRules> now
// possible (assembleChunks()'s rulesContext-scoped siblings): the regex
// requires `>\s*<` immediately between open and close tags (no [\s\S]*
// wildcard), so it can only ever match a genuinely empty pair -- it cannot
// span across a real, content-bearing sibling to falsely "empty out" two
// adjacent blocks together, and a freshly-extracted rulesContext block is
// never empty in the first place (it always carries the real content it
// was extracted with), so it never matches this pattern regardless.
function pruneEmptyContainers(xml) {
  xml = xml.replace(/<structureObjectRuleGroup>\s*<\/structureObjectRuleGroup>/g, '');
  xml = xml.replace(/<contextRules\b[^>]*>\s*<\/contextRules>/g, '');
  return xml;
}

// Pure deterministic assembler -- no LLM call, ever. For the active format,
// takes only the BRDPs with a frozen 'approved' rule_approvals row and
// injects their rule_xml verbatim; every other Validated BRDP is left out of
// the document as a plain XML comment (never nonContextRule -- that element
// has a specific S1000D meaning, "no clear XPath target", which does not
// apply here; the reason is simply "not approved yet").
export async function generateBREX(brdps, projectConfig, options = {}) {
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

  const schemaSummary = schemaSummaryOverride || (await loadSchemaSummary());

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
  const schemaLocation = schemaLocationOf(projectConfig, 'S1000D 4.2');
  let schemaUrls = { location: schemaLocation, rewritten: [], unrecognized: [], mixed: [] };
  let multiPath = { split: [], invalid: [] };
  let duplicateIds = { numbered: [], clashes: [] };
  const schemaRewrite = (list) => {
    const r = rewriteApprovedRulesSchemaUrls(
      list.map((b) => ({ id: b.id, identifier: b.identifier || b.id, xml: approvalById.get(b.id).rule_xml })),
      'BREX-4.2',
      'S1000D 4.2',
      schemaLocation
    );
    schemaUrls = r.schemaUrls;
    // Mejoras A, Part 3: one objectPath per rule element in the output.
    const s = splitApprovedRulesMultiPath(r.rules, 'BREX-4.2');
    multiPath = s.multiPath;
    // Mejoras B, Part 4.3: one id per rule element (xs:ID).
    const d = numberApprovedRulesDuplicateIds(s.rules, 'BREX-4.2');
    duplicateIds = d.duplicateIds;
    return d.rules;
  };

  let finalXml = buildEmptyDocument(projectConfig, schemaSummary);

  if (approvedBRDPs.length > 0) {
    const approvedRules = schemaRewrite(approvedBRDPs).map((r) => ({ id: r.id, xml: r.xml }));
    const baseDoc = new DOMParser().parseFromString(finalXml, 'application/xml');
    assembleChunks(baseDoc, approvedRules);
    finalXml = serializeDocument(baseDoc);
  }

  finalXml = pruneEmptyContainers(finalXml);

  if (unapprovedBRDPs.length > 0) {
    const comments = unapprovedBRDPs
      .map(pendingApprovalComment)
      .join('\n');
    finalXml = finalXml.replace('</brex>', comments + '\n</brex>');
  }

  // Still applied for defense-in-depth over the assembled content (e.g. a
  // manually-approved rule with a misplaced allowedObjectFlag, or two
  // approvals colliding on an orphan split suffix) -- every field it forces
  // is already correct by construction in buildEmptyDocument, so this is a
  // safety net, not a correction of LLM output.
  finalXml = finalizeDocument(finalXml, projectConfig, schemaSummary);
  finalXml = setDmoduleSchemaLocation(finalXml, schemaContextUrl('S1000D 4.2', 'brex', schemaLocation));

  const { valid, error } = checkWellFormed(finalXml);

  // Safety net (HR7): never expected -- the general block has no scope
  // attribute -- but reported if an empty one ever reaches the output.
  const emptyContextBlocks = countEmptySchemaContextBlocks(finalXml);

  return { xml: finalXml, valid, error, brdpCount: targetBRDPs.length, ruleCount: approvedBRDPs.length, schemaUrls, emptyContextBlocks, multiPath, duplicateIds };
}
