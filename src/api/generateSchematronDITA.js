import { sendMessageStream } from "./llmAPI.js";
import { extractXML } from "./generateBREX.js";
import { _isSafePattern } from "./brexToSchematron.js";
import { getApprovalsForFormat, proposeApproval } from "./approvals.js";

// Fixed format id this generator's frozen rule_approvals rows are stored
// under -- see ProjectConfigSection.jsx's primaryFormat options and
// CLAUDE.md's rule_approvals design (Phase 1).
const FORMAT_ID = "SCH-DITA";

let _schemaSummaryCache = null;

async function loadSchemaSummary() {
  if (_schemaSummaryCache) return _schemaSummaryCache;
  const res = await fetch("/schematron-dita-schema-summary.json?v=" + Date.now());
  if (!res.ok) throw new Error("Could not load schematron-dita-schema-summary.json");
  _schemaSummaryCache = await res.json();
  return _schemaSummaryCache;
}

function escapeXmlText(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ===== Few-shot rendering =====
// BRDP-D1-00313 is rendered from the real literal block (schematron-dita-draft.sch)
// instead of from its JSON fields, because its "test" field is a human-readable
// description ("two independent reports"), not a single valid XPath expression --
// interpolating it generically would produce broken XML.
const BRDP_00313_LITERAL = `<sch:pattern>
  <sch:rule context="topic | concept | task | map">
    <sch:report role="warning" id="BRDP-D1-00313-shortdesc" test="not(shortdesc) and not(topicmeta/shortdesc)">Missing &lt;shortdesc&gt; metadata.</sch:report>
    <sch:report role="warning" id="BRDP-D1-00313-author" test="not(.//author)">Missing &lt;author&gt; metadata.</sch:report>
  </sch:rule>
</sch:pattern>`;

// Renders a few-shot's optional "lets" field (array of {name, value}) as
// <sch:let> lines, one per entry, indented to sit right after <sch:rule
// context="...">. Returns "" when absent so every existing few-shot without
// "lets" renders byte-identical to before this field existed.
function renderSchLets(lets) {
  if (!lets || lets.length === 0) return "";
  return lets.map((l) => `    <sch:let name="${l.name}" value="${l.value}"/>\n`).join("");
}

// Most few-shot "message" values are plain prose that may mention element
// names in angle brackets for readability (e.g. "The <xref> element...") --
// escapeXmlText() turns those into proper &lt;xref&gt; text per STRICT RULE
// 14. But a message that needs a REAL embedded element (STRICT RULE 20's
// <sch:value-of select="..."/> for dynamic error text) must NOT be escaped,
// or the element becomes inert literal text instead of a real Schematron
// node. "messageIsRawXml": true opts a few-shot out of escaping -- the
// author is then responsible for manually writing &lt;/&gt; for any literal
// angle bracket that ISN'T a real element. Absent/false (the default for
// all pre-existing few-shots) keeps today's escaping behavior unchanged.
function renderMessage(entry) {
  return entry.messageIsRawXml ? String(entry.message == null ? "" : entry.message) : escapeXmlText(entry.message);
}

function buildFewShotBlock(schemaSummary) {
  const examples = schemaSummary.few_shot_examples || [];
  return examples
    .map((ex, i) => {
      const topics = (ex.topicTypes || []).join(", ");

      if (ex.confidence_ai === "DESACTIVADA") {
        // Teaches restraint: this looked checkable but real DITA verification
        // proved it wrong (not just uncertain) -- the correct move is a
        // traceability comment, never a forced/invented rule.
        return `### Example ${i + 1} — ${ex.id} (topics: ${topics}) — WHEN TO STOP AND NOT GENERATE A RULE
Tempting but WRONG attempt (context="${ex.context}", test="${ex.test}"):
this assumed <revised> could contain a <comment> child. Real verification against
the XSD showed <revised> is EMPTY (attributes only, no child elements or text) --
the rule was structurally impossible, not just unverified.
CORRECT output when this happens — a traceability comment, nothing else:
<!-- ${ex.id}: no se pudo generar una regla Schematron automatable (${escapeXmlText(ex.notes.split(".")[0])}); pendiente de revision manual. -->`;
      }

      if (ex.id === "BRDP-D1-00313") {
        return `### Example ${i + 1} — ${ex.id} (topics: ${topics}, confidence: ${ex.confidence_ai}) — MULTIPLE INDEPENDENT CHECKS IN ONE RULE
${BRDP_00313_LITERAL}
Note the two sch:report elements share the same sch:rule/@context but each has
its OWN globally-unique @id, suffixed with a short descriptive slug
(-shortdesc / -author) — never reuse the bare BRDP id twice.`;
      }

      return `### Example ${i + 1} — ${ex.id} (topics: ${topics}, confidence: ${ex.confidence_ai})
<sch:pattern>
  <sch:rule context="${ex.context}">
${renderSchLets(ex.lets)}    <sch:assert role="${ex.assert_role}" id="${ex.id}" test="${ex.test}">${renderMessage(ex)}</sch:assert>
  </sch:rule>
</sch:pattern>`;
    })
    .join("\n\n");
}

// When a real project BRDP's id happens to exactly match one of the curated
// few-shot examples, the pattern is copied here DETERMINISTICALLY instead of
// asking the LLM to regenerate it. A real 100-BRDP run showed the LLM can get
// confused by seeing its own few-shot example in the prompt and dismiss the
// actual BRDP as "already exists / duplicate" with a comment instead of
// producing the real rule -- silently dropping coverage for it. Copying the
// curated pattern directly is both more reliable (no ambiguity possible) and
// cheaper (no LLM call needed at all for these ids).
function buildDeterministicBlockFromFewShot(entry) {
  // A frozen rule_approvals row (see src/api/approvals.js): rule_xml is
  // already the exact, previously-approved <sch:pattern>/comment block --
  // inject it verbatim, never rebuild it from separate fields.
  if (entry.rule_xml != null) return entry.rule_xml.trim();
  if (entry.id === "BRDP-D1-00313") return BRDP_00313_LITERAL;
  if (entry.confidence_ai === "DESACTIVADA") {
    const why = sanitizeForXmlComment(String(entry.notes || "").split(".")[0]);
    return `<!-- ${entry.id}: no se pudo generar una regla Schematron automatable (${why}); pendiente de revision manual. -->`;
  }
  return `<sch:pattern>
  <sch:rule context="${entry.context}">
${renderSchLets(entry.lets)}    <sch:assert role="${entry.assert_role}" id="${entry.id}" test="${entry.test}">${renderMessage(entry)}</sch:assert>
  </sch:rule>
</sch:pattern>`;
}

// ===== STRICT RULES =====
// Rules 4-12 map 1:1 onto the 9 real patterns identified across the 29 curated
// few-shots (absolute prohibition, enumeration, regex-on-correct-attribute,
// conditional/ancestor structure across topicTypes, nesting depth, unique
// suffixed ids, assert/report polarity, error/warning mapping, when NOT to
// generate a rule). Rules 1-3 and 13-14 are the supporting scaffolding needed
// to make those 9 patterns actually produce valid, assemblable Schematron.
const STRICT_RULES = `STRICT RULES:
1. Output ONLY raw <sch:pattern>...</sch:pattern> blocks (or, when rule 12 applies, a single XML comment) — no XML declaration, no <sch:schema> wrapper, no markdown fences, no explanation, no preamble.
2. Each BRDP produces ONE <sch:pattern> containing ONE <sch:rule context="...">. If a single BRDP needs more than one independent check (see rule 9), put all of them inside that SAME sch:rule as separate sch:assert/sch:report elements — do not create multiple patterns for one BRDP.
3. context MUST be a valid Schematron/XSLT match pattern: an element name, a union of element names with "|", and predicates on that same node (e.g. fig[@id], topicmeta[not(data[@name='x'])]). NEVER start context with a reverse axis (ancestor::, parent::, preceding::, preceding-sibling::) — that is illegal in a match pattern. If the rule logically needs an ancestor/parent check, put that check inside test (where ancestor::/parent:: are always legal), and keep context simple.
4. Absolute prohibition of an element with no exceptions -> context targets the forbidden element itself, test="false()".
5. Closed list of permitted values given in the proposal -> test="@attr = ('v1','v2','v3')" (XPath enumeration). Do not use a regex for a short closed list of literal values.
6. Attribute pattern/format constraint -> matches(@attr, '^...$', 'i') anchored with ^ and $, case-insensitive unless case clearly matters. CRITICAL: apply the regex to the attribute that ACTUALLY carries that data according to vocabulary_by_domain — verify which element/attribute really holds the value before writing the test (e.g. a filename pattern belongs on image/@href, never on fig/@id or table/@id; those are unrelated attributes on unrelated elements).
7. Structural rule that must hold across more than one topicType (see the BRDP's topicTypes) -> the test must accept EVERY structural alternative used by those topicTypes, combined with "or". Different topicTypes can satisfy the same rule through different real elements (e.g. a generic task's prereq/context is NOT the same structure as machineryTask's formal <safety> element from taskreq-d — if a rule targets both, test must accept ancestor::safety OR the generic task structure, not just one of them). Check vocabulary_by_domain for the topicTypes involved before writing the test.
8. Nesting-depth limit -> count(ancestor::element-name) compared with a relational operator (see rule 17 for how to escape it). Never simulate depth counting with nested positional predicates.
9. sch:assert/@id and sch:report/@id MUST be globally unique across the ENTIRE document being assembled. If a BRDP produces more than one independent check, suffix each id with a short descriptive slug: BRDP-id-slug (e.g. BRDP-D1-00313-shortdesc, BRDP-D1-00313-author). NEVER reuse the same id twice, and never reuse a bare BRDP id for more than one assert/report.
10. sch:assert/@test fires its message when the test evaluates to FALSE — phrase it as what MUST be true. sch:report/@test fires its message when the test evaluates to TRUE — phrase it as what must NOT happen. Pick whichever reads naturally for the rule, but never invert the polarity.
11. role="error" for absolute prohibitions/mandates ("must", "shall not", "is required") and for closed enumerations from a fixed external standard. role="warning" for recommendations/conditional language ("should", "recommend", "discard if not necessary", "consider", "discard what is not never need").
12. If the BRDP has no reliable structural hook in real DITA — either it is actually a process/governance decision with no XML footprint, or the element/attribute it describes is not present in vocabulary_by_domain/topic_types for the relevant topicTypes — DO NOT invent a rule. Output ONLY this XML comment instead:
<!-- BRDP-id: no se pudo generar una regla Schematron automatable (motivo breve); pendiente de revision manual. -->
13. NEVER use an element or attribute name that is not listed in vocabulary_by_domain or topic_types. If you are not sure an element exists in real DITA, prefer a name that IS confirmed there, or fall back to rule 12 — never guess a plausible-sounding element name (this is exactly the class of error that caused real false positives before: assuming <video>/<audio> attributes existed when only <object> is confirmed).
14. Inside sch:assert/sch:report message text, escape angle brackets naming elements: write &lt;elementName&gt;, never a literal <elementName>.
15. Do not add topic-type detection logic (no checking @domains, no checking the root element name) — contexts self-limit by which elements are actually present in the document being validated; this is intentional (Option B).
16. XML comments (rule 12) must NEVER contain the two-character sequence "--" anywhere in their body, and must not end with "-" right before "-->" — both break XML well-formedness. Use ";" or an em dash "—" for a pause instead of "--".
17. Inside test, context, and sch:let/@value attribute values — not just message text — a literal < or & must be escaped as &lt; / &amp;. This applies even to numeric comparisons: write count(...) &lt; 2, never count(...) < 2 with a raw <. Attribute values follow the same escaping requirement as element text (rule 14), it is not optional just because the value is XPath.
18. Before writing a test, sanity-check it is not vacuous. A test comparing two nearly-identical XPath expressions (e.g. count(X[cond < 3]) >= count(X[cond <= 3]), which is true almost by construction) does not actually verify the rule's intent — treat this as a sign the BRDP has no reliable structural hook and use rule 12 instead of forcing a lookalike rule. This applies especially to BRDPs about publishing/rendering configuration (TOC depth, page layout, print pagination, PDF/output formatting) that only affect how the publishing engine (DITA-OT) renders output, not the source document's own structure — even if a real element name (e.g. the bookmap <toc> placeholder) is nearby, using it to approximate a rendering-only decision is a semantic mismatch, not a real structural check. Apply this consistently: if a BRDP is essentially the same kind of decision as one you would otherwise resolve with rule 12, resolve it the same way even if its wording makes it look superficially structural.
19. Row-by-row cross-column check inside a DITA/CALS table (tgroup/tbody/row/entry) -> resolve the target column by its header TEXT, never by position: add an <sch:let name="colX" value="tgroup/thead/row[1]/entry[normalize-space(.) = 'Header Text']/@colname"/> as a direct child of sch:rule, placed BEFORE the sch:assert/sch:report, then reference it as $colX inside test. CALS/DITA tables identify columns by @colname, not by ordinal position — entry[2]-style positional predicates silently break if columns are reordered. Express the "for every row" condition with the XPath 2.0 quantifier "every $row in tgroup/tbody/row satisfies (...)" — never simulate this with count()/positional indexing, which cannot express a per-row condition that depends on another column's value in that same row.
20. Cross-file consistency check (a value declared once, e.g. in the .ditamap via keydef/keyword, must match its real usage inside a topic referenced from elsewhere) -> use document($hrefExpr, .) inside an <sch:let> to resolve and read the OTHER file's content; the second argument (a node, typically ".") anchors the relative href to the document currently being validated -- never call document() with only one argument when the href is relative. Resolve which topic to open via its own reference (e.g. //topicref[@navtitle = '...' or topicmeta/navtitle = '...']/@href), never by guessing a filename. When the assert's message should show the actual mismatched values (not just "these don't match"), embed <sch:value-of select="$var"/> directly inside the message content -- this requires setting "messageIsRawXml": true on the few-shot entry (see renderMessage()), since a plain message string is XML-escaped and would turn a real <sch:value-of> into inert text. This category is inherently less portable than rule 19's: it only works when the Schematron engine validates with real file-system access to the referenced topic (e.g. validating the .ditamap, not an isolated topic file) -- note that limitation explicitly in the BRDP's own documentation rather than assuming it always applies.`;

function buildSchematronPrompt(chunkBRDPs, schemaSummary) {
  const { few_shot_examples, ...schemaSummaryWithoutExamples } = schemaSummary;
  const schemaJSON = JSON.stringify(schemaSummaryWithoutExamples, null, 2);
  const fewShotBlock = buildFewShotBlock(schemaSummary);

  const system = `You are a DITA 1.3 Schematron business-rules expert. Generate sch:pattern blocks (ISO Schematron, xslt2 queryBinding) implementing the given BRDPs (Business Rules Decision Points), each already classified as checkable XML structure.

Reference structure (6 topic types + real confirmed element vocabulary per domain):
${schemaJSON}

${STRICT_RULES}

## Few-shot examples: BRDP → sch:pattern
Use these real, oXygen-validated examples as reference for context/test/role style and for when to decline (see the "WHEN TO STOP" example).

${fewShotBlock}`;

  const brdpLines = chunkBRDPs
    .map(
      (b, i) =>
        `${i + 1}. ID: ${b.id}\n   Definition: ${b.definition}\n   Proposal: ${b.proposal}`
    )
    .join("\n\n");

  const user = `Generate sch:pattern blocks for these ${chunkBRDPs.length} BRDP(s):

${brdpLines}

Output ONLY the sch:pattern blocks (or traceability comments per rule 12), starting directly with <sch:pattern or <!--`;

  return { system, user };
}

// ===== Response parsing / verification =====

const CHUNK_SIZE = 10;
const MAX_RETRIES = 2;

function extractPatternBlocks(text) {
  return [...text.matchAll(/<sch:pattern\b[\s\S]*?<\/sch:pattern>/g)].map((m) => m[0]);
}

function extractTraceabilityComments(text) {
  return [...text.matchAll(/<!--\s*BRDP-[\s\S]*?-->/g)].map((m) => m[0]);
}

function extractCheckIds(text) {
  return new Set(
    [...text.matchAll(/<sch:(?:assert|report)\b[^>]*\bid="([^"]+)"/g)].map((m) => m[1])
  );
}

// Only counts a comment as a genuine resolution if it follows our own
// canonical "no automatable rule" wording (both STRICT RULE 12's template and
// buildTraceabilityComment() always include "pendiente de revision manual").
// A real 100-BRDP run found the LLM sometimes dismisses a BRDP with an
// off-pattern comment instead ("ya existe en few-shot ... no se genera de
// nuevo (regla duplicada)") when its id happens to match a few-shot example
// -- that is NOT a valid resolution, it's the model silently dropping a real
// rule, and the old code counted ANY "BRDP-id:" comment as coverage,
// masking the loss. Requiring the canonical phrase closes that loophole
// without breaking the legitimate rule-12 mechanism.
function extractCommentedIds(text) {
  const ids = new Set();
  for (const m of text.matchAll(/<!--\s*(BRDP-[A-Za-z0-9-]+)\s*:([\s\S]*?)-->/g)) {
    if (/pendiente de revision manual/i.test(m[2])) ids.add(m[1]);
  }
  return ids;
}

// A generated id "covers" a BRDP if it equals the BRDP id, or is that id with a
// descriptive suffix (BRDP-id-slug), matching STRICT RULE 9's suffixing scheme.
function idCoversBRDP(id, brdpId) {
  return id === brdpId || id.startsWith(brdpId + "-");
}

function sanitizeForXmlComment(text) {
  // XML comments must never contain "--" or end with "-" before "-->".
  return String(text == null ? "" : text)
    .replace(/[\r\n]+/g, " ")
    .replace(/-{2,}/g, "—")
    .replace(/-+$/, "")
    .trim();
}

function buildTraceabilityComment(brdp, reason) {
  const desc = String(brdp.definition || brdp.proposal || "Regla sin contexto").slice(0, 300);
  const why = reason || "sin gancho estructural claro en el vocabulario confirmado";
  // Sanitize the WHOLE assembled body in one pass (not just the injected
  // fragments) -- a literal "--" in the surrounding boilerplate text itself
  // is just as fatal to XML well-formedness as one in `why`/`desc`, and this
  // was in fact the real bug: the boilerplate wording used a raw "--".
  const inner = `${brdp.id}: no se pudo generar una regla Schematron automatable (${why}); pendiente de revision manual. Definition: ${desc}`;
  return `<!-- ${sanitizeForXmlComment(inner)} -->`;
}

// ===== Deterministic escaping (second layer -- never rely on the LLM alone) =====
// Same philosophy as forceIssueType() in generateBREX.js: the prompt now tells
// the model not to do these two things (STRICT RULES 16/17), but a real run
// against 100 BRDPs showed it still does them often enough that a code-level
// guarantee is required regardless of prompt compliance.

// Attribute values follow XML's AttValue grammar, which (unlike element text)
// explicitly forbids a literal "<" and requires "&" to be part of a
// recognized reference. A raw "count(...) < 2" from the LLM is invalid XML
// even though the surrounding tags are otherwise fine.
function escapeAttrLiteral(value) {
  return value
    .replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, "&amp;")
    .replace(/</g, "&lt;");
}

