import { getApprovalsForFormat } from "./approvals.js";

let _schemaSummaryCache = null;

export async function loadSchemaSummary() {
  if (_schemaSummaryCache) return _schemaSummaryCache;
  const res = await fetch("/brex-schema-summary-4-2.json?v=" + Date.now());
  if (!res.ok) throw new Error("Could not load brex-schema-summary-4-2.json");
  _schemaSummaryCache = await res.json();
  return _schemaSummaryCache;
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
    const toParse = isFragment ? `<root>${xmlString}</root>` : xmlString;
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
  // (?![a-zA-Z]) anchors the opening tag so it can't also match the
  // literal prefix "<structureObjectRule" inside "<structureObjectRuleGroup>"
  // -- confirmed real bug (Lufthansa 78-BRDP BREX): without the anchor this
  // swallows everything up to the next real </structureObjectRule>,
  // corrupting the group's own closing tag. See assembleChunks() below,
  // where the same bug caused a real "tag mismatch" well-formedness error.
  const rulePattern = /<structureObjectRule(?![a-zA-Z])[\s\S]*?<\/structureObjectRule>/g;

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

  for (const { id, xml } of approvedRules) {
    if (!xml || !xml.trim()) continue;
    const root = parseRuleFragment(id, xml);

    // Real hand-authored rule_xml (confirmed against the actual Lufthansa
    // 78-BRDP dataset) doesn't always put structureObjectRule/
    // nonContextRule as DIRECT children of the fragment -- some rows wrap
    // them in an extra container of their own (a bare <rules>, or even a
    // stray <structureObjectRuleGroup>) that has no meaning here and was
    // never part of any schema for this fragment shape. The old regex
    // extraction never cared about nesting depth at all -- it matched
    // these tags wherever they appeared in the raw text -- so
    // querySelectorAll (any depth) is used here rather than root.children
    // (one level only) to preserve that same tolerance; using children
    // instead silently dropped every rule buried in such a wrapper.
    //
    // rulesContext="" (empty) is buildEmptyDocument()'s own generic
    // container, never something an approved rule_xml fragment should
    // produce on its own -- requiring a non-empty value keeps a stray/
    // empty rulesContext in a fragment from ever being confused with the
    // skeleton's container.
    const contextBlocks = Array.from(root.querySelectorAll('contextRules')).filter((el) =>
      el.getAttribute('rulesContext')
    );
    contextBlocks.forEach((el) => contextRulesNodes.push(el));

    // A structureObjectRule/nonContextRule that legitimately lives INSIDE
    // one of the contextRules blocks just extracted (its own
    // structureObjectRuleGroup) must not also be picked up a second time
    // as a "loose" rule -- removed from a scratch clone first, mirroring
    // the old code's own two-phase approach (extract contextRules blocks,
    // strip them out of the text, THEN scan what's left for loose rules).
    const scratch = root.cloneNode(true);
    Array.from(scratch.querySelectorAll('contextRules'))
      .filter((el) => el.getAttribute('rulesContext'))
      .forEach((el) => el.remove());

    Array.from(scratch.querySelectorAll('structureObjectRule')).forEach((el) => structureNodes.push(el));
    Array.from(scratch.querySelectorAll('nonContextRule')).forEach((el) => nonContextNodes.push(el));
  }

  if (!structureNodes.length && !nonContextNodes.length && !contextRulesNodes.length) return baseDoc;

  const genericContextRules = baseDoc.querySelector('contextRules[rulesContext=""]');
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

  // Any <contextRules rulesContext="..."> blocks extracted above go as
  // their own siblings, each intact and never merged even if two BRDPs
  // share the same rulesContext value -- brex4.2.xsd permits repeated
  // <contextRules> under <brex> (maxOccurs="unbounded"), confirmed
  // directly against the schema, so grouping by rulesContext is neither
  // required nor attempted. They must come AFTER the generic
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

const MAX_RETRIES = 2;

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

export async function generateSingleRule(brdp, projectConfig, schemaSummary, callLLM) {
  const { system, user } = buildBREXPromptChunk([brdp], projectConfig, schemaSummary);
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const raw = await callLLM(system, user);
    if (!raw) continue;
    const escaped = raw.trim()
      .replace(/\s+allowedObjectFlagContext="[^"]*"/g, '')
      .replace(/<brDecisionIdentNumber brDecisionIdentNumber="([^"]+)"\/>/g, '<brDecisionRef brDecisionIdentNumber="$1"/>');
    const escapedContent = escapeXMLContent(escaped);
    const splitContent = splitMultipleObjectPaths(escapedContent);

    // Intentar structureObjectRule primero (mismo ancla que splitMultipleObjectPaths/assembleChunks)
    const ruleMatch = splitContent.match(/<structureObjectRule(?![a-zA-Z])[\s\S]*?<\/structureObjectRule>/);
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
// containers), built directly from projectConfig + schemaSummary per the
// structure spec in brex-schema-summary-4-2.json's "structure" key. Ident
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
<contextRules rulesContext="">
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
// apply here; the reason is simply "not approved yet"). generateSingleRule
// and the prompt builders above still exist and are unchanged -- they now
// serve only the BRDP Assistant's "Suggest Rule" mode (generateSuggestedRule.js),
// never this function.
export async function generateBREX(brdps, projectConfig, options = {}) {
  const {
    onlyValidated = true,
    approvals: approvalsOverride,
    approvalsFormat = 'BREX-4.2',
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

  const approvalById = approvalsOverride
    ? (approvalsOverride instanceof Map ? approvalsOverride : new Map(approvalsOverride.map((a) => [a.brdp_id, a])))
    : await fetchApprovalsMap(approvalsFormat);

  const approvedBRDPs = [];
  const unapprovedBRDPs = [];
  for (const brdp of targetBRDPs) {
    if (approvalById.get(brdp.id)?.status === 'approved') approvedBRDPs.push(brdp);
    else unapprovedBRDPs.push(brdp);
  }

  let finalXml = buildEmptyDocument(projectConfig, schemaSummary);

  if (approvedBRDPs.length > 0) {
    const approvedRules = approvedBRDPs.map((b) => ({ id: b.id, xml: approvalById.get(b.id).rule_xml }));
    const baseDoc = new DOMParser().parseFromString(finalXml, 'application/xml');
    assembleChunks(baseDoc, approvedRules);
    finalXml = serializeDocument(baseDoc);
  }

  finalXml = pruneEmptyContainers(finalXml);

  if (unapprovedBRDPs.length > 0) {
    const comments = unapprovedBRDPs
      .map((b) => `<!-- ${b.id}: pendiente de aprobación de regla, no incluida en este documento -->`)
      .join('\n');
    finalXml = finalXml.replace('</brex>', comments + '\n</brex>');
  }

  // Still applied for defense-in-depth over the assembled content (e.g. a
  // manually-approved rule with a misplaced allowedObjectFlag, or two
  // approvals colliding on an orphan split suffix) -- every field it forces
  // is already correct by construction in buildEmptyDocument, so this is a
  // safety net, not a correction of LLM output.
  finalXml = finalizeDocument(finalXml, projectConfig, schemaSummary);

  const { valid, error } = checkWellFormed(finalXml);

  return { xml: finalXml, valid, error, brdpCount: targetBRDPs.length };
}
