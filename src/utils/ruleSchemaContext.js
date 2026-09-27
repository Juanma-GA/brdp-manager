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

// Context URL per standard: `${base}${schema}.xsd`. Origin:
//   S1000D 4.2   -- real rulesContext values in public/brdp-template-4-2.xlsx
//                   (BRDP-S1-00006, -00219, -00377).
//   S1000D 4.1   -- real rulesContext values in public/brdp-template-4-1.xlsx
//                   (BRDP-EXT-00001, -00007, -00012, -00013, -00019).
//   S1000D 3.0.1 -- no real <contextrules context="…"> exists in this repo;
//                   the same flat-schema URL scheme is the one the 3.0.1
//                   BREX few-shot uses for xsi:noNamespaceSchemaLocation
//                   (public/brex-schema-summary-3-0-1.json). sources/S3.0.1/
//                   brex.xsd only types @context as a string.
export const SCHEMA_CONTEXT_URL_BASE = {
  'S1000D 4.2': 'http://www.s1000d.org/S1000D_4-2/xml_schema_flat/',
  'S1000D 4.1': 'http://www.s1000d.org/S1000D_4-1/xml_schema_flat/',
  'S1000D 3.0.1': 'http://www.s1000d.org/S1000D_3-0-1/xml_schema_flat/',
};

export function supportsSchemaContext(standard) {
  return Object.prototype.hasOwnProperty.call(SCHEMA_CONTEXT_URL_BASE, standard);
}

export function schemaContextUrl(standard, schema) {
  return `${SCHEMA_CONTEXT_URL_BASE[standard]}${schema}.xsd`;
}

// A context URL/value -> the schema name ("…/fault.xsd" -> "fault"); a value
// that isn't a .xsd reference is returned as written.
export function schemaNameFromContext(value) {
  const m = /([A-Za-z0-9_-]+)\.xsd\s*$/.exec(value || '');
  return m ? m[1] : (value || '').trim();
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
  // always as "<name>.xsd".
  const weak = [...(entry.weak || []), schema];
  for (const w of weak) {
    res.push(new RegExp(String.raw`\b${w}\s+${DOC_NOUN_EN}\b`, 'i'));
    res.push(new RegExp(String.raw`\b${DOC_NOUN_ES}\s+(?:de\s+(?:tipo\s+)?)?${w}\b`, 'i'));
  }
  res.push(new RegExp(String.raw`\b${schema}\.xsd\b`, 'i'));
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

export function wrapRuleInSchemaContexts(ruleXml, format, standard, schemas) {
  const rule = (ruleXml || '').trim();
  const element = RULE_ELEMENT_BY_FORMAT[format];
  if (!schemas || schemas.length === 0 || !element || !supportsSchemaContext(standard)) return rule;
  return schemas
    .map((schema) => {
      const inner = schemas.length > 1 ? withSchemaId(rule, element, schema) : rule;
      const url = schemaContextUrl(standard, schema);
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

export function contextSchemasOfRule(ruleXml) {
  const text = (ruleXml || '').replace(/<!--[\s\S]*?-->/g, '');
  const schemas = [];
  let rest = text;
  for (const m of text.matchAll(CONTEXT_BLOCK_RE)) {
    const attr = m[1] === 'contextRules' ? 'rulesContext' : 'context';
    const value = new RegExp(String.raw`\b${attr}\s*=\s*(["'])([^"']*)\1`).exec(m[2]);
    if (!value || !value[2].trim()) continue;
    const name = schemaNameFromContext(value[2]);
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