// Also covers sch:let/@value (STRICT RULE 19's column-header lookup is
// itself an XPath expression stored in an XML attribute, exactly the same
// escaping hazard as test/context) -- "value" only ever appears as a literal
// attribute name here on sch:let in the assembled document, so widening the
// match is safe.
function escapeSchTestAttributes(xml) {
  return xml.replace(/\b(test|context|value)="([^"]*)"/g, (full, attrName, value) => (
    `${attrName}="${escapeAttrLiteral(value)}"`
  ));
}

// Re-sanitizes every XML comment's body regardless of whether it came from
// buildTraceabilityComment() (already sanitized once) or directly from the
// LLM (rule 12 output, never passed through buildTraceabilityComment at
// all) -- this is the actual majority case found in a real 100-BRDP run.
function sanitizeXmlCommentBodies(xml) {
  return xml.replace(/<!--([\s\S]*?)-->/g, (full, body) => `<!--${sanitizeForXmlComment(body)}-->`);
}

// Splits raw LLM output into pattern blocks (dropping any whose ids don't map
// to a real target BRDP -- hallucinated/invented patterns) and traceability
// comments, and reports which of the expected BRDPs remain uncovered.
function processChunkResponse(rawText, chunkBRDPs, targetIds) {
  const patterns = extractPatternBlocks(rawText);
  const rawComments = extractTraceabilityComments(rawText);

  const keptPatterns = patterns.filter((block) => {
    const ids = [...extractCheckIds(block)];
    return ids.some((id) => [...targetIds].some((t) => idCoversBRDP(id, t)));
  });

  // Discard, not just ignore-for-coverage, any comment that doesn't follow
  // our own canonical "no automatable rule" wording (extractCommentedIds
  // already enforces that) -- otherwise an off-pattern dismissal like "ya
  // existe / duplicada" would still leak into the final document even after
  // a successful retry produced the real rule for the same BRDP.
  const keptComments = rawComments.filter((block) => {
    const ids = [...extractCommentedIds(block)];
    return ids.some((id) => [...targetIds].some((t) => idCoversBRDP(id, t)));
  });

  const coveredIds = new Set();
  for (const block of keptPatterns) {
    for (const id of extractCheckIds(block)) coveredIds.add(id);
  }
  for (const block of keptComments) {
    for (const id of extractCommentedIds(block)) coveredIds.add(id);
  }

  const missing = chunkBRDPs.filter(
    (b) => ![...coveredIds].some((id) => idCoversBRDP(id, b.id))
  );

  return { patterns: keptPatterns, comments: keptComments, missing };
}

