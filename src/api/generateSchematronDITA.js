import { pendingApprovalComment } from "./generateBREX.js";
import { ruleEnters } from "../utils/generatePlan.js";
import { _isSafePattern } from "./brexToSchematron.js";
import {
  XPATH_STANDARD_NAMESPACES,
  XPATH_STANDARD_PREFIXES,
  schematronPrefixUses,
  undeclaredSchematronPrefixes,
  xmlnsDeclarations,
} from "../utils/xpathPrefixes.js";
import {
  STANDARD_TO_VOCABULARY_FILE,
  checkXPathNames,
  extractRuleXPaths,
  extractSchematronLetValues,
  loadSchemaVocabulary,
  nameIssues,
} from "../validation/schemaValidation.js";

// Both DITA standards (migration 0013_split_dita_xpath_standards.py) share
// this one FORMAT_ID/generator -- the only thing that genuinely differs is
// the assembled document's queryBinding attribute, since each real project
// hand-authors XPath 2.0 vs 3.0 Rule content separately (no shared
// deterministic conversion step, unlike BREX->Schematron for S1000D).
// Defaults to "xslt2" for the old, still-valid bare "DITA 1.3" string (a
// caller that hasn't been updated yet, or a standard value from before
// this migration) and for anything else unrecognized -- never silently
// guesses "xslt3", since that's the one flavor that actually changes
// generated output.
function queryBindingForStandard(standard) {
  return standard === "DITA 1.3 Xpath3.0" ? "xslt3" : "xslt2";
}

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

// An approved rule enters the document verbatim: rule_xml is the exact
// <sch:pattern>/comment block saved in rule_approvals (NOT NULL), never
// rebuilt from separate fields.
function approvedRuleBlock(approval) {
  return approval.rule_xml.trim();
}

// ===== Deterministic finalization (no BREX-equivalent conversion exists for
// DITA -- this header assembly is the only deterministic step in the whole
// pipeline, so it carries more weight than its BREX counterpart) =====

function finalizeSchematronDocument(blocks, projectConfig, schemaSummary, queryBinding = "xslt2", sharedLets = [], namespaces = []) {
  const header = (schemaSummary && schemaSummary.sch_header) || {};
  // Declares BOTH the sch: prefix AND the same URI as the default namespace
  // (legal XML -- an element can be in scope for a prefix and the default
  // binding to the same namespace name at once). Without the default
  // binding, a verbatim-injected block using unprefixed <pattern>/<rule>/
  // <assert> (confirmed real-world style: Navantia's own .sch files use no
  // prefix at all, unlike the sch:-prefixed curated few-shots) would land in
  // "no namespace" once nested inside this sch:-prefixed wrapper -- still
  // well-formed XML, but invisible to any real Schematron/XSLT2 processor,
  // which only recognizes pattern/rule/assert in the Schematron namespace.
  // Confirmed with lxml against real Navantia content: without this default
  // binding, `<pattern>` parses as a bare no-namespace element instead of
  // `{http://purl.oclc.org/dsdl/schematron}pattern`.
  //
  // queryBinding is NOT hardcoded here (real bug found and fixed: it used
  // to always be "xslt2", so a real XPath 3.0 project -- DITA 1.3
  // Xpath3.0, migration 0013_split_dita_xpath_standards.py -- would get a
  // wrong header on its own assembled document). {QUERY_BINDING} follows
  // the exact same placeholder convention title_template already uses for
  // {PROJECT_TITLE} below, so a custom root_open from the schema summary
  // JSON stays parametrizable too, not just this JS fallback.
  const openTemplate =
    header.root_open ||
    '<sch:schema xmlns:sch="http://purl.oclc.org/dsdl/schematron" xmlns="http://purl.oclc.org/dsdl/schematron" queryBinding="{QUERY_BINDING}">';
  const open = openTemplate.replace("{QUERY_BINDING}", queryBinding);
  const close = header.root_close || "</sch:schema>";
  const projectTitle = escapeXmlText(
    (projectConfig && (projectConfig.projectName || projectConfig.modelIdentCode)) || "Project"
  );
  const title = (
    header.title_template ||
    "<sch:title>{PROJECT_TITLE} Business Rules Schematron (BRDP-D1)</sch:title>"
  ).replace("{PROJECT_TITLE}", projectTitle);

  // No document-wide "fix what the source got wrong" pass here anymore
  // (used to run escapeSchTestAttributes/sanitizeXmlCommentBodies over the
  // whole joined string) -- both block producers already guarantee valid,
  // final content on their own: approvedRuleBlock's
  // rule_xml is a verbatim passthrough of a rule_approvals row that
  // can only ever reach status "approved" after passing the SAME
  // well-formedness check server-side (propose_approval/import_jobs.py's
  // _xml_well_formed_error) and client-side (RecordsPage's checkWellFormed
  // before save), and pendingApprovalComment() (generateBREX.js) already
  // sanitizes the identifier it writes. Confirmed live with real
  // Navantia data that a blanket comment-body pass here actively broke the
  // "verbatim" guarantee: a real approved rule's OWN internal explanatory
  // comment (e.g. "<!-- La columna de exención ... -->") got silently
  // re-trimmed (losing its leading/trailing space) by the very sanitizer
  // meant only for freshly-generated text, even though the source content
  // was already valid and already approved as-is. That defense belonged to
  // an earlier architecture where finalizeSchematronDocument() still
  // assembled raw LLM chunk output directly; the main path is 100%
  // deterministic now (see generateSchematronDITA()'s own docstring), so
  // there is nothing left here for it to defend against.
  // sharedLets (see dedupeSharedLets() below): sch:let pairs repeated
  // across the approved rules, now declared once, after the sch:ns
  // declarations (namespaces, collectNamespaces() below) and before the
  // first pattern. ISO Schematron scopes a schema-level sch:let to the
  // whole document, so every rule that declared its own copy still
  // reaches it by the same $name.
  // Each with its comment right before it, once (a global function's
  // comment, carried in by AI Extract).
  const sharedLetsXml = sharedLets.map(
    (l) => (l.comment ? `  ${l.comment}\n` : "") + `  <sch:let name="${l.name}" value="${l.value}"/>`
  );
  // sch:ns before the lets (ISO order: title, ns*, p*, let*, …, pattern*).
  const namespacesXml = namespaces.map((n) => `  <sch:ns prefix="${n.prefix}" uri="${n.uri}"/>`);

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    open,
    title,
    ...namespacesXml,
    ...sharedLetsXml,
    ...blocks,
    close,
  ].join("\n");
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

