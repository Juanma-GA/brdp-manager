// Test rule (T2 of 4, T2b): the system prompt that asks the LLM for short
// aeronautical examples -- one that follows the Proposal's DECISION and one
// that goes against it (plus one of another schema for a context-scoped
// rule). T3b: the examples follow the decision, not the rule -- examples
// written from the rule followed a wrong rule too, so the test never caught
// it -- and the LLM no longer explains the rule (describeRule does,
// deterministically); it only flags a rule that does not seem to implement
// the Proposal.
// Pure function, same architecture as the other prompts: the application,
// not the LLM, builds each example on a real skeleton of its schema
// (utils/ruleTestSkeleton.js; T2b: the LLM only writes the content of the
// insertion point), checks it, runs the rule on it (utils/ruleTestEngine.js)
// and gives the verdict.
import { readLlmJson } from './llmJson.js';
import { buildSchemaFactsBlock, ruleValueLegend } from './shared.js';
import { placeSentence } from '../utils/schemaPlacement.js';
import { attributeCarrierLines, metadataXml } from '../utils/ruleTestSkeleton.js';

export const RULE_TEST_USER_MESSAGE = 'Write the test examples for this rule.';

// Elements that only reference or group other content: an LLM put text in
// a <dmRef> in the first real run, and the structural check cannot see text,
// so the rule is stated in the prompt.
const NO_TEXT_ELEMENTS = '<dmRef>, <dmRefIdent>, <dmCode>, <internalRef>, <pmRef>, <externalPubRef>';

function schemaInstructions(contextSchemas, placements, dita) {
  const rulePlacement = placements.find((p) => p.role === 'rule');
  const other = placements.find((p) => p.role === 'other');
  const groups = placements.filter((p) => p.role === 'rule' && p.group);
  const related = placements.filter((p) => p.role === 'rule' && p.relation);
  if (related.length > 1) return relationInstructions(related, dita);
  if (groups.length > 1) {
    // One schema per part of the rule (chooseTestSchemas' groups): the parts
    // look at elements that live in different schemas (topic types in DITA).
    // A part that only asks whether the document IS of that type ("/ddn",
    // rootOnly) gets one example only: nothing in it can change that.
    const kind = dita ? 'topic type' : 'schema';
    const oneOnly = groups.some((p) => p.rootOnly);
    const lines = groups.map(
      (p) => `- "${p.schema}": for ${p.group.map((n) => `<${n}>`).join(', ')}${p.rootOnly ? ' — ONE example only (see below)' : ''}`
    );
    return `The rule's parts look at elements that live in different ${kind}s, so the
examples are split by ${kind}. For EACH of these ${kind}s${oneOnly ? ' (except those marked "ONE example only")' : ''} write at least one
example that follows the decision and one that goes against it, each with
its "schema", and write in each only about the elements of its ${kind}:
${lines.join('\n')}`;
  }
  if (dita) {
    return `Every example is a DITA ${rulePlacement.schema} ("schema": "${rulePlacement.schema}").`;
  }
  if (!contextSchemas || contextSchemas.length === 0) {
    return `The rule is general: every example uses the "${rulePlacement.schema}" schema
("schema": "${rulePlacement.schema}").`;
  }
  const list = contextSchemas.join(', ');
  let text = `The rule applies ONLY to documents of the ${list} schema${contextSchemas.length > 1 ? 's' : ''}. Every
example that tests the rule uses "schema": "${rulePlacement.schema}".`;
  if (other) {
    text += `
Add a third example of the ${other.schema} schema ("schema": "${other.schema}",
"expected": "accept") whose content has what the rule checks, to show that
the rule does not apply there.`;
  }
  return text;
}

// Mejoras A, Part 2: the rule's checked element must (not) be inside
// another one (//commonInfo[not(ancestor::procedure)]) and no single schema
// allows both examples, so each case gets its own schema. Neutral on
// purpose: whether each example follows or goes against the decision is
// the decision's, never the rule's.
const relationPhrase = (r, inside) =>
  r.axis === 'parent'
    ? inside
      ? `directly inside <${r.ancestor}>`
      : `directly inside an element other than <${r.ancestor}>`
    : inside
      ? `inside <${r.ancestor}>`
      : `NOT inside <${r.ancestor}>`;