// Batch-fetches every frozen approval for FORMAT_ID in one request (see
// GET /api/approvals/format/:format) instead of one call per BRDP. A fetch
// failure degrades to "no approvals" rather than aborting generation --
// affected BRDPs simply fall back to the LLM/safety-net path exactly as
// before this feature existed, so coverage is never at risk, only the
// deterministic-injection optimization for that one run.
async function fetchApprovalsMap(format) {
  try {
    const rows = await getApprovalsForFormat(format);
    return new Map(rows.map((r) => [r.brdp_id, r]));
  } catch (err) {
    console.error(`Failed to fetch rule approvals for format ${format}:`, err);
    return new Map();
  }
}

export async function generateSingleRule(brdp, schemaSummary, callLLM) {
  const { system, user } = buildSchematronPrompt([brdp], schemaSummary);
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const raw = await callLLM(system, user);
    if (!raw) continue;
    const extracted = extractXML(raw);
    const { patterns, comments, missing } = processChunkResponse(extracted, [brdp], new Set([brdp.id]));
    if (missing.length === 0) {
      if (patterns.length > 0) return { type: "pattern", xml: patterns.join("\n") };
      if (comments.length > 0) return { type: "comment", xml: comments.join("\n") };
    }
  }
  console.warn(`Could not generate a Schematron rule for ${brdp.id} after ${MAX_RETRIES} attempts`);
  return null;
}