// Optional "sch:" prefix for pattern/rule/assert/report/let element names in
// the checks below (everything except checkRootHeader, which only ever
// matches the deterministic wrapper this file itself emits, always
// sch:-prefixed). A curated few-shot's verbatim rule_xml uses the sch:
// prefix, but a real imported/manually-saved Rule can legitimately be
// unprefixed (confirmed real-world style: Navantia's own .sch files use no
// prefix at all) -- without this, these regexes silently match zero
// patterns/rules/checks for that content and report a clean 0
// errors/warnings not because it's confirmed correct, but because the
// checks never looked at it at all.
const SCH = "(?:sch:)?";

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

function checkRootHeader(xml, queryBinding) {
  const m = xml.match(new RegExp(`<sch:schema\\b${ATTR_LIST}\\s*>`));
  if (!m) return { valid: false, error: "Missing <sch:schema> root element" };
  if (xml.trim().indexOf(m[0]) > 200) {
    return { valid: false, error: "<sch:schema> does not appear near the start of the document" };
  }
  if (!/xmlns:sch="http:\/\/purl\.oclc\.org\/dsdl\/schematron"/.test(m[0])) {
    return { valid: false, error: "<sch:schema> is missing the required xmlns:sch namespace declaration" };
  }
  // The expected value is the CALLER's queryBinding (project.standard's
  // XPath flavor -- "xslt3" for DITA 1.3 Xpath3.0, "xslt2" for everything
  // else, see generateSchematronDITA()'s own queryBindingForStandard()) --
  // this deterministic wrapper is the only place that ever writes this
  // attribute, so it must be checked against whichever value THIS document
  // was actually finalized with, never a bare hardcoded "xslt2".
  if (!new RegExp(`queryBinding="${queryBinding}"`).test(m[0])) {
    return { valid: false, error: `<sch:schema> is missing queryBinding="${queryBinding}"` };
  }
  return { valid: true, error: null };
}