function relationInstructions(related, dita) {
  const kind = dita ? 'topic type' : 'schema';
  const r = related[0].relation;
  const lines = related.map((p) => {
    const way = p.relation.way ? `; way: ${p.relation.way.join('/')}` : '';
    return `- "${p.schema}": examples where <${r.element}> is ${relationPhrase(p.relation, p.relation.inside)}${way}`;
  });
  return `The rule's path selects <${r.element}> only when it is ${relationPhrase(r, !r.negated)}.
No single ${kind} allows both cases, so the examples are split by ${kind}:
${lines.join('\n')}
Write at least one example of each, each with its "schema". Whether each one
follows or goes against the decision is up to the decision.`;
}

// The minimal identification and status section, indented under a line.
function minimalSection(p) {
  return metadataXml(p.metadata.tree, 2).xml;
}

// What each document root is called in the prompt. The data module's text
// (and the data update file's, which has always said "data module") never
// changes; pm, ddn and dml got their sections later.
const DOCUMENT_NOUNS = { pm: 'publication module', ddn: 'data dispatch note', dml: 'data management list' };
const documentNoun = (root) => DOCUMENT_NOUNS[root] || 'data module';

// Rule test on DM metadata: the rule looks at the data module's
// identification and status section, so the LLM writes that whole section
// for every example (its "metadata"), starting from the minimal one.
// `alsoContent`: the rule looks at the content too, so a reject example may
// break the decision in either place.
function metadataLine(p, alsoContent = false) {
  const element = p.metadata.element;
  const where = alsoContent
    ? `; a reject example may go against the decision here, in the content, or
  both:`
    : ` — the values of the reject example go
  HERE, never in a reference (<dmRef>) of the content:`;
  return `  The rule ${alsoContent ? 'also ' : ''}looks at the ${documentNoun(p.root)}'s identification and status section:
  your "metadata" is the WHOLE <${element}> of the example, written
  directly inside <${p.root}>. Start from this minimal, valid one and change
  only what the decision is about${where}
${minimalSection(p)}${sectionRouteLines(p)}`;
}

// Ruta del esquema, Part 1: the elements the rule looks at in the section
// that are not directly inside any of its elements (placeExample's
// metadata.routes, schemaPlacement.js): the valid way down to each (every
// way, at most 3, when there are several), where its first container goes
// and, with a single way, that container with every required child. Nothing
// when there are none: the prompt does not change.
const indentBlock = (text, pad) => text.split('\n').map((line) => `${pad}${line}`).join('\n');
function sectionRouteLines(p) {
  const routes = p.metadata?.routes || [];
  return routes
    .map((r) => {
      const ways = r.paths.map((path) => `
    ${path.join('/')}`).join('');
      if (r.several) {
        return `
  <${r.target}> is not directly inside any element of that section. Valid ways
  down in this schema (use one of them):${ways}`;
      }
      const pos = r.position;
      const where = pos.after
        ? `right after <${pos.after}>`
        : pos.before
          ? `right before <${pos.before}>`
          : 'as its first child';
      const minimal = r.minimal
        ? `,
  with its required children (a minimum valid one; "…" is text you write):
${indentBlock(r.minimal, '    ')}`
        : '.';
      return `
  <${r.target}> is not directly inside any element of that section. The valid
  way down in this schema:${ways}
  <${pos.container}> goes inside <${pos.parent}>, ${where}${minimal}`;
    })
    .join('');
}

// Pending of the test rule (Part 1): the rule looks at <B> somewhere inside
// <A> ("A//B"), and the application knows, from the schema's graph, the
// shortest valid way to put one inside the other (nestingPaths). Nothing
// when the rule has no such step or the schema has no such path.
function nestingLines(p) {
  return (p.nestings || [])
    .map((n) => `
  To put <${n.descendant}> inside <${n.ancestor}>, the valid nesting is: ${n.path.join('/')}.`)
    .join('');
}

// Ajustes tras la pasada real de las plantillas, Part 3: the valid way
// down from the insertion point to the elements the rule checks, when they
// are not direct children of it (contentRoutes) -- the containers on the
// way (with their own attributes) and a short card of the elements.
// Mejoras D, Part 1: the insertion point moved up to hold the outermost
// element of the rule's path (<figure> for //figure//legend/deflist/def):
// the whole way the examples write it, so the checked element is never put
// on the shortest way of its own (para0/para/deflist/def).
function writePathLines(p) {
  return (p.writePaths || [])
    .map((way) => `
  The rule's path, written from <${way[0]}>: ${way.join('/')}. Write <${way[way.length - 1]}> by exactly this way, never on a shorter one.`)
    .join('');
}