// ===== Deterministic finalization (no BREX-equivalent conversion exists for
// DITA -- this header assembly is the only deterministic step in the whole
// pipeline, so it carries more weight than its BREX counterpart) =====

function finalizeSchematronDocument(blocks, projectConfig, schemaSummary) {
  const header = (schemaSummary && schemaSummary.sch_header) || {};
  const open =
    header.root_open ||
    '<sch:schema xmlns:sch="http://purl.oclc.org/dsdl/schematron" queryBinding="xslt2">';
  const close = header.root_close || "</sch:schema>";
  const projectTitle = escapeXmlText(
    (projectConfig && (projectConfig.projectName || projectConfig.modelIdentCode)) || "Project"
  );
  const title = (
    header.title_template ||
    "<sch:title>{PROJECT_TITLE} Business Rules Schematron (BRDP-D1)</sch:title>"
  ).replace("{PROJECT_TITLE}", projectTitle);

  let xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    open,
    title,
    ...blocks,
    close,
  ].join("\n");

  // Second layer of defense (rules 16/17 are the prompt-side first layer):
  // force-correct escaping regardless of whether the LLM actually complied.
  xml = escapeSchTestAttributes(xml);
  xml = sanitizeXmlCommentBodies(xml);

  return xml;
}

// ===== checkWellFormedSchematron() =====
// Deliberately does NOT use DOMParser: every check here is regex/string-based
// so the exact same function runs identically in the browser bundle and in a
// plain Node test script (no polyfills needed). This is the only safety net
// left once generated, since -- unlike BREX -- there is no deterministic
// BREX->Schematron conversion step downstream to catch mistakes.