function checkDuplicateIds(xml) {
  const re = new RegExp(`<${SCH}(?:assert|report)\\b(${ATTR_LIST})\\s*/?>`, "g");
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
  const patternRe = new RegExp(`<${SCH}pattern\\b${ATTR_LIST}\\s*>([\\s\\S]*?)</${SCH}pattern>`, "g");
  for (const pm of xml.matchAll(patternRe)) {
    const patternBody = pm[1];
    let ruleCount = 0;
    const ruleRe = new RegExp(`<${SCH}rule\\b(${ATTR_LIST})\\s*>([\\s\\S]*?)</${SCH}rule>`, "g");
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
      const checkRe = new RegExp(`<${SCH}(?:assert|report)\\b(${ATTR_LIST})\\s*/?>`, "g");
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
  // Outside comments: a rule's own explanatory comment is free text ("la
  // regla SUSPENDE TODO", in a real imported Schematron), never a leftover.
  const markers = ["TODO", "FIXME", "{{", "PROJECT_TITLE}}"];
  const code = xml.replace(/<!--[\s\S]*?-->/g, "");
  return markers.filter((marker) => code.includes(marker));
}

// Generate's vocabulary warnings (non-blocking): the same name checker as
// the rest of the app -- checkXPathNames (src/validation/schemaValidation.js),
// a real XPath tokenizer for which string literals, $variables, numbers,
// prefixed names (xs:string, fn:head), function calls, kind tests, axes,
// constructors and XPath 2.0/3.0 operators (to, is, lt, intersect,
// instance of…) are never names -- against the standard's vocabulary
// (public/schema-vocabulary-dita.json, generated from the DITA 1.3 XSDs),
// with the same "not found" and "wrong type" messages as a suggested or
// pasted rule. Run on each sch:pattern of the final document (its
// @context, @test and sch:let/@value) and on each schema-level sch:let
// (the ones dedupeSharedLets hoisted).
//
// It replaces a heuristic built on hand-written lists of XPath functions
// and keywords: every function or operator missing from those lists was
// reported as an unconfirmed element (623 false warnings for 22 names on a
// real 35-rule Navantia Schematron: replace, lower-case, sort,
// uri-collection, to, is, intersect…). A vocabulary question only: whether
// XPath 3.0 syntax suits an XPath 2.0 project is not a name, and the Test
// rule panel already says it (analyzeRule's xpath3_syntax).
//
// One entry per owner: { owner, issue } with the issues of nameIssues(…,
// 'rule'). Owner: the BRDP identifier when the caller knows it
// (patternOwners, one per sch:pattern in document order: Generate does),
// else the ids of the pattern's sch:assert/sch:report, else its @id;
// "shared:<name>" for a schema-level sch:let.
//
// XMetal's ditamap second-pass mechanism (ambito-mapa.sch) navigates a
// virtual dossier with elements named dosier/ficha/mapa: not DITA, so they
// are reported as not found like any other name, with one more line that
// says where they usually come from (never that the project uses it: the
// rule alone cannot tell). Its `exists` was in the old list too, but it is
// the XPath function exists(), never a name for the tokenizer.
const XMETAL_AMBITO_MAPA_VOCAB = new Set(["dosier", "ficha", "mapa"]);

function blankComments(xml) {
  return xml.replace(/<!--[\s\S]*?-->/g, (c) => " ".repeat(c.length));
}

// The sch:pattern elements of a document or block (comments blanked):
// [{ xml, attrs }] in document order.
function schematronPatterns(xml) {
  const patternRe = new RegExp(`<${SCH}pattern\\b(${ATTR_LIST})\\s*>([\\s\\S]*?)</${SCH}pattern>`, "g");
  return [...blankComments(xml).matchAll(patternRe)].map((pm) => ({ xml: pm[0], attrs: pm[1] }));
}

function lintVocabulary(xml, vocabulary, standard, patternOwners = null) {
  if (!vocabulary) return [];
  const warnings = [];
  const add = (owner, result) => {
    for (const issue of nameIssues(result, "rule", { standard })) warnings.push({ owner, issue });
    const xmetal = (result.typedNotFound || [])
      .filter((n) => n.type === "element" && XMETAL_AMBITO_MAPA_VOCAB.has(n.name))
      .map((n) => `<${n.name}>`);
    if (xmetal.length) {
      warnings.push({ owner, issue: { source: "generate", code: "xmetal_ambito_mapa", params: { names: xmetal.join(", ") } } });
    }
  };

  const checkRe = new RegExp(`<${SCH}(?:assert|report)\\b(${ATTR_LIST})\\s*/?>`, "g");
  schematronPatterns(xml).forEach(({ xml: patternXml, attrs }, index) => {
    const ids = [...new Set([...patternXml.matchAll(checkRe)].map((cm) => getAttr(cm[1], "id")).filter(Boolean))];
    const owner = patternOwners?.[index] || (ids.length ? ids.join(", ") : getAttr(attrs, "id") || "pattern");
    add(owner, checkXPathNames([...extractRuleXPaths(patternXml), ...extractSchematronLetValues(patternXml)], vocabulary));
  });

  const withoutPatterns = blankComments(xml).replace(new RegExp(`<${SCH}pattern\\b[\\s\\S]*?</${SCH}pattern>`, "g"), "");
  const schemaLevelLetRe = new RegExp(`<${SCH}let\\b(${ATTR_LIST})\\s*/?>`, "g");
  for (const lm of withoutPatterns.matchAll(schemaLevelLetRe)) {
    add(`shared:${getAttr(lm[1], "name") || "let"}`, checkXPathNames(extractSchematronLetValues(lm[0]), vocabulary));
  }
  return warnings;
}

function checkWellFormedSchematron(xml, queryBinding = "xslt2", { vocabulary = null, standard, patternOwners = null } = {}) {
  const errors = [];

  const tagCheck = checkTagBalance(xml);
  if (!tagCheck.valid) errors.push(tagCheck.error);

  // Remaining checks assume a document that's at least tag-balanced; still
  // run them defensively (regex-based, won't throw either way) but the caller
  // should treat tagCheck failure as the primary signal.
  const rootCheck = checkRootHeader(xml, queryBinding);
  if (!rootCheck.valid) errors.push(rootCheck.error);

  const dupeCheck = checkDuplicateIds(xml);
  if (!dupeCheck.valid) errors.push(dupeCheck.error);

  errors.push(...checkRulesAndChecks(xml));

  const placeholders = checkPlaceholders(xml);
  if (placeholders.length > 0) {
    errors.push(`Unresolved placeholder(s) found: ${placeholders.join(", ")}`);
  }

  // A prefix the XPath uses with no <sch:ns> for it: a Schematron compiler
  // refuses the whole document (XPST0081); an xmlns: on a pattern does not
  // count (see src/utils/xpathPrefixes.js).
  const undeclaredPrefixes = undeclaredSchematronPrefixes(xml);
  for (const { prefix, owners } of undeclaredPrefixes) {
    errors.push(
      `Namespace prefix '${prefix}' is used in XPath without a <sch:ns> declaration${owners.length ? ` (${owners.join(", ")})` : ""}; a Schematron processor refuses the document (XPST0081)`
    );
  }

  const vocabularyWarnings = lintVocabulary(xml, vocabulary, standard, patternOwners);

  return { valid: errors.length === 0, errors, vocabularyWarnings, undeclaredPrefixes };
}

// ===== Shared <sch:let> deduplication and namespace declarations =====
// Each approved Rule is a self-contained <sch:pattern> (one BRDP, one
// pattern), so a helper shared by several rules ends up declared once per
// rule: a rule imported from a Schematron file (AI Extract) carries a copy
// of every global sch:let it uses, as pattern-level lets, and the Navantia
// Xpath3.0 rules written by hand declared their helper functions (valor,
// colDe, colPart, docFicha…) inside each sch:rule -- 62 sch:let where a
// hand-written document has each helper once. Repeated copies are declared
// once here, at schema level (a rule-level function only when repeated).
//
// Only what means the same at schema level is moved:
//   - a pattern-level sch:let (ISO Schematron evaluates it with the
//     document as context, exactly like a schema-level one), even when only
//     one rule has it;
//   - a rule-level sch:let whose value is an inline function
//     ("function($x as …) … { … }", XPath 3.0): a function has no context
//     item, so it is the same wherever it is declared.
// A rule-level let that reads the context node (cab = ancestor::tgroup[1]/…,
// part = $valor(., …)) is evaluated once per node of its rule and is never
// moved: at schema level it would be evaluated against the document root
// and give another value (fixed bug -- the previous version moved any
// rule-level let repeated with the same value, cab and part included).
// A moved let may only reference other moved lets (a schema-level let
// cannot see a pattern's or a rule's); the moved ones are written in an
// order where each comes after the ones it uses.
// Same name with different values: never merged, every copy stays where it
// is, and a warning names it. Runs for both XPath 2.0 and 3.0 projects.
const PATTERN_RE_G = new RegExp(`<${SCH}pattern\\b(${ATTR_LIST})\\s*(?:/>|>([\\s\\S]*?)</${SCH}pattern>)`, "g");
const RULE_START_RE = new RegExp(`<${SCH}rule\\b`);
// A sch:let with the comment right before it, when there is one (only
// whitespace in between): AI Extract writes a global function's comment
// there, and it moves with the function (written once, right before it).
// The comment body never runs past its own "-->".
const LET_RE_G = new RegExp(`(\\s*<!--((?:(?!-->)[\\s\\S])*)-->)?\\s*<${SCH}let\\b(${ATTR_LIST})\\s*/>`, "g");
const VAR_RE_G = /\$([A-Za-z_][\w.-]*)/g;
const BOUND_RE_G = /\$([A-Za-z_][\w.-]*)\s*(?::=|\b(?:in|as)\b)/g;

function isFunctionValue(value) {
  return /^\s*function\s*\(/.test(value);
}

// Variables an expression reads and does not bind itself.
function freeVariables(value) {
  const bound = new Set([...value.matchAll(BOUND_RE_G)].map((m) => m[1]));
  return new Set([...value.matchAll(VAR_RE_G)].map((m) => m[1]).filter((n) => !bound.has(n)));
}

// The lets of a block, each with whether it is pattern-level.
function blockLets(block) {
  const out = [];
  for (const pm of block.matchAll(PATTERN_RE_G)) {
    const body = pm[2] || "";
    const cut = body.search(RULE_START_RE);
    const head = cut === -1 ? body : body.slice(0, cut);
    const rest = cut === -1 ? "" : body.slice(cut);
    for (const lm of head.matchAll(LET_RE_G)) out.push({ attrs: lm[3], comment: lm[1] ? lm[1].trim() : null, patternLevel: true });
    for (const lm of rest.matchAll(LET_RE_G)) out.push({ attrs: lm[3], comment: lm[1] ? lm[1].trim() : null, patternLevel: false });
  }
  return out;
}

// blocks: the assembled per-BRDP strings (a verbatim approved
// <sch:pattern>…, or a comment -- no pattern, passes through untouched).
// → { blocks, sharedLets: [{name, value, comment}], warnings }. comment: the
// comment that was right before a copy of the let (the first one found), or
// null; written once, right before the shared declaration.
function dedupeSharedLets(blocks) {
  const byName = new Map(); // name -> Map(value -> count), movable copies only
  const order = [];
  const patternLevelNames = new Set();
  const comments = new Map(); // `${name}\u0001${value}` -> comment
  for (const block of blocks) {
    for (const { attrs, comment, patternLevel } of blockLets(block)) {
      const name = getAttr(attrs, "name");
      const value = getAttr(attrs, "value");
      if (!name || value == null) continue;
      if (patternLevel) patternLevelNames.add(name);
      if (!patternLevel && !isFunctionValue(value)) continue;
      const key = `${name}\u0001${value}`;
      if (comment && !comments.has(key)) comments.set(key, comment);
      if (!byName.has(name)) {
        byName.set(name, new Map());
        order.push(name);
      }
      const counts = byName.get(name);
      counts.set(value, (counts.get(value) || 0) + 1);
    }
  }

  const warnings = [];
  const shared = new Map(); // name -> value
  for (const name of order) {
    const counts = byName.get(name);
    if (counts.size > 1) {
      warnings.push(
        `Shared sch:let name '${name}' is declared with ${counts.size} different values across approved rules -- none were merged, each kept in its own rule; verify this isn't a real authoring mistake.`
      );
      continue;
    }
    const [[value, count]] = counts;
    // A pattern-level let goes up even when only one rule has it (same
    // meaning at schema level): the document then declares every function
    // in one place, as a hand-written one does, and imports back the same.
    if (count > 1 || patternLevelNames.has(name)) shared.set(name, value);
  }
  // A moved let may only use other moved lets.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, value] of shared) {
      if ([...freeVariables(value)].some((v) => !shared.has(v))) {
        shared.delete(name);
        changed = true;
      }
    }
  }
  if (shared.size === 0) return { blocks, sharedLets: [], warnings };

  const isShared = (attrs) => {
    const name = getAttr(attrs, "name");
    const value = getAttr(attrs, "value");
    return !!name && shared.get(name) === value;
  };
  const newBlocks = blocks.map((block) =>
    block.replace(PATTERN_RE_G, (full, attrs, body) => {
      if (body == null) return full;
      const cut = body.search(RULE_START_RE);
      const head = cut === -1 ? body : body.slice(0, cut);
      const rest = cut === -1 ? "" : body.slice(cut);
      // A moved let takes the comment right before it along (LET_RE_G).
      const newHead = head.replace(LET_RE_G, (m, _c, _b, a) => (isShared(a) ? "" : m));
      const newRest = rest.replace(LET_RE_G, (m, _c, _b, a) => (isShared(a) && isFunctionValue(getAttr(a, "value") || "") ? "" : m));
      // Rebuilt by position, never with String.replace(body, …): XPath is
      // full of "$" ($valor, $'…) that a replacement string reads as
      // substitution patterns.
      const at = full.lastIndexOf(body);
      return full.slice(0, at) + newHead + newRest + full.slice(at + body.length);
    })
  );

  // Each after the ones it uses (first-seen order otherwise).
  const sharedLets = [];
  const placed = new Set();
  const place = (name, path = new Set()) => {
    if (placed.has(name) || path.has(name)) return;
    path.add(name);
    for (const dep of freeVariables(shared.get(name))) if (shared.has(dep)) place(dep, path);
    placed.add(name);
    const value = shared.get(name);
    sharedLets.push({ name, value, comment: comments.get(`${name}\u0001${value}`) ?? null });
  };
  for (const name of order) if (shared.has(name)) place(name);
  return { blocks: newBlocks, sharedLets, warnings };
}