function routeLines(p) {
  const r = p.routes;
  if (!r) return '';
  const attrs = (list) => (list.length ? ` (${list.map((a) => `@${a}`).join(', ')})` : '');
  const steps = r.steps.map((st) => `
    <${st.parent}>${attrs(st.attributes)} > ${st.children.map((c) => `<${c}>`).join(', ')}`);
  const cards = r.cards.map((c) => {
    const children = c.children.map((ch) => `${ch.name}${attrs(ch.attributes)}`).join(', ');
    const more = c.childrenOmitted ? `, +${c.childrenOmitted} more` : '';
    return `
    <${c.name}>: children ${children || 'none'}${more}; attributes ${c.attributes.length ? c.attributes.map((a) => `@${a}`).join(', ') : 'none besides the common ones'}`;
  });
  return `
  The elements the rule looks at are not directly inside <${r.from}>. The valid way down in this ${p.kindLabel || 'schema'} (a container > what goes inside it):${steps.join('')}
  What those elements contain (use only these names, never invented attributes):${cards.join('')}`;
}

// GMC, Part 1.2: the elements that carry each attribute the rule checks
// (//@x or X//@x), nearest first, and the valid way to the nearest; Part
// 1.3: an attribute only the root carries goes in "rootAttributes". Nothing
// for a rule without such attributes: the prompt does not change.
function carrierLines(p) {
  const lines = (p.attributeCarriers || [])
    .filter((c) => c.inPrompt)
    .flatMap((info) => attributeCarrierLines(info, { withMinimal: true }));
  for (const r of p.rootAttributes || []) {
    lines.push(`@${r.attribute} goes only on <${r.element}>, which the application writes: give its value in the example's "rootAttributes" ({"${r.attribute}": "…"}), never in the content.`);
  }
  return lines.map((l) => `\n${indentBlock(l, '  ')}`).join('');
}

// Mejoras C, Part 2: where each element the rule names goes when it does
// not fit where this example is written (elementPlaces, schemaPlacement.js)
// -- its parent, the way down from the root and, in the identification and
// status section, between which siblings. Nothing when every element fits.
function placeLines(p) {
  return (p.places || []).map((place) => `
  ${placeSentence(place)}`).join('');
}

function placementLine(p, dita) {
  const allowed = p.allowedChildren.length > 0 ? p.allowedChildren.join(', ') : 'text only';
  const kind = dita ? 'topic type' : 'schema';
  const titled = p.titled || [];
  if (p.rootOnly) {
    return `- ${kind} "${p.schema}": the rule's part for it only asks whether the document IS a
  <${p.root}>, so every <${p.root}> meets it whatever it contains. The application
  builds the whole document (${p.path.join('/')}${p.metadata ? ', with its minimal identification and status section' : ''}):
  write ONE example of this ${kind}, with no "content", and the "expected" the
  decision gives to any ${documentNoun(p.root) === 'data module' ? `<${p.root}>` : documentNoun(p.root)}.`;
  }
  if (!p.insertion) {
    // T4: the rule checks the document's root element. T4b: a topic's
    // <title> is mandatory, so the LLM writes it here.
    return `- ${kind} "${p.schema}": your content is the WHOLE document — the complete
  <${p.root}> root element with everything inside it.${
      titled.includes(p.root) ? `
  <${p.root}> starts with its required <title>.` : ''
    }${
      p.metadata ? `
  <${p.root}> starts with its identification and status section; start from
  this minimal, valid one:
${minimalSection(p)}` : ''
    }
  Allowed directly inside <${p.root}>: ${allowed}.${nestingLines(p)}${placeLines(p)}`;
  }
  if (p.metadata?.insertion && p.contentInsertion === false) {
    return `- ${kind} "${p.schema}": the application builds the rest of the document
  (${p.path.join('/')}); write no "content".
${metadataLine(p)}${carrierLines(p)}${placeLines(p)}`;
  }
  // GMC, Part 1.3: the rule only checks attributes the root carries.
  if (p.contentInsertion === false && (p.rootAttributes || []).length > 0) {
    return `- ${kind} "${p.schema}": the application builds the whole document
  (${p.path.join('/')}${p.metadata ? ', with its minimal identification and status section' : ''}); write no "content".${carrierLines(p)}${placeLines(p)}`;
  }
  // T4b: the skeleton's own <title> (a DITA topic's, mandatory).
  const titleLine =
    titled.length > 0
      ? `
  The application already writes the <title> of ${titled.map((n) => `<${n}>`).join(', ')}; never write another one there.`
      : '';
  const relationLine = p.relation?.way
    ? `
  Here <${p.relation.element}> is ${relationPhrase(p.relation, p.relation.inside)}: ${p.relation.way.join('/')}.`
    : '';
  return `- ${kind} "${p.schema}": your content goes directly inside <${p.insertion}>, at
  ${p.path.join('/')}.${titleLine}${relationLine}
  Allowed directly inside <${p.insertion}> in this ${kind}: ${allowed}.${writePathLines(p)}${nestingLines(p)}${routeLines({ ...p, kindLabel: kind })}${
    p.metadata?.insertion ? `
${metadataLine(p, true)}` : ''
  }${carrierLines(p)}${placeLines(p)}`;
}