// A literal ">" is perfectly legal, unescaped, inside an XML attribute value
// (only "<" and bare "&" are forbidden there) -- and our own test attributes
// routinely contain one, e.g. test="count(substep) >= 2". Every check below
// used to scan attribute lists with a naive [^>]* which cannot tell "a >
// that's part of an attribute value" from "the > that closes the tag", so it
// silently truncated at the wrong spot (confirmed with a real, known-good,
// oXygen-validated .sch: BRDP-D1-00187's own test="count(substep) >= 2" was
// enough to trigger a false "empty test attribute").
// ATTR_LIST instead matches whole name="value"/name='value' pairs one at a
// time, each bounded by its own matching quote -- so a > or < inside a value
// can never be mistaken for the tag's closing bracket.
const ATTR_LIST = String.raw`(?:\s+[A-Za-z_][\w:.-]*\s*=\s*(?:"[^"]*"|'[^']*'))*`;

function getAttr(attrs, name) {
  const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`));
  if (!m) return null;
  return m[1] !== undefined ? m[1] : m[2];
}

function checkTagBalance(xml) {
  const stripped = xml
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
  const stack = [];
  const tagRe = new RegExp(`<(/?)([A-Za-z_][\\w:.-]*)${ATTR_LIST}\\s*(/?)>`, "g");
  let m;
  while ((m = tagRe.exec(stripped)) !== null) {
    const [, closing, name, selfClose] = m;
    if (closing) {
      const top = stack[stack.length - 1];
      if (top !== name) {
        const line = stripped.slice(0, m.index).split("\n").length;
        return { valid: false, error: `Mismatched closing tag </${name}> (around line ${line})` };
      }
      stack.pop();
    } else if (!selfClose) {
      stack.push(name);
    }
  }
  if (stack.length > 0) {
    return { valid: false, error: `Unclosed tag(s): ${stack.join(", ")}` };
  }
  return { valid: true, error: null };
}

function checkRootHeader(xml) {
  const m = xml.match(new RegExp(`<sch:schema\\b${ATTR_LIST}\\s*>`));
  if (!m) return { valid: false, error: "Missing <sch:schema> root element" };
  if (xml.trim().indexOf(m[0]) > 200) {
    return { valid: false, error: "<sch:schema> does not appear near the start of the document" };
  }
  if (!/xmlns:sch="http:\/\/purl\.oclc\.org\/dsdl\/schematron"/.test(m[0])) {
    return { valid: false, error: "<sch:schema> is missing the required xmlns:sch namespace declaration" };
  }
  if (!/queryBinding="xslt2"/.test(m[0])) {
    return { valid: false, error: '<sch:schema> is missing queryBinding="xslt2"' };
  }
  return { valid: true, error: null };
}

function checkDuplicateIds(xml) {
  const re = new RegExp(`<sch:(?:assert|report)\\b(${ATTR_LIST})\\s*/?>`, "g");
  const ids = [...xml.matchAll(re)].map((m) => getAttr(m[1], "id")).filter(Boolean);
  const seen = new Set();
  const dupes = new Set();
  for (const id of ids) {
    if (seen.has(id)) dupes.add(id);
    seen.add(id);
  }
  return dupes.size > 0
    ? { valid: false, error: `Duplicate sch:assert/sch:report id(s): ${[...dupes].join(", ")}` }
    : { valid: true, error: null };
}

const KNOWN_ROLES = new Set(["error", "warning", "info", "fatal"]);

function checkRulesAndChecks(xml) {
  const errors = [];
  const patternRe = new RegExp(`<sch:pattern\\b${ATTR_LIST}\\s*>([\\s\\S]*?)</sch:pattern>`, "g");
  for (const pm of xml.matchAll(patternRe)) {
    const patternBody = pm[1];
    let ruleCount = 0;
    const ruleRe = new RegExp(`<sch:rule\\b(${ATTR_LIST})\\s*>([\\s\\S]*?)</sch:rule>`, "g");
    for (const rm of patternBody.matchAll(ruleRe)) {
      ruleCount++;
      const attrs = rm[1];
      const ruleBody = rm[2];
      const ctx = getAttr(attrs, "context") || "";
      if (!ctx.trim()) {
        errors.push("sch:rule with empty or missing context attribute");
      } else if (!_isSafePattern(ctx)) {
        errors.push(`sch:rule context is not a valid Schematron match pattern: "${ctx}"`);
      }
      let checkCount = 0;
      const checkRe = new RegExp(`<sch:(?:assert|report)\\b(${ATTR_LIST})\\s*/?>`, "g");
      for (const cm of ruleBody.matchAll(checkRe)) {
        checkCount++;
        const cAttrs = cm[1];
        const test = getAttr(cAttrs, "test");
        if (!test || !test.trim()) {
          errors.push("sch:assert/sch:report with empty or missing test attribute");
        }
        const role = getAttr(cAttrs, "role");
        if (role && !KNOWN_ROLES.has(role)) {
          errors.push(`Unknown role value: "${role}"`);
        }
      }
      if (checkCount === 0) errors.push("sch:rule with no sch:assert/sch:report inside");
    }
    if (ruleCount === 0) errors.push("sch:pattern with no sch:rule inside");
  }
  return errors;
}

function checkPlaceholders(xml) {
  const markers = ["TODO", "FIXME", "{{", "PROJECT_TITLE}}"];
  return markers.filter((marker) => xml.includes(marker));
}

// Non-blocking lint: flags element/attribute-shaped tokens in context/test
// that are not present in vocabulary_by_domain (nor in a small curated set of
// base DITA structural names). Heuristic by design (not a real XPath parser)
// -- it exists specifically to catch the class of error that caused real
// false positives before (assuming an element/attribute exists without
// checking the confirmed vocabulary).
const XPATH_FUNCTIONS = new Set([
  "not", "count", "matches", "normalize-space", "contains", "concat",
  "tokenize", "last", "text", "string", "string-length", "starts-with",
  "ends-with", "substring",
  // document($href, .) -- STRICT RULE 20's cross-file lookup function.
  "document",
]);
const XPATH_AXES = new Set([
  "ancestor", "ancestor-or-self", "parent", "child", "descendant",
  "descendant-or-self", "following", "following-sibling", "preceding",
  "preceding-sibling", "self", "attribute",
]);
// "every"/"some"/"satisfies"/"let"/"return"/"in" are XPath 2.0 quantifier/let
// keywords (STRICT RULE 19) -- without these, the lint flags every
// "every $x in ... satisfies (let ... return ...)" construct as unconfirmed
// vocabulary, which is noise, not a real finding.
const XPATH_KEYWORDS = new Set([
  "and", "or", "not", "true", "false", "div", "mod",
  "every", "some", "satisfies", "let", "return", "in",
]);

const EXTRA_KNOWN_NAMES = [
  "topic", "concept", "task", "map", "bookmap", "machineryTask",
  "title", "titlealts", "shortdesc", "abstract", "prolog", "body", "related-links", "topic-info-types",
  "conbody", "info-types", "taskbody", "task-info-types", "prereq", "context", "steps", "steps-unordered",
  "steps-informal", "stepsection", "step", "substeps", "substep", "cmd", "info", "itemgroup", "stepxmp",
  "tutorialinfo", "choices", "choice", "choicetable", "chhead", "choptionhd", "chdeschd", "chrow", "choption",
  "chdesc", "stepresult", "steptroubleshooting", "tasktroubleshooting", "result", "postreq",
  "topicmeta", "anchor", "navref", "reltable", "topicref", "relheader", "relcolspec", "relrow", "relcell",
  "bookmeta", "frontmatter", "backmatter", "chapter", "part", "appendices", "appendix", "booktitle",
  "bookabstract", "booklists", "colophon", "dedication", "draftintro", "notices", "preface", "amendments",
  "p", "fig", "table", "tgroup", "thead", "tbody", "row", "entry", "note", "dl", "ul", "ol", "sl", "lq", "example",
  "section", "bodydiv", "desc", "id", "class", "xref", "image", "object", "param",
  "author", "copyright", "copyryear", "copyrholder", "critdates", "created", "revised", "permissions",
  "data", "data-about", "sort-as", "unknown",
  "fn", "draft-comment", "required-cleanup",
  "b", "i", "u", "tt", "sup", "sub", "line-through", "overline",
  "imagemap", "area", "shape", "coords",
  "hazardstatement", "messagepanel", "hazardsymbol", "typeofhazard", "consequence", "howtoavoid",
  "prelreqs", "closereqs", "reqconds", "reqcond", "reqcontp", "noconds", "reqpers", "personnel", "perscat",
  "perskill", "esttime", "supequip", "nosupeq", "supeqli", "supequi", "supplies", "nosupply", "supplyli",
  "supply", "spares", "nospares", "sparesli", "spare", "safety", "nosafety", "safecond",
  "href", "keyref", "format", "type", "scope", "value", "name", "modified", "date", "lang", "outputclass",
  "conref", "importance", "domains",
  // Real DITA elements confirmed against the vendored XSD, referenced by
  // curated few-shots (BRDP-D1-00118, 00299, 00300) but outside the 6-type
  // topic_types scope, so they'd otherwise never appear in known vocabulary:
  // reference/glossentry (topic types -- technicalContent/xsd/referenceMod.xsd,
  // glossentryMod.xsd), topichead/topicgroup (map grouping elements --
  // base/xsd/mapGroupMod.xsd), navtitle (a real ELEMENT inside <titlealts> --
  // base/xsd/commonElementMod.xsd:935 -- distinct from the @navtitle
  // attribute also confirmed on topicref/chapter/part).
  "reference", "glossentry", "topichead", "topicgroup", "navtitle",
  // ph: extremely common base phrase element -- base/xsd/commonElementMod.xsd:1893.
  "ph",
  // toc: a REAL element (bookmap/xsd/bookmapMod.xsd:1831), but note its actual
  // semantics are narrow: an EMPTY placeholder inside <booklists> (frontmatter)
  // telling the publishing engine "generate a table of contents here" --
  // <xs:group name="toc.content"><xs:sequence/></xs:group>, no children, no
  // relation whatsoever to <topic>/<topicref> nesting depth. Confirmed real so
  // it belongs in known vocabulary (a rule that legitimately targets the
  // bookmap <toc> placeholder shouldn't be flagged), but its presence here does
  // NOT vouch for how a generated rule actually uses it -- a rule computing
  // topic-nesting depth via a context/test built around <toc> is still almost
  // certainly a semantic mismatch, just not a vocabulary one (see STRICT RULE
  // 18 below, added after finding exactly this in a real generated rule for
  // BRDP-D1-00497).
  "toc",
  // keydef/keyword -- STRICT RULE 20's cross-file key-declaration lookup
  // (CURATED-escalon-consistency). keydef: map-level key-scope declaration
  // element, base/xsd/mapGroupMod.xsd -- only ever appears inside
  // map/bookmap, never inside a topic body. keyword: base phrase element
  // confirmed real across many XSDs (e.g. base/xsd/commonElementMod.xsd).
  "keydef", "keyword",
];

function collectStrings(value, out) {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    value.forEach((v) => collectStrings(v, out));
  } else if (value && typeof value === "object") {
    Object.values(value).forEach((v) => collectStrings(v, out));
  }
}

function buildKnownVocabulary(schemaSummary) {
  const names = new Set(EXTRA_KNOWN_NAMES);
  const domains = (schemaSummary && schemaSummary.vocabulary_by_domain) || {};
  for (const domain of Object.values(domains)) {
    for (const key of Object.keys(domain.elements || {})) {
      key.split(/[/,]|\s+/).map((s) => s.trim()).filter(Boolean).forEach((n) => names.add(n));
    }
  }
  // topic_types is free-text prose (content_sequence, body_content, etc.),
  // not a clean element list -- tokenize every string value the same way
  // context/test XPath is tokenized below, so any element name documented
  // there (prereq, steps, topicref, chapter, reltable, ...) is recognized as
  // known even though it isn't repeated in vocabulary_by_domain. Harmless
  // over-inclusion (the occasional Spanish prose word) is an acceptable
  // trade-off for a non-blocking lint -- it can only reduce false positives.
  const topicTypeStrings = [];
  collectStrings((schemaSummary && schemaSummary.topic_types) || {}, topicTypeStrings);
  const genericTokenRe = /\b[a-zA-Z][a-zA-Z0-9-]*\b/g;
  for (const s of topicTypeStrings) {
    for (const m of s.matchAll(genericTokenRe)) names.add(m[0]);
  }
  return names;
}

// Excludes tokens preceded by @ (attribute names, handled separately),
// '/" (already-quoted string literals), : (axis/prefix separator) -- and,
// since STRICT RULE 19 introduced XPath 2.0 $variable references (e.g.
// $colCant), also $ -- a variable name is never DITA vocabulary and should
// never be flagged as an unconfirmed element/attribute.
const NAME_TOKEN_RE = /(?<![@'":$])\b([a-zA-Z][a-zA-Z0-9-]*)\b(?=\s*(?:\/|\[|\||\s|\(|$|::))/g;

function findUnknownNames(value, known) {
  const stripped = value.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
  const unknown = new Set();
  for (const tok of stripped.matchAll(NAME_TOKEN_RE)) {
    const name = tok[1];
    if (XPATH_FUNCTIONS.has(name) || XPATH_AXES.has(name) || XPATH_KEYWORDS.has(name)) continue;
    if (/^\d/.test(name)) continue;
    if (!known.has(name)) unknown.add(name);
  }
  return unknown;
}

// One warning per (BRDP id, unconfirmed name) pair, in English to match the
// rest of the UI -- a global "these names are unconfirmed somewhere" list
// isn't actionable; the reviewer needs to know exactly which rule to check.
function lintVocabulary(xml, schemaSummary) {
  const known = buildKnownVocabulary(schemaSummary);
  const warnings = [];
  const seen = new Set();

  const addWarning = (id, name) => {
    const key = `${id}|${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    warnings.push(`${id}: uses unconfirmed element/attribute '${name}'`);
  };

  const ruleRe = new RegExp(`<sch:rule\\b(${ATTR_LIST})\\s*>([\\s\\S]*?)</sch:rule>`, "g");
  for (const rm of xml.matchAll(ruleRe)) {
    const ctx = getAttr(rm[1], "context") || "";
    const ruleBody = rm[2];

    const checkRe = new RegExp(`<sch:(?:assert|report)\\b(${ATTR_LIST})\\s*/?>`, "g");
    const checks = [...ruleBody.matchAll(checkRe)]
      .map((cm) => ({ id: getAttr(cm[1], "id"), test: getAttr(cm[1], "test") || "" }))
      .filter((c) => c.id);
    if (checks.length === 0) continue;

    // A context can be shared by more than one assert/report in the same
    // rule (e.g. BRDP-D1-00313's two sch:report) -- attribute an unknown name
    // found in context to every id in that rule.
    if (ctx) {
      const unknownInContext = findUnknownNames(ctx, known);
      for (const name of unknownInContext) {
        for (const { id } of checks) addWarning(id, name);
      }
    }
    // sch:let/@value carries its own XPath (STRICT RULE 19/20's column
    // lookups and document() cross-file resolution) and was previously
    // never scanned at all -- exactly the category of rule (cross-file,
    // document()) where the LLM inventing vocabulary is most likely, so
    // leaving it unchecked would blind the lint precisely where it matters
    // most. Same attribution rule as context: a sch:let is scoped to the
    // whole sch:rule, so an unknown name in it applies to every check in
    // that rule.
    const letRe = new RegExp(`<sch:let\\b(${ATTR_LIST})\\s*/?>`, "g");
    for (const lm of ruleBody.matchAll(letRe)) {
      const letValue = getAttr(lm[1], "value") || "";
      if (!letValue) continue;
      for (const name of findUnknownNames(letValue, known)) {
        for (const { id } of checks) addWarning(id, name);
      }
    }
    for (const { id, test } of checks) {
      if (!test) continue;
      for (const name of findUnknownNames(test, known)) addWarning(id, name);
    }
  }

  return warnings;
}

