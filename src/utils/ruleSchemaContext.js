// Suggest Rule part 2 -- schema context. Some decisions only apply to some
// document types (schemas). S1000D expresses that with context blocks:
//   4.2 / 4.1: <contextRules rulesContext="{URL}"><structureObjectRuleGroup>…
//   3.0.1:     <contextrules context="{URL}"><structrules>…
// The LLM always writes only the inner rule; this module decides whether to
// offer a schema choice, wraps the rule deterministically, and validates it
// per chosen schema. Pure functions, importable from Node.
//
// DITA has one merged schema set (a single variant in the schema cards), so
// it never gets a schema choice.

// Context URL per standard and per project "Schema location" (project
// configuration, S1000D only, stored as project_config.schemaLocation
// "flat" | "master" | "custom", with the custom pattern in
// project_config.schemaLocationPattern; absent = "flat", the default). A context block only applies to a data module whose
// own schema URL is exactly the one written here, so it must match the form
// the project's DMs use.
//
//   flat:   http://www.s1000d.org/S1000D_{issue}/xml_schema_flat/{schema}.xsd
//   master: http://www.s1000d.org/S1000D_{issue}/xml_schema_master/{folder}/{schema}Schema.xsd
//   custom: a pattern of the project's own, with {schema} once
//           (file:///C:/CSDB/schemas/{schema}.xsd, ../schemas/{schema}.xsd,
//           {schema}_v42.xsd) -- for CSDBs whose DMs point at local or
//           relative copies of the schemas.
//
// Options per standard (SCHEMA_LOCATION_OPTIONS): 3.0.1 flat / master /
// custom; 4.1 and 4.2 flat / custom -- S1000D publishes no master schema set
// for 4.x, so a 4.x project with "master" stored (older data) is read as flat
// (schemaLocationOf), and saving its configuration stores flat.
//
// Origin of each form:
//   flat, 4.2   -- real rulesContext values in public/brdp-template-4-2.xlsx
//                  (BRDP-S1-00219) and Lufthansa's BRDP-S1-00006 valueAllowed.
//   flat, 4.1   -- real rulesContext values in public/brdp-template-4-1.xlsx.
//   flat, 3.0.1 -- the same URL scheme the 3.0.1 BREX few-shot uses for
//                  xsi:noNamespaceSchemaLocation (public/brex-schema-summary-3-0-1.json).
//   master      -- 3.0.1 only. sources/SchemasS1000D holds only the flat set;
//                  the master names come from a real 3.0.1 project list of
//                  approved schema locations (public/brex-schema-summary-sch.json,
//                  BRDP-A1-00100) and a real 3.0.1 project DM
//                  (…/xml_schema_master/dm/descriptSchema.xsd). Data module
//                  schemas live under dm/; the four non-DM schemas have their
//                  own folder: comment/commentSchema.xsd, ddn/ddnSchema.xsd,
//                  dml/dmlSchema.xsd, pm/pmSchema.xsd.
//
// The project's setting travels through the app as ONE string ("location"):
// "flat", "master", or the custom pattern itself (a pattern always contains
// {schema}, so it can never be mistaken for the other two). Being a plain
// string keeps it a stable React dependency.
export const SCHEMA_LOCATIONS = ['flat', 'master', 'custom'];
export const DEFAULT_SCHEMA_LOCATION = 'flat';
export const SCHEMA_PLACEHOLDER = '{schema}';

export const SCHEMA_CONTEXT_ISSUE = {
  'S1000D 4.2': '4-2',
  'S1000D 4.1': '4-1',
  'S1000D 3.0.1': '3-0-1',
};

export const SCHEMA_LOCATION_OPTIONS = {
  'S1000D 4.2': ['flat', 'custom'],
  'S1000D 4.1': ['flat', 'custom'],
  'S1000D 3.0.1': ['flat', 'master', 'custom'],
};

// Master folder of the schemas that aren't data modules; every other schema
// is under dm/.
export const MASTER_SCHEMA_FOLDER = { comment: 'comment', ddn: 'ddn', dml: 'dml', pm: 'pm' };

export function supportsSchemaContext(standard) {
  return Object.prototype.hasOwnProperty.call(SCHEMA_CONTEXT_ISSUE, standard);
}