// T4b: a rule whose context depends on the title of an element (for example
// *[title = ('A', 'B')]//table) only runs on content under an element with
// that title. In a real run the LLM put the title on the table itself
// (table/title), so nothing matched and the test was inconclusive. The
// example here is generic on purpose (never a real project's titles).
const TITLE_DEPENDENT_RE = /\[[^\]]*(?<![@\w:$-])title\b/;

export function ruleDependsOnTitle(matchExpressions = []) {
  return matchExpressions.some((e) => TITLE_DEPENDENT_RE.test(e));
}

function titleDependentInstructions() {
  return `

THE RULE DEPENDS ON A TITLE: it only runs on content under an element whose
<title> has a given value. In every example that must be checked, create
inside your content an element that takes a title — for example a
<section> — give it that <title>, and put the checked content inside it:
  <section><title>Parts list</title><table>…</table></section>
Never put that title on the checked element itself (never <table><title>…),
and never rely on the topic's own title.`;
}

// Plantillas, Part 4: a BREX path that is a true/false condition
// (s1kd-brexcheck's boolean objectPath) is judged on the whole document --
// say which condition each example has to meet or avoid, and the names it
// looks at. conditions: ruleConditions() of the engine.
function conditionInstructions(conditions) {
  const lines = conditions.map((c) => {
    const path = c.path.replace(/\s+/g, ' ').trim();
    const names = c.names.length ? ` It looks at ${c.names.join(', ')}.` : '';
    if (c.flag === '0') return `- ${path}\n  The rule rejects a document where this is TRUE: the reject example makes it\n  true, the accept example makes it false.${names}`;
    if (c.flag === '1') return `- ${path}\n  The rule rejects a document where this is FALSE: the reject example makes\n  it false, the accept example makes it true.${names}`;
    return `- ${path}\n  Informative only (it never rejects a document).${names}`;
  });
  return `

THE RULE CHECKS A CONDITION ON THE WHOLE DOCUMENT: its path is true or false,
not a set of nodes. Write the examples so that:
${lines.join('\n')}`;
}

// Mejoras G, Part 1.6: the rule compares with a path that can give several
// nodes -- the examples must show that case, or the test never sees it
// (BRDP-EXT-02792: normalize-space() over ancestor::applic/displaytext/p).
function severalInstructions(several) {
  const lines = several.map((s) => `- ${s.path} can give several <${s.element}>.`);
  return `

SEVERAL NODES: the rule compares with paths that can give more than one node:
${lines.join('\n')}
At least one example meant to be accepted and one meant to be rejected carry
two or more of that element there, with different values.`;
}

// Barrido final 1/2: a rule that looks at tables -- one valid CALS table
// with a merged row, built by the application from the schema
// (calsTableModel), and the three things a merged row needs. Mistral wrote
// merged rows that did not validate (titled-context, c8e8fac).
function tableModelInstructions(model) {
  return `

MODEL TABLE: every table in an example is a complete CALS table like this
one (valid in this schema; your columns and texts are your own):
${model}
- Every colname has its <colspec>, in column order; cols is the number of
  columns.
- A cell merged into the next row has morerows="1", and the row below has NO
  <entry> in that column ("A-100" also covers row 2 of column c1).
- Every row keeps at least one <entry> of its own, and a morerows never
  reaches past the last row.`;
}