function checkWellFormedSchematron(xml, schemaSummary) {
  const errors = [];

  const tagCheck = checkTagBalance(xml);
  if (!tagCheck.valid) errors.push(tagCheck.error);

  // Remaining checks assume a document that's at least tag-balanced; still
  // run them defensively (regex-based, won't throw either way) but the caller
  // should treat tagCheck failure as the primary signal.
  const rootCheck = checkRootHeader(xml);
  if (!rootCheck.valid) errors.push(rootCheck.error);

  const dupeCheck = checkDuplicateIds(xml);
  if (!dupeCheck.valid) errors.push(dupeCheck.error);

  errors.push(...checkRulesAndChecks(xml));

  const placeholders = checkPlaceholders(xml);
  if (placeholders.length > 0) {
    errors.push(`Unresolved placeholder(s) found: ${placeholders.join(", ")}`);
  }

  const vocabularyWarnings = lintVocabulary(xml, schemaSummary);

  return { valid: errors.length === 0, errors, vocabularyWarnings };
}

// ===== Main entry point =====
// Same chunking/verify/coverage-sweep architecture as generateBREX.js, but
// simpler in one respect: since every chunk only ever emits self-contained
// <sch:pattern> blocks (Option B), there's no "chunk 1 = full document"
// special case, and assembly is a plain array push instead of BREX's
// footer-stripping/reinsertion logic.