export function schemaLocationOptions(standard) {
  return SCHEMA_LOCATION_OPTIONS[standard] || [];
}

export function isCustomSchemaLocation(location) {
  return typeof location === 'string' && location.includes(SCHEMA_PLACEHOLDER);
}

// Validation of a custom pattern (Project Configuration; the backend applies
// the same rules on save, backend/app/api/routes/projects.py). Returns null
// when valid, else { code, params } -- shown in EN/ES via
// config.fields.schemaPatternErrors.<code>:
//   empty, missing_placeholder, repeated_placeholder, line_break,
//   forbidden_char { char } (" < & would break the XML attribute it is
//   written into; ' and > are written as-is, inside "…").
export function validateSchemaPattern(pattern) {
  const value = String(pattern ?? '');
  if (!value.trim()) return { code: 'empty', params: {} };
  if (/[\r\n]/.test(value)) return { code: 'line_break', params: {} };
  const bad = /["<&]/.exec(value);
  if (bad) return { code: 'forbidden_char', params: { char: bad[0] } };
  const count = value.split(SCHEMA_PLACEHOLDER).length - 1;
  if (count === 0) return { code: 'missing_placeholder', params: {} };
  if (count > 1) return { code: 'repeated_placeholder', params: {} };
  return null;
}

// The project's schema location from its project_config (+ its standard):
// "flat" | "master" | the custom pattern. Absent or unknown -> flat; "master"
// on a standard that has no master option (4.x) -> flat; "custom" with an
// invalid pattern (only possible by editing the database by hand: the
// configuration page and the backend refuse to save one) -> flat.
export function schemaLocationOf(projectConfig, standard) {
  const value = projectConfig?.schemaLocation;
  const options = standard ? schemaLocationOptions(standard) : SCHEMA_LOCATIONS;
  if (value === 'custom') {
    const pattern = projectConfig?.schemaLocationPattern;
    return options.includes('custom') && !validateSchemaPattern(pattern) ? pattern.trim() : DEFAULT_SCHEMA_LOCATION;
  }
  return options.includes(value) ? value : DEFAULT_SCHEMA_LOCATION;
}

// The single generator of a schema URL for the project's setting: context
// blocks of accepted rules, xsi:noNamespaceSchemaLocation of rule-test
// examples, the BREX DM's own brex.xsd, and the URLs Generate rewrites.
export function schemaContextUrl(standard, schema, location = DEFAULT_SCHEMA_LOCATION) {
  if (isCustomSchemaLocation(location)) return location.replace(SCHEMA_PLACEHOLDER, schema);
  const base = `http://www.s1000d.org/S1000D_${SCHEMA_CONTEXT_ISSUE[standard]}`;
  if (location === 'master') {
    return `${base}/xml_schema_master/${MASTER_SCHEMA_FOLDER[schema] || 'dm'}/${schema}Schema.xsd`;
  }
  return `${base}/xml_schema_flat/${schema}.xsd`;
}

const SCHEMA_NAME_RE = '([A-Za-z0-9_-]+)';
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function patternRegex(pattern) {
  const [before, after] = pattern.split(SCHEMA_PLACEHOLDER);
  return new RegExp(`^${escapeRe(before)}${SCHEMA_NAME_RE}${escapeRe(after)}$`);
}

// Strict recognition (Generate's rewriting): the schema name when `value` is
// a schema URL of this standard in one of the three forms -- flat or master
// of the project's own issue, or the CURRENT custom pattern (matched as a
// whole, so "{schema}_v42.xsd" turns proced_v42.xsd into "proced") --, else
// null. A URL of another issue, another host or another pattern is not
// recognized (Generate leaves it as written and reports it).
export function recognizeSchemaUrl(value, standard, location = DEFAULT_SCHEMA_LOCATION) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (isCustomSchemaLocation(location)) {
    const m = patternRegex(location).exec(text);
    if (m) return m[1];
  }
  const issue = SCHEMA_CONTEXT_ISSUE[standard];
  if (!issue) return null;
  const base = escapeRe(`http://www.s1000d.org/S1000D_${issue}`);
  const flat = new RegExp(`^${base}/xml_schema_flat/${SCHEMA_NAME_RE}\\.xsd$`).exec(text);
  if (flat) return flat[1];
  const master = new RegExp(`^${base}/xml_schema_master/([A-Za-z0-9_-]+)/${SCHEMA_NAME_RE}Schema\\.xsd$`).exec(text);
  if (master && master[1] === (MASTER_SCHEMA_FOLDER[master[2]] || 'dm')) return master[2];
  return null;
}