// T4: how each example is built, for the placements offered.
function buildingInstructions(standard, placements, dita) {
  const kind = dita ? 'topic type' : 'schema';
  // GMC, Part 1.3: every example only gives the root's attribute values.
  if (placements.every((p) => p.contentInsertion === false && !p.metadata?.insertion && (p.rootAttributes || []).length > 0)) {
    return `HOW EACH EXAMPLE IS BUILT: the application builds the whole ${standard}
document of the example's ${kind}, root included; you only give the values
of the root's attributes the rule checks, in "rootAttributes".
${placements.map((p) => placementLine(p, dita)).join('\n')}`;
  }
  if (placements.every((p) => !p.insertion)) {
    return `HOW EACH EXAMPLE IS BUILT: the rule checks the document's root element, so
your "content" is the whole ${standard} document of the example's ${kind}:
write the complete root element.
${placements.map((p) => placementLine(p, dita)).join('\n')}`;
  }
  return `HOW EACH EXAMPLE IS BUILT: the application builds a real ${standard} document
of the example's ${kind} and puts your "content" at one fixed point. Write
ONLY that content — never the element it goes into, never the elements
around it, never the document root.
${placements.map((p) => placementLine(p, dita)).join('\n')}`;
}

// Dosier, Part 2: a rule that reads other files of a DITA dossier. Each
// example is a dossier: the ditamap ("content") and up to `maxFiles` more
// files ("files"). Only these rules get this block; every other prompt is
// unchanged.
function dossierInstructions(standard, dossier) {
  return `HOW EACH EXAMPLE IS BUILT: the rule reads other files of a DITA dossier
(doc(), doc-available(), document()), so each example is a DOSSIER: a folder
with the ditamap the rule runs on and the files the ditamap points to.
- "content": the whole ditamap (${dossier.mainPath}, at the top of the folder):
  a complete ${standard} <map> whose <topicref href="…"> point to the files by
  their path relative to the folder (for example "topics/safety.dita").
- "files": at most ${dossier.maxFiles} more files, each {"path": "…", "content": "…"}:
  the path relative to the folder and the complete DITA document (a
  ${dossier.types.filter((t) => t !== 'map').join(', ')} root element), at most
  ${dossier.maxLines} lines each.
- A conref to another file is its path relative to the file that contains
  it, then #topic-id/element-id (for example "../common/notes.dita#notes/w1").
- The reject example goes against the decision in the FILES (a topic that is
  missing, a note that is not where the decision requires it, a conref to a
  file or id that is not there...), not only in the ditamap.
- Titles and texts the rule looks for are written exactly as the rule writes
  them.${whereTheRuleLooks(dossier.look)}`;
}

// Test de reglas, progreso y causas, Part 1.5: the rule's own expressions
// that navigate the dossier's files (utils/ruleTestDossier.js
// dossierLookExpressions), quoted so every value goes exactly where the rule
// looks for it. Nothing when the rule has none.
function whereTheRuleLooks(look) {
  const expressions = look?.expressions || [];
  if (expressions.length === 0) return '';
  const label = (e) => (e.kind === 'let' ? `$${e.name} :=` : e.kind === 'context' ? 'rule context:' : `test${e.name ? ` of ${e.name}` : ''}:`);
  const lines = expressions.map((e) => `- ${label(e)} ${e.text}${e.cut ? ` … [cut: ${e.cut} more characters]` : ''}`);
  const more = look.omitted > 0 ? `\n(${look.omitted} more expressions of the rule navigate the files; only the first ${expressions.length}, in the rule's order, are shown.)` : '';
  return `

WHERE THE RULE LOOKS: these expressions of the rule navigate the dossier's
files (quoted from the rule; whitespace outside quotes collapsed). Each example
must place every value exactly where these expressions look for it (same
elements and nesting); the Proposal may not say it.
${lines.join('\n')}${more}`;
}