// Namespace prefixes: declared once for the whole document as <sch:ns>,
// which is the only declaration a Schematron processor reads for the
// prefixes of its XPath (an xmlns: on a pattern is not enough, see
// src/utils/xpathPrefixes.js).
//   1. Every xmlns:prefix a rule declares (on its <sch:pattern> -- xmlns:xs
//      for a function typed "as xs:string", copied from the file's global
//      sch:ns by AI Extract --, or on any element inside it).
//   2. XPath's own prefixes (xs, fn, math, map, array, err) that a rule uses
//      and no rule declares: their URI is fixed by the specifications.
//      Real case: Navantia rules imported from Excel use xs: in their
//      functions without any declaration.
//   3. Any other prefix used and declared nowhere is reported (undeclared:
//      [{prefix, rules}]); the document is generated anyway.
// Same prefix with different URIs: the first is declared, and a warning
// names the conflict. blocks: the per-BRDP blocks BEFORE dedupeSharedLets
// (a moved let keeps no xmlns of its own); identifiers: the BRDP of each.
function collectNamespaces(blocks, identifiers = []) {
  const byPrefix = new Map();
  const warnings = [];
  const usedBy = new Map(); // prefix -> Set(identifier)
  blocks.forEach((block, i) => {
    for (const [prefix, uri] of xmlnsDeclarations(block)) {
      if (prefix === "sch") continue;
      if (!byPrefix.has(prefix)) byPrefix.set(prefix, uri);
      else if (byPrefix.get(prefix) !== uri) {
        warnings.push(`Namespace prefix '${prefix}' is declared with different URIs across approved rules; '${byPrefix.get(prefix)}' is used.`);
      }
    }
    for (const prefix of schematronPrefixUses(block).keys()) {
      if (!usedBy.has(prefix)) usedBy.set(prefix, new Set());
      if (identifiers[i]) usedBy.get(prefix).add(identifiers[i]);
    }
  });
  const added = [];
  for (const prefix of XPATH_STANDARD_PREFIXES) {
    if (usedBy.has(prefix) && !byPrefix.has(prefix)) {
      byPrefix.set(prefix, XPATH_STANDARD_NAMESPACES[prefix]);
      added.push(prefix);
    }
  }
  const undeclared = [...usedBy]
    .filter(([prefix]) => !byPrefix.has(prefix))
    .map(([prefix, rules]) => ({ prefix, rules: [...rules] }))
    .sort((a, b) => a.prefix.localeCompare(b.prefix));
  return {
    namespaces: [...byPrefix].map(([prefix, uri]) => ({ prefix, uri })),
    added,
    undeclared,
    warnings: [...new Set(warnings)],
  };
}