// Lenient recognition (rule test engine, precedent labels, comparison): the
// custom pattern first when one is given, then any "…/<name>.xsd" or
// "…/<name>Schema.xsd" ("…/xml_schema_flat/fault.xsd" and
// "…/xml_schema_master/dm/faultSchema.xsd" -> "fault"); a value that isn't a
// .xsd reference is returned as written.
export function schemaNameFromContext(value, location = null) {
  if (isCustomSchemaLocation(location)) {
    const m = patternRegex(location).exec(String(value ?? '').trim());
    if (m) return m[1];
  }
  const m = /([A-Za-z0-9_-]+)\.xsd\s*$/.exec(value || '');
  if (!m) return (value || '').trim();
  const master = /(.+)Schema$/.exec(m[1]);
  return master ? master[1] : m[1];
}

// ---------------------------------------------------------------------------
// Word -> schema map (English and Spanish). Built from the real variant list
// of each standard's schema cards (document_schemas of GET /api/schema-cards);
// entries for schemas a standard doesn't have are simply ignored for it.
//
//   strong: matched anywhere (whole words) -- specific enough on their own.
//   weak:   common words ("fault", "process", "comment") -- only count next
//           to a document-type noun: "<word> data module(s)/DM(s)/schema",
//           "módulo(s) de datos/DM/esquema (de) <word>", or "<schema>.xsd".
// Patterns are written without accents (text is accent-folded first) and are
// case-insensitive; acronyms (cs: true) are case-sensitive, so "ipd" in a
// sentence never counts but "IPD" does.
const DOC_NOUN_EN = String.raw`(?:data\s+modules?|DMs?|schemas?|XSD)`;
const DOC_NOUN_ES = String.raw`(?:modulos?\s+de\s+datos|DMs?|esquemas?)`;