// `input`: { brdp, standard, format, ruleXml, contextSchemas, placements,
// schemaFacts, previousReview, matchExpressions } -- matchExpressions (T4b)
// are the rule's match expressions (ruleMatchExpressions), used to tell a
// title-dependent context; contextSchemas are the schemas of the
// rule's context blocks ([] for a general rule); placements (T2b) say where
// each offered schema takes the LLM's content: [{ schema, role: 'rule' |
// 'other', path, insertion, allowedChildren }]; schemaFacts the cards of the
// rule's element names (as for Ask / Suggest Rule); previousReview (T3b,
// "Review with the assistant" found the examples at fault): { explanation,
// mismatches: [{ label, expected, got, content }] } -- the regeneration must
// not repeat that mistake.
export function buildRuleTestExamplesPrompt({
  brdp,
  standard,
  format,
  ruleXml,
  contextSchemas = [],
  placements = [],
  schemaFacts = [],
  previousReview = null,
  matchExpressions = [],
  conditions = [],
  tableModel = null,
  // Mejoras E, Part 1.4: { reasons: [English sentences] } when the schema
  // already rules out what the rule forbids -- only examples meant to be
  // accepted are asked for, and the LLM is told why.
  acceptOnly = null,
  // Mejoras G, Part 1.4: [{ parent, child }] the rule names that the schema
  // allows only once -- a line in the parent's card (or its own block when
  // the parent has no card). Part 1.6: [{ path, element }] the rule
  // compares with that can give several -- examples with two or more.
  limits = [],
  several = [],
  // Dosier, Part 2: { mainPath, maxFiles, maxLines, types } for a rule that
  // reads other files of the dossier; null otherwise.
  dossier = null,
}) {
  // T4: a DITA Schematron rule -- topic types instead of schemas, naval or
  // aircraft content, and no S1000D reference elements.
  const dita = format === 'SCH-DITA';
  // Rule test on DM metadata: "metadata" (the whole section) when the rule
  // looks at it; no "content" when it looks at nothing else -- and then no
  // "short piece of a manual" either, which would contradict it.
  const withMetadata = placements.some((p) => p.insertion && p.metadata?.insertion);
  const withContent = placements.some((p) => !p.insertion || p.contentInsertion !== false);
  const metadataOnly = withMetadata && !withContent;
  // GMC, Part 1.3: values for attributes only the document's root carries.
  const withRootAttributes = placements.some((p) => (p.rootAttributes || []).length > 0);
  const rootAttributesOnly = withRootAttributes && !withMetadata && !withContent;
  const hasFacts = schemaFacts && schemaFacts.length > 0;
  const namesLine = hasFacts
    ? `use only element and attribute names that appear in
  the rule, in the lists above or in the SCHEMA FACTS below`
    : `use only real ${standard} element and attribute names —
  the rule's own names${dossier ? '' : ' and the lists above'}; never invent a name`;

  let prompt = `You write test examples for one ${standard} business rule, in BRDP Manager's
"Test rule". The application runs the rule itself on each example and
decides whether the example is accepted or rejected. You never judge the
rule: you only write the examples.

The decision (BRDP ${brdp.identifier}) — the examples test THIS:
Title: ${brdp.title}
Definition: ${brdp.definition}
Proposal: ${brdp.proposal}

The rule under test (${format}) — use it only to know which elements,
attributes and schemas are involved:
${ruleXml}${ruleValueLegend(ruleXml)}

WHAT TO WRITE:
${acceptOnly ? acceptOnlyInstructions(standard, acceptOnly) : `- "examples": at least two examples, written from the Proposal's DECISION,
  never from the rule: one that follows the decision ("expected": "accept")
  and one that goes against it ("expected": "reject"). If the rule does not
  implement the decision, the examples still follow the decision — finding
  that out is what the test is for.
- A restriction on values does not make an attribute or element mandatory:
  an example without the attribute or element follows the decision unless
  the Proposal says it is required. The reject example goes against exactly
  what the Proposal decides (for example a value the Proposal does not
  allow), never against something the Proposal does not mention.`}
${schemaInstructions(contextSchemas, placements, dita)}

${dossier ? dossierInstructions(standard, dossier) : buildingInstructions(standard, placements, dita)}

EACH EXAMPLE:
${
    dossier
      ? `- A small dossier of a ship or aircraft maintenance manual: maintenance
  steps, safety precautions, removal of components and the like.`
      : metadataOnly
      ? `- Only the identification and status section, starting from the minimal one
  above: change what the decision is about and keep the rest as it is.`
      : rootAttributesOnly
      ? `- Only "rootAttributes": the values of the root's attributes the decision is
  about. The application builds the rest of the document.`
      : `- A short piece of ${dita ? 'a ship or aircraft maintenance manual' : 'an aircraft maintenance manual'}: maintenance steps,
  removal of components, torque values and the like. In English, at most 10
  lines of content.`
  }
- Real ${standard} markup: ${namesLine}. Every
  element only inside a parent that allows it, every attribute only on an
  element that has it.${
    dita
      ? ''
      : `
- Never put text directly inside an element that only references or groups
  other content (${NO_TEXT_ELEMENTS}): give it its child
  elements and attributes instead.`
  }
${acceptOnly ? '' : `- The reject example goes against the decision in one clear way; the
  accept example is otherwise similar, so the difference is easy to see.
`}- No customer data, no real manufacturer names, part numbers or CAGE codes.
- "label": a few words saying what the example shows.`;

  if (ruleDependsOnTitle(matchExpressions)) prompt += titleDependentInstructions();
  if (conditions.length > 0) prompt += conditionInstructions(conditions);
  if (tableModel) prompt += tableModelInstructions(tableModel);
  if (several.length > 0) prompt += severalInstructions(several);

  prompt += buildSchemaFactsBlock(standard, schemaFacts, { limits });
  const carded = new Set((schemaFacts || []).map((f) => f.name));
  const looseLimits = limits.filter((l) => !carded.has(l.parent));
  if (looseLimits.length > 0) {
    prompt += `\n\nAT MOST ONE (the schema allows no more):${looseLimits.map((l) => `\n- at most one <${l.child}> inside <${l.parent}>`).join('')}`;
  }

  if (previousReview) {
    const lines = previousReview.mismatches.map(
      (m) => `- "${m.label}" (expected ${m.expected}, the rule ${m.got} it):\n  ${m.content}`
    );
    prompt += `

PREVIOUS EXAMPLES WERE WRONG: a review of the last test found that these
examples, not the rule, caused its failure:
${lines.join('\n')}
Diagnosis: ${previousReview.explanation}
Write new examples that do not repeat this mistake.`;
  }

  const firstSchema = placements[0]?.schema || 'descript';
  const rootExample = withRootAttributes
    ? `"rootAttributes": {${[...new Set(placements.flatMap((p) => (p.rootAttributes || []).map((r) => r.attribute)))].map((a) => `"${a}": "…"`).join(', ')}}`
    : null;
  const fields = [
    withMetadata ? `"metadata": "<${placements.find((p) => p.metadata?.insertion).metadata.element}>…"` : null,
    withContent ? '"content": "…"' : null,
    rootExample,
  ].filter(Boolean);
  if (dossier) {
    prompt += `

OUTPUT: strict JSON, no comments:
{"examples": [{"label": "…", "expected": "accept", "schema": "map", "content": "<map>…</map>", "files": [{"path": "topics/….dita", "content": "<task id=\\"…\\">…</task>"}]}]}`;
    return prompt;
  }
  prompt += `

OUTPUT: strict JSON, no comments:
{"examples": [{"label": "…", "expected": "accept", "schema": "${firstSchema}", ${fields.join(', ')}}]}`;
  return prompt;
}