// ===== Main entry point =====
// Same chunking/verify/coverage-sweep architecture as generateBREX.js, but
// simpler in one respect: since every chunk only ever emits self-contained
// <sch:pattern> blocks (Option B), there's no "chunk 1 = full document"
// special case, and assembly is a plain array push instead of BREX's
// footer-stripping/reinsertion logic.

// Pure deterministic assembler -- no LLM call, ever. For the active format,
// takes only the BRDPs with a frozen 'approved' rule_approvals row and
// injects their rule_xml verbatim (approvedRuleBlock);
// every other Validated BRDP becomes a pending-approval comment via
// pendingApprovalComment() (generateBREX.js) -- the same comment the BREX
// generators write: the BRDP identifier, never its UUID, in English.
export async function generateSchematronDITA(brdps, projectConfig, options = {}) {
  const {
    onlyValidated = true,
    approvals: approvalsOverride,
    schemaSummary: schemaSummaryOverride,
    standard,
    includeDrafts = false,
    vocabulary: vocabularyOverride,
  } = options;
  const queryBinding = queryBindingForStandard(standard);

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

  let blocks = [];
  const blockIdentifiers = [];
  let ruleCount = 0;
  for (const brdp of targetBRDPs) {
    const approvalEntry = approvalById.get(brdp.id);
    blockIdentifiers.push(brdp.identifier);
    if (ruleEnters(approvalEntry, includeDrafts)) {
      ruleCount += 1;
      blocks.push(approvedRuleBlock(approvalEntry));
    } else {
      // Same comment as the BREX generators (pendingApprovalComment in
      // generateBREX.js): the BRDP identifier (never its UUID), in English.
      blocks.push(pendingApprovalComment(brdp));
    }
  }

  // The rules' namespace prefixes declared once, and repeated sch:let
  // declared once (see collectNamespaces() / dedupeSharedLets() above).
  // Namespaces first, over the blocks as approved: a let moved to schema
  // level keeps no xmlns of its own.
  const { namespaces, added: addedNamespaces, undeclared: undeclaredPrefixes, warnings: nsWarnings } =
    collectNamespaces(blocks, blockIdentifiers);
  const deduped = dedupeSharedLets(blocks);
  blocks = deduped.blocks;
  const sharedLets = deduped.sharedLets;
  const dedupWarnings = [...deduped.warnings, ...nsWarnings];

  const finalXml = finalizeSchematronDocument(blocks, projectConfig, schemaSummary, queryBinding, sharedLets, namespaces);

  // The DITA vocabulary for the warnings (both DITA flavors share one
  // file). Passed by the caller (the Node tests read the file), else
  // loaded like every other panel does. A vocabulary that cannot be
  // loaded is said on the page, never taken as "no warnings" (HR7).
  const vocabStandard = STANDARD_TO_VOCABULARY_FILE[standard] ? standard : "DITA 1.3 Xpath2.0";
  let vocabulary = vocabularyOverride || null;
  let vocabularyUnavailable = null;
  if (vocabularyOverride === undefined) {
    try {
      vocabulary = await loadSchemaVocabulary(vocabStandard);
    } catch (err) {
      vocabularyUnavailable = err?.message || String(err);
    }
  }
  if (!vocabulary && !vocabularyUnavailable) vocabularyUnavailable = "no vocabulary";
  // The BRDP of each sch:pattern, in document order: the final document is
  // the blocks in order after the header, which has no pattern.
  const patternOwners = blocks.flatMap((block, i) =>
    schematronPatterns(block).map(() => blockIdentifiers[i])
  );
  const { valid, errors, vocabularyWarnings } = checkWellFormedSchematron(finalXml, queryBinding, {
    vocabulary,
    standard: standard || "DITA 1.3",
    patternOwners,
  });

  return {
    xml: finalXml,
    valid,
    errors,
    // Names of the rules that do not exist in the DITA vocabulary
    // ({ owner, issue }, see lintVocabulary); null reason when checked.
    vocabularyWarnings,
    vocabularyUnavailable,
    // Same non-blocking panel on the page, a different kind of note: a
    // shared sch:let name declared with different values, or a prefix
    // declared with two URIs (English, as always).
    sharedLetWarnings: dedupWarnings,
    // XPath's own prefixes declared by Generate (sch:ns) because a rule used
    // them without a declaration, and the other prefixes used and declared
    // nowhere, with the rules that use them (a red warning on the page:
    // a Schematron processor refuses the document).
    addedNamespaces,
    undeclaredPrefixes,
    brdpCount: targetBRDPs.length,
    ruleCount,
  };
}

export { checkWellFormedSchematron, queryBindingForStandard };