export const SCHEMA_MENTION_MAP = {
  appliccrossreftable: {
    strong: [
      String.raw`applicability\s+cross[-\s]reference\s+tables?`,
      String.raw`tablas?\s+de\s+referencias?\s+cruzadas?\s+de\s+aplicabilidad`,
      { re: String.raw`ACTs?`, cs: true },
    ],
  },
  brdoc: {
    strong: [String.raw`business\s+rules?\s+documents?`, String.raw`documentos?\s+de\s+reglas\s+de\s+negocio`],
  },
  // "the BREX" usually means the BREX itself, not BREX data modules -- weak.
  brex: { weak: ['BREX'] },
  checklist: {
    strong: [String.raw`check[-\s]?lists?`, String.raw`listas?\s+de\s+(?:comprobacion|verificacion|chequeo)`],
  },
  comment: { weak: ['comments?', 'comentarios?'] },
  comrep: {
    strong: [
      String.raw`common\s+information\s+repositor(?:y|ies)`,
      String.raw`repositorios?\s+comun(?:es)?\s+de\s+informacion`,
      String.raw`repositorios?\s+de\s+informacion\s+comun`,
      { re: 'CIRs?', cs: true },
    ],
  },
  condcrossreftable: {
    strong: [
      String.raw`conditions?\s+cross[-\s]reference\s+tables?`,
      String.raw`tablas?\s+de\s+referencias?\s+cruzadas?\s+de\s+condiciones`,
      { re: 'CCTs?', cs: true },
    ],
  },
  container: { weak: ['containers?', 'contenedor(?:es)?'] },
  crew: { strong: ['crew', 'tripulacion'] },
  ddn: { strong: [String.raw`data\s+dispatch\s+notes?`, { re: 'DDNs?', cs: true }] },
  descript: {
    strong: ['descriptive', 'descriptiv[oa]s?'],
    weak: [String.raw`(?<!wiring\s+data\s+)descriptions?`, 'descripcion(?:es)?'],
  },
  dml: {
    strong: [
      String.raw`data\s+management\s+lists?`,
      String.raw`listas?\s+de\s+gestion\s+de\s+datos`,
      { re: 'DMLs?', cs: true },
    ],
  },
  fault: {
    strong: [String.raw`fault\s+(?:isolation|reporting)`, String.raw`aislamiento\s+de\s+(?:fallos|averias)`],
    weak: ['faults?', 'fallos?', 'averias?'],
  },
  frontmatter: {
    strong: [String.raw`front[-\s]?matter`, String.raw`paginas\s+preliminares`, String.raw`materia\s+preliminar`],
  },
  icnmetadata: { strong: [String.raw`ICN\s+metadata`, String.raw`metadatos\s+(?:de\s+)?ICN`] },
  ipd: {
    strong: [
      String.raw`illustrated\s+parts\s+(?:data|catalog(?:ue)?)`,
      String.raw`catalogo\s+ilustrado\s+de\s+piezas`,
      String.raw`datos\s+ilustrados\s+de\s+piezas`,
      { re: 'IPDs?', cs: true },
      { re: 'IPCs?', cs: true },
    ],
  },
  learning: { weak: ['learning', 'training', 'formacion', 'aprendizaje'] },
  pm: {
    strong: [String.raw`publication\s+modules?`, String.raw`modulos?\s+de\s+publicacion`],
    weak: ['PM'],
  },
  prdcrossreftable: {
    strong: [
      String.raw`products?\s+cross[-\s]reference\s+tables?`,
      String.raw`tablas?\s+de\s+referencias?\s+cruzadas?\s+de\s+productos?`,
      { re: 'PCTs?', cs: true },
    ],
  },
  proced: {
    strong: ['procedural', 'procedimental(?:es)?'],
    weak: ['procedures?', 'procedimientos?'],
  },
  process: { weak: ['process', 'procesos?'] },
  sb: {
    strong: [String.raw`service\s+bulletins?`, String.raw`boletin(?:es)?\s+de\s+servicio`],
    weak: ['SB'],
  },
  schedul: {
    strong: [
      String.raw`maintenance\s+planning`,
      String.raw`scheduled\s+maintenance`,
      String.raw`maintenance\s+schedules?`,
      String.raw`planificacion\s+del?\s+mantenimiento`,
      String.raw`mantenimiento\s+programado`,
    ],
    weak: ['schedul(?:e|ed|ing)'],
  },
  scocontent: { strong: [String.raw`SCO\s+content`, String.raw`SCORM\s+content(?!\s+packages?)`] },
  scormcontentpackage: {
    strong: [String.raw`SCORM\s+content\s+packages?`, String.raw`paquetes?\s+de\s+contenido\s+SCORM`],
  },
  techrep: { strong: [String.raw`technical\s+repositor(?:y|ies)`, String.raw`repositorios?\s+tecnicos?`] },
  update: {
    strong: [String.raw`data\s+update\s+files?`, String.raw`ficheros?\s+de\s+actualizacion\s+de\s+datos`],
    weak: ['updates?', 'actualizacion(?:es)?'],
  },
  wrngdata: {
    strong: [String.raw`wiring\s+data(?!\s+description)`, String.raw`datos\s+de\s+cableado`],
  },
  wrngflds: {
    strong: [String.raw`wiring\s+(?:fields?|data\s+description)`, String.raw`campos\s+de\s+cableado`],
  },
};