// Mejoras E, Part 1.4: what to write when no valid document can go against
// the rule.
function acceptOnlyInstructions(standard, acceptOnly) {
  return `- "examples": one or two examples that follow the decision ("expected":
  "accept"), and NO example meant to be rejected: no valid ${standard}
  document can go against this rule, because ${acceptOnly.reasons.join('; ')}.
  The examples show that the rule accepts valid documents: each one contains
  the elements the rule is about, written the way the schema allows.`;
}

// T2b, the one automatic correction round: the exact problems of each
// failing example, sent as the next user message after the LLM's first
// answer. `failures`: [{ index (0-based), label, problems: [English] }].
export function buildRuleTestCorrectionMessage(failures, { dossier = false, rootAttributes = false } = {}) {
  const blocks = failures.map(
    (f) => `Example ${f.index + 1} ("${f.label}"):\n${f.problems.map((p) => `- ${p}`).join('\n')}`
  );
  // Dosier, Part 2: the files are part of what may change. GMC, Part 1.3:
  // and the root's attribute values.
  const what = dossier
    ? '"content" and "files"'
    : rootAttributes
      ? '"content" (and "metadata", if it has one) and "rootAttributes"'
      : '"content" (and "metadata", if it has one)';
  return `Some examples are not valid. Fix exactly these problems and
return the complete JSON again: the same examples in the same order with the same "expected" and "schema" — change only the
${what} of the examples listed.

${blocks.join('\n\n')}`;
}

// Everything "Copy test prompt" puts on the clipboard.
export function buildCopyableTestPrompt(systemPrompt) {
  return `${systemPrompt}\n\n${RULE_TEST_USER_MESSAGE}`;
}