export async function generateSchematronDITA(brdps, projectConfig, options = {}) {
  const {
    apiKey,
    modelName,
    provider = "Anthropic",
    customEndpoint = "",
    onlyValidated = true,
    onChunk,
    abortController,
    schemaSummary: schemaSummaryOverride,
    callLLM: callLLMOverride,
    proposeApproval: proposeApprovalOverride,
  } = options;
  const proposeRule = proposeApprovalOverride || proposeApproval;

  if (!callLLMOverride && !apiKey) {
    throw new Error("API key is required. Please configure it in Settings.");
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

  // A BRDP with a frozen approval for FORMAT_ID (see src/api/approvals.js and
  // CLAUDE.md's rule_approvals design) is injected verbatim and never sent to
  // the LLM -- same mechanism as the few-shot exact-id-match below, just
  // triggered by an explicit user approval instead of a curated example.
  // Approval takes priority over a few-shot match: a real project decision
  // always outranks a generic curated example for the same id.
  const approvalsOverride = options.approvals;
  const approvalById = approvalsOverride
    ? (approvalsOverride instanceof Map ? approvalsOverride : new Map(approvalsOverride.map((a) => [a.brdp_id, a])))
    : await fetchApprovalsMap(FORMAT_ID);

  // BRDPs whose id exactly matches a curated few-shot are resolved
  // deterministically (see buildDeterministicBlockFromFewShot) and never sent
  // to the LLM at all -- see the comment on that function for why. targetIds
  // (the "is this pattern id real or invented" set used by
  // processChunkResponse) is scoped to brdpsForLLM only, so if the LLM still
  // echoes one of the deterministic ids back anyway, it's correctly dropped
  // as invented rather than duplicating the id already pushed above.
  // Auto-proposal: any BRDP that reaches the LLM/few-shot path below (i.e.
  // isn't already frozen-approved) gets its freshly generated fragment saved
  // as a pending_review candidate -- overwriting any earlier pending_review
  // proposal for the same id, so it always reflects the latest generation.
  // Never proposed: the traceability-comment safety net (no real rule was
  // generated) and, of course, an already-approved BRDP (it never reaches
  // this code path in the first place).
  const proposals = [];

  const fewShotById = new Map((schemaSummary.few_shot_examples || []).map((e) => [e.id, e]));
  const blocks = [];
  const brdpsForLLM = [];
  for (const brdp of targetBRDPs) {
    const approvalEntry = approvalById.get(brdp.id);
    if (approvalEntry && approvalEntry.status === "approved") {
      blocks.push(buildDeterministicBlockFromFewShot(approvalEntry));
      continue;
    }
    const fewShotEntry = fewShotById.get(brdp.id);
    if (fewShotEntry) {
      const block = buildDeterministicBlockFromFewShot(fewShotEntry);
      blocks.push(block);
      proposals.push({ brdpId: brdp.id, ruleXml: block });
    } else {
      brdpsForLLM.push(brdp);
    }
  }
  const targetIds = new Set(brdpsForLLM.map((b) => b.id));

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

  const chunks = [];
  for (let i = 0; i < brdpsForLLM.length; i += CHUNK_SIZE) {
    chunks.push(brdpsForLLM.slice(i, i + CHUNK_SIZE));
  }

  for (const chunk of chunks) {
    const { system, user } = buildSchematronPrompt(chunk, schemaSummary);
    const raw = await callLLM(system, user);
    const extracted = raw && raw.trim() ? extractXML(raw.trim()) : "";
    const { patterns, comments, missing } = processChunkResponse(extracted, chunk, targetIds);

    blocks.push(...patterns, ...comments);

    // patterns are already split per-block (STRICT RULE 2: one BRDP -> one
    // sch:pattern, or one shared rule for a documented multi-check exception
    // like BRDP-D1-00313) -- match each chunk BRDP against the block(s)
    // whose ids cover it and propose that as its candidate. comments (rule
    // 12 traceability) are never proposed -- no real rule was generated.
    for (const brdp of chunk) {
      const matchingBlocks = patterns.filter((block) =>
        [...extractCheckIds(block)].some((id) => idCoversBRDP(id, brdp.id))
      );
      if (matchingBlocks.length > 0) {
        proposals.push({ brdpId: brdp.id, ruleXml: matchingBlocks.join("\n") });
      }
    }

    // Retry missing individually (per-BRDP), same as generateBREX.js
    for (const brdp of missing) {
      const rule = await generateSingleRule(brdp, schemaSummary, callLLM);
      if (rule) {
        blocks.push(rule.xml);
        proposals.push({ brdpId: brdp.id, ruleXml: rule.xml });
      }
    }
  }

  // Barrido final de cobertura: ningun BRDP debe perderse en silencio
  {
    const coveredIds = new Set();
    for (const block of blocks) {
      for (const id of extractCheckIds(block)) coveredIds.add(id);
      for (const id of extractCommentedIds(block)) coveredIds.add(id);
    }
    const stillMissing = targetBRDPs.filter(
      (b) => ![...coveredIds].some((id) => idCoversBRDP(id, b.id))
    );
    for (const brdp of stillMissing) {
      const rule = await generateSingleRule(brdp, schemaSummary, callLLM);
      if (rule) {
        blocks.push(rule.xml);
        proposals.push({ brdpId: brdp.id, ruleXml: rule.xml });
      } else {
        // Red de seguridad: nunca perder un BRDP en silencio -> comentario de
        // trazabilidad, mismo patron real que BRDP-D1-00089.
        blocks.push(buildTraceabilityComment(brdp, "sin respuesta valida del LLM tras los reintentos"));
      }
    }
  }

  const finalXml = finalizeSchematronDocument(blocks, projectConfig, schemaSummary);
  const { valid, errors, vocabularyWarnings } = checkWellFormedSchematron(finalXml, schemaSummary);

  // Fire-and-verify, never fire-and-break: a failed proposal write must never
  // fail the generation that already succeeded -- same safe-degrade
  // philosophy as the approvals fetch itself.
  if (proposals.length > 0) {
    await Promise.allSettled(
      proposals.map((p) => proposeRule(p.brdpId, FORMAT_ID, p.ruleXml, "llm"))
    );
  }

  return { xml: finalXml, valid, errors, vocabularyWarnings, brdpCount: targetBRDPs.length };
}

export { buildSchematronPrompt, buildFewShotBlock, buildDeterministicBlockFromFewShot, loadSchemaSummary, checkWellFormedSchematron, finalizeSchematronDocument };