function foldAccents(text) {
  return (text || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function mentionRegexes(schema) {
  const entry = SCHEMA_MENTION_MAP[schema] || {};
  const res = [];
  for (const p of entry.strong || []) {
    const src = typeof p === 'string' ? p : p.re;
    res.push(new RegExp(String.raw`\b${src}\b`, typeof p === 'string' ? 'i' : ''));
  }
  // Every schema's own file name counts next to a document-type noun, and
  // always as "<name>.xsd" or its master file name "<name>Schema.xsd".
  const weak = [...(entry.weak || []), schema];
  for (const w of weak) {
    res.push(new RegExp(String.raw`\b${w}\s+${DOC_NOUN_EN}\b`, 'i'));
    res.push(new RegExp(String.raw`\b${DOC_NOUN_ES}\s+(?:de\s+(?:tipo\s+)?)?${w}\b`, 'i'));
  }
  res.push(new RegExp(String.raw`\b${schema}(?:Schema)?\.xsd\b`, 'i'));
  return res;
}

// Schemas (from `documentSchemas`) the text mentions, in documentSchemas
// order.
export function detectSchemaMentions(text, documentSchemas) {
  const folded = foldAccents(text);
  return documentSchemas.filter((schema) => mentionRegexes(schema).some((re) => re.test(folded)));
}

// ---------------------------------------------------------------------------
// When to offer the schema choice. `cards` is GET /api/schema-cards's
// `cards` for the element names found in the BRDP text; `documentSchemas`
// its `document_schemas`.
//
// The selector opens on its own ONLY when the text mentions a schema. An
// element that exists in just some schemas is NOT a reason to ask: a
// general rule is still correct -- in the schemas without that element it
// simply never fires (<table> is in 13 of 28 4.2 schemas; opening the
// selector for it asked on almost every rule). `partial` is still computed:
// whenever the selector IS open (a mention, or "Limit to specific
// schemas…"), the schemas lacking an element are disabled with the reason.
export function coverageOf(entry) {
  const schemas = new Set();
  for (const variant of entry?.variants || []) variant.schemas.forEach((s) => schemas.add(s));
  return schemas;
}

export function decideRuleSchemaContext({ standard, documentSchemas, cards, text }) {
  if (!supportsSchemaContext(standard) || !documentSchemas || documentSchemas.length === 0) {
    return { supported: false, showSelector: false, variants: [], mentioned: [], partial: false };
  }
  const coverage = Object.entries(cards || {}).map(([name, entry]) => [name, coverageOf(entry)]);
  const mentioned = detectSchemaMentions(text, documentSchemas);
  const variants = documentSchemas.map((schema) => {
    const missing = coverage.filter(([, schemas]) => !schemas.has(schema)).map(([name]) => name);
    const disabled = missing.length > 0;
    return { schema, disabled, missing, preChecked: !disabled && mentioned.includes(schema) };
  });
  const partial = variants.some((v) => v.disabled);
  return { supported: true, showSelector: mentioned.length > 0, variants, mentioned, partial };
}

// ---------------------------------------------------------------------------
// Deterministic wrapper (docs request, Part 4): one context block per chosen
// schema, each with the same inner rule. The rule's id is xs:ID in every
// BREX issue (sources/S3.0.1/brex.xsd bodyatt, brex4.x.xsd), so with more
// than one schema each copy gets "{id}-{schema}" -- the same id twice would
// make the assembled BREX invalid. brDecisionRef (4.2) keeps the BRDP id.
const RULE_ELEMENT_BY_FORMAT = {
  'BREX-4.2': 'structureObjectRule',
  'BREX-4.1': 'structureObjectRule',
  'BREX-3.0.1': 'objrule',
};

function indent(text, spaces) {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => (line.trim() ? pad + line : line))
    .join('\n');
}

function withSchemaId(ruleXml, element, schema) {
  const startRe = new RegExp(String.raw`<${element}\b[^>]*>`);
  return ruleXml.replace(startRe, (tag) =>
    tag.replace(/(\sid\s*=\s*)(["'])([^"']*)\2/, (_, pre, q, id) => `${pre}${q}${id}-${schema}${q}`)
  );
}

export function wrapRuleInSchemaContexts(ruleXml, format, standard, schemas, location = DEFAULT_SCHEMA_LOCATION) {
  const rule = (ruleXml || '').trim();
  const element = RULE_ELEMENT_BY_FORMAT[format];
  if (!schemas || schemas.length === 0 || !element || !supportsSchemaContext(standard)) return rule;
  return schemas
    .map((schema) => {
      const inner = schemas.length > 1 ? withSchemaId(rule, element, schema) : rule;
      const url = schemaContextUrl(standard, schema, location);
      return format === 'BREX-3.0.1'
        ? `<contextrules context="${url}">\n  <structrules>\n${indent(inner, 4)}\n  </structrules>\n</contextrules>`
        : `<contextRules rulesContext="${url}">\n  <structureObjectRuleGroup>\n${indent(inner, 4)}\n  </structureObjectRuleGroup>\n</contextRules>`;
    })
    .join('\n');
}

export function hasSchemaContextBlock(ruleXml) {
  return /<contextRules\b[^>]*\brulesContext\s*=\s*["']\s*[^"'\s]|<contextrules\b[^>]*\bcontext\s*=\s*["']\s*[^"'\s]/.test(
    ruleXml || ''
  );
}

// Which schemas a stored rule applies to (Part 1, precedent labels):
// { schemas: [...] from its context blocks, general: true when it also has a
// rule outside any context block }. Comments are ignored.
const CONTEXT_BLOCK_RE =
  /<(contextRules|contextrules)\b([^>]*)>[\s\S]*?<\/\1\s*>/g;

export function contextSchemasOfRule(ruleXml, location = null) {
  const text = (ruleXml || '').replace(/<!--[\s\S]*?-->/g, '');
  const schemas = [];
  let rest = text;
  for (const m of text.matchAll(CONTEXT_BLOCK_RE)) {
    const attr = m[1] === 'contextRules' ? 'rulesContext' : 'context';
    const value = new RegExp(String.raw`\b${attr}\s*=\s*(["'])([^"']*)\1`).exec(m[2]);
    if (!value || !value[2].trim()) continue;
    const name = schemaNameFromContext(value[2], location);
    if (!schemas.includes(name)) schemas.push(name);
    rest = rest.replace(m[0], '');
  }
  const general = /<(?:[\w.-]+:)?(?:structureObjectRule|objrule|pattern|rule)[\s>/]/.test(rest);
  return { schemas, general: schemas.length === 0 ? true : general };
}

// ---------------------------------------------------------------------------
// Per-schema validation (docs request, Part 5): an element of the rule's
// XPath that exists in the standard but NOT in one of the chosen schemas.
// `coverageByName` maps element name -> Set of schemas (from the cards);
// names without an entry (unknown, or not fetched) are skipped here -- the
// vocabulary check already reports unknown names.
export function checkRuleSchemaCoverage(elementNames, schemas, coverageByName) {
  const problems = [];
  for (const schema of schemas || []) {
    const missing = elementNames.filter((name) => coverageByName[name] && !coverageByName[name].has(schema));
    if (missing.length > 0) problems.push({ schema, missing });
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Generate (output only, never the stored rule): every schema URL a rule
// carries is rewritten to the project's CURRENT setting, so a rule accepted
// with flat URLs follows the project when it moves to a custom pattern.
// Rewritten, per format:
//   - the context of a context block: 4.x contextRules/@rulesContext,
//     3.0.1 contextrules/@context;
//   - each allowed value: 4.x objectValue/@valueAllowed, 3.0.1 objval/@val1
//     and @val2 (BRDP-S1-00006 lists the 9 allowed DM schema URLs there).
// A value is rewritten only when recognizeSchemaUrl() knows it (flat or
// master of the project's issue, or the current pattern), keeping the schema
// name. Never changed silently (HR7): a context that isn't recognized, and an
// allowed value that isn't recognized in a rule that checks
// @xsi:noNamespaceSchemaLocation (or that ends in .xsd), is left as written
// and reported in `unrecognized`. Comments are never touched. Returns
// { xml, rewritten: [{ where, from, to }], unrecognized: [{ where, value }] };
// `where` is "context" | "value".
const SCHEMA_URL_ATTRS = {
  'BREX-4.2': { context: { element: 'contextRules', attrs: ['rulesContext'] }, value: { element: 'objectValue', attrs: ['valueAllowed'] } },
  'BREX-4.1': { context: { element: 'contextRules', attrs: ['rulesContext'] }, value: { element: 'objectValue', attrs: ['valueAllowed'] } },
  'BREX-3.0.1': { context: { element: 'contextrules', attrs: ['context'] }, value: { element: 'objval', attrs: ['val1', 'val2'] } },
};

const decodeAttr = (v) =>
  v.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-fA-F]+);/g, (m, e) => {
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    if (e === 'amp') return '&';
    return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  });
const encodeAttr = (v, quote) =>
  v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(quote === '"' ? /"/g : /'/g, quote === '"' ? '&quot;' : '&apos;');

export function rewriteRuleSchemaUrls(ruleXml, format, standard, location = DEFAULT_SCHEMA_LOCATION) {
  const xml = String(ruleXml ?? '');
  const spec = SCHEMA_URL_ATTRS[format];
  const rewritten = [];
  const unrecognized = [];
  if (!spec || !supportsSchemaContext(standard)) return { xml, rewritten, unrecognized };
  const checksSchemaLocation = /noNamespaceSchemaLocation/.test(xml.replace(/<!--[\s\S]*?-->/g, ''));

  const rewriteTag = (tag, where, attrs) =>
    tag.replace(
      new RegExp(String.raw`(\s(${attrs.join('|')})\s*=\s*)(["'])([^"']*)\3`, 'g'),
      (full, pre, _name, quote, raw) => {
        const value = decodeAttr(raw);
        if (!value.trim()) return full;
        const schema = recognizeSchemaUrl(value, standard, location);
        if (!schema) {
          if (where === 'context' || checksSchemaLocation || /\.xsd\s*$/i.test(value)) unrecognized.push({ where, value });
          return full;
        }
        const url = schemaContextUrl(standard, schema, location);
        if (url === value.trim()) return full;
        rewritten.push({ where, from: value, to: url });
        return `${pre}${quote}${encodeAttr(url, quote)}${quote}`;
      }
    );

  const tagRe = new RegExp(String.raw`<(${spec.context.element}|${spec.value.element})\b[^>]*>`, 'g');
  // Comments are kept byte for byte: only the text between them is scanned.
  const out = xml
    .split(/(<!--[\s\S]*?-->)/)
    .map((segment) =>
      segment.startsWith('<!--')
        ? segment
        : segment.replace(tagRe, (tag, name) =>
            name === spec.context.element
              ? rewriteTag(tag, 'context', spec.context.attrs)
              : rewriteTag(tag, 'value', spec.value.attrs)
          )
    )
    .join('');
  return { xml: out, rewritten, unrecognized };
}

// Safety net after Generate (HR7): the context blocks of a generated BREX
// whose scope attribute is present but empty -- <contextRules rulesContext="">
// (4.x) / <contextrules context=""> (3.0.1). s1kd-brexcheck applies a block
// only when it has no scope attribute or the attribute is the DM's schema, so
// an empty one applies nowhere; the generators write the general block
// without the attribute and fold such stored blocks into it, so this should
// always be 0. Comments are ignored.
export function countEmptySchemaContextBlocks(xml) {
  const text = String(xml ?? '').replace(/<!--[\s\S]*?-->/g, '');
  const re = /<(?:[\w.-]+:)?(contextRules|contextrules)\b([^>]*)>/g;
  let count = 0;
  for (const m of text.matchAll(re)) {
    const attr = m[1] === 'contextRules' ? 'rulesContext' : 'context';
    const a = new RegExp(`\\s${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(m[2]);
    if (a && !(a[1] ?? a[2]).trim()) count += 1;
  }
  return count;
}

// The BREX DM's own xsi:noNamespaceSchemaLocation (brex.xsd) in the
// project's form -- the first <dmodule> start tag of a generated document.
export function setDmoduleSchemaLocation(xml, url) {
  return String(xml).replace(/<dmodule\b[^>]*>/, (tag) =>
    /\sxsi:noNamespaceSchemaLocation\s*=/.test(tag)
      ? tag.replace(/(\sxsi:noNamespaceSchemaLocation\s*=\s*)(["'])[^"']*\2/, (_, pre, q) => `${pre}${q}${encodeAttr(url, q)}${q}`)
      : tag
  );
}

// Generate: rewriteRuleSchemaUrls() over every approved rule, with the
// per-rule report the Generate page shows (identifier of each BRDP whose
// values were rewritten, and of each whose values were left as written).
export function rewriteApprovedRulesSchemaUrls(rules, format, standard, location = DEFAULT_SCHEMA_LOCATION) {
  const rewritten = [];
  const unrecognized = [];
  const out = rules.map((rule) => {
    const r = rewriteRuleSchemaUrls(rule.xml, format, standard, location);
    if (r.rewritten.length) rewritten.push({ identifier: rule.identifier, values: r.rewritten });
    if (r.unrecognized.length) unrecognized.push({ identifier: rule.identifier, values: r.unrecognized });
    return { ...rule, xml: r.xml };
  });
  return { rules: out, schemaUrls: { location, rewritten, unrecognized } };
}