// { ok: true, examples } | { ok: false, error } -- tolerant of a markdown
// fence and of text around the JSON object, strict about its shape. An
// "explanation" (asked for until T3b) is ignored: the panel shows
// describeRule's instead. A "proposalMismatch" (asked for until Barrido
// final 1/2) is ignored too: the Proposal is now checked by its own call
// (ruleProposalCheckPrompt.js).
// options.contentOptionalSchemas: the schemas whose examples the
// application builds whole (placeExample's rootOnly) -- their examples come
// with no "content".
// options.dossier (Dosier, Part 2): each example also has "files", a list of
// { path, content } (kept as written; the dossier's own checks say what is
// wrong with them).
export function parseRuleTestResponse(raw, { contentOptionalSchemas = [], dossier = false } = {}) {
  // No closing brace (a truncated answer) still reaches JSON.parse, which
  // says what is wrong.
  const read = readLlmJson(raw);
  if (!read.ok && read.reason === 'no_object') return { ok: false, error: 'The answer contains no JSON object.' };
  if (!read.ok) return { ok: false, error: `The answer is not valid JSON (${read.message}).` };
  const { data } = read;
  if (!Array.isArray(data.examples) || data.examples.length === 0) {
    return { ok: false, error: 'The answer has no "examples" list.' };
  }
  const examples = [];
  for (const [i, ex] of data.examples.entries()) {
    const where = `Example ${i + 1}`;
    if (!ex || typeof ex !== 'object') return { ok: false, error: `${where} is not an object.` };
    if (ex.expected !== 'accept' && ex.expected !== 'reject') {
      return { ok: false, error: `${where} has "expected" = ${JSON.stringify(ex.expected)} (must be "accept" or "reject").` };
    }
    // T2b: the content of the insertion point ("xml" accepted from an
    // answer that still uses the old field name). Rule test on DM
    // metadata: "metadata", the whole identification and status section;
    // an example may then have no content at all.
    const content = typeof ex.content === 'string' ? ex.content : typeof ex.xml === 'string' ? ex.xml : '';
    const metadata = typeof ex.metadata === 'string' ? ex.metadata.trim() : '';
    const contentOptional = typeof ex.schema === 'string' && contentOptionalSchemas.includes(ex.schema);
    // GMC, Part 1.3: { attribute: value } for the root (strings; numbers and
    // booleans written as text).
    let rootAttributes = null;
    if (ex.rootAttributes !== undefined && ex.rootAttributes !== null) {
      if (typeof ex.rootAttributes !== 'object' || Array.isArray(ex.rootAttributes)) {
        return { ok: false, error: `${where} has "rootAttributes" that is not an object.` };
      }
      rootAttributes = {};
      for (const [name, value] of Object.entries(ex.rootAttributes)) {
        if (!['string', 'number', 'boolean'].includes(typeof value)) {
          return { ok: false, error: `${where} has a "rootAttributes" value for "${name}" that is not text.` };
        }
        rootAttributes[name.trim()] = String(value);
      }
    }
    if (!content.trim() && !metadata && !contentOptional) return { ok: false, error: `${where} has no "content".` };
    if (ex.schema !== undefined && ex.schema !== null && typeof ex.schema !== 'string') {
      return { ok: false, error: `${where} has a "schema" that is not text or null.` };
    }
    let files = null;
    if (dossier) {
      if (ex.files !== undefined && ex.files !== null && !Array.isArray(ex.files)) return { ok: false, error: `${where} has "files" that is not a list.` };
      files = [];
      for (const [j, f] of (ex.files || []).entries()) {
        if (!f || typeof f !== 'object' || typeof f.path !== 'string' || typeof (f.content ?? f.xml) !== 'string') {
          return { ok: false, error: `${where}, file ${j + 1}, is not {"path": "…", "content": "…"}.` };
        }
        files.push({ path: f.path.trim(), content: String(f.content ?? f.xml).trim() });
      }
    }
    examples.push({
      label: typeof ex.label === 'string' && ex.label.trim() ? ex.label.trim() : where,
      expected: ex.expected,
      schema: ex.schema && ex.schema !== 'null' ? ex.schema : null,
      content: content.trim(),
      ...(metadata ? { metadata } : {}),
      ...(rootAttributes ? { rootAttributes } : {}),
      ...(files ? { files } : {}),
    });
  }
  return { ok: true, examples };
}
