// Mejoras E, Part 1.2: a rule that forbids what no valid document of the
// schema can contain -- "Already covered by the schema". Not a defect of the
// rule, not a failed test: the schema already guarantees the decision, so no
// example can be written that the rule must reject. Found by code, before
// any LLM call, with the standard's element graph (GET
// /api/schema-cards/graph, the same graph rulePathCheck.js reads).
//
// Real cases (S1000D 3.0.1):
//   BRDP-EXT-02805  //inlineapplics[not(ancestor::idstatus)]
//     <inlineapplics> only goes inside <status>, and <status> only inside
//     <idstatus>: an <inlineapplics> outside <idstatus> cannot exist.
//   BRDP-EXT-02802  //avee/*[not(self::modelic or self::sdc or … or self::itemloc)]
//     the schema allows exactly those 11 children in <avee>.
//
// Recognized, on every alternative of every rule part (a part and its
// alternatives must ALL be covered; one that is not makes the whole rule a
// normal test):
//   (a) X[not(ancestor::Y)] / X[not(parent::Y)] -- the condition alone or
//       as one "and" operand of a predicate of the last step -- when, in
//       every schema of the scope where X can appear (reachable from the
//       schema's root), X is only ever inside Y (directly inside Y for
//       parent::);
//   (b) X/*[not(self::a or self::b or …)] -- alone or as one "and"
//       operand -- when, in every schema of the scope where X can appear,
//       every child the schema allows in X is in the list;
//   (c) Mejoras F, Part 2.1: X[not(Y)] / X[not(@a)] -- alone or as one
//       "and" operand -- when <Y> is a required child of <X> (graph.required:
//       a plain entry of the content model, never an alternative of a
//       choice) or @a a required attribute, in every schema of the scope
//       where X can appear. BRDP-EXT-02640 //dmaddres[not(issno)].
//   (d) Mejoras G, Part 1.3: X[count(Y) > n] (also >=, =, n < count(Y);
//       alone or as one "and" operand) -- when the most <Y> children <X>
//       allows (graph.maxima) is below what the condition needs, in every
//       schema of the scope where X can appear. //applic[count(evaluate) > 1]:
//       <applic> allows at most 1 <evaluate>.
// Only BREX parts that forbid (allowedObjectFlag="0" / objappl="0"); a
// mandatory part (flag 1), a restriction of values (flag 2, no objappl) and
// a condition are never "covered" (as before). The scope is the part's
// context schema, or every schema of the standard. Without a graph (no
// structure for the standard) nothing is concluded.
//
// → null, or { items: [{ ruleId, kind: 'onlyInside' | 'onlyDirectlyInside'
//   | 'childrenListed', element, other?, children? }] }
import { rulePathParts } from '../utils/ruleTestEngine.js';
import { andOperands, graphIndex, graphNode, orOperands, pathAlternatives, pathSteps } from './rulePathCheck.js';

const BREX_FORMATS = new Set(['BREX-4.2', 'BREX-4.1', 'BREX-3.0.1']);
const NAME = '[A-Za-z_][\\w.-]*';
const RELATION_RE = new RegExp(`^not\\s*\\(\\s*(ancestor|parent)::(${NAME})\\s*\\)$`);
const SELF_RE = new RegExp(`^self::(${NAME})$`);
const NOT_RE = /^not\s*\(([\s\S]*)\)$/;
// Mejoras F, Part 2.1: X[not(Y)] / X[not(@a)] (child:: and attribute:: too).
const NOT_CHILD_RE = new RegExp(`^not\\s*\\(\\s*(?:child::)?(${NAME})\\s*\\)$`);
const NOT_ATTR_RE = new RegExp(`^not\\s*\\(\\s*(?:@|attribute::)(${NAME})\\s*\\)$`);
// Mejoras G, Part 1.3: count(Y) compared with a number, either way round.
const COUNT_LEFT_RE = new RegExp(`^count\\s*\\(\\s*(?:child::)?(${NAME})\\s*\\)\\s*(>=|>|=|ge|gt|eq)\\s*(\\d+)$`);
const COUNT_RIGHT_RE = new RegExp(`^(\\d+)\\s*(<=|<|=|le|lt|eq)\\s*count\\s*\\(\\s*(?:child::)?(${NAME})\\s*\\)$`);

// The fewest <Y> an "and" operand needs, or null.
function countNeeded(operand) {
  const left = COUNT_LEFT_RE.exec(operand);
  if (left) {
    const n = Number(left[3]);
    const op = left[2];
    return { name: left[1], least: op === '>' || op === 'gt' ? n + 1 : n };
  }
  const right = COUNT_RIGHT_RE.exec(operand);
  if (right) {
    const n = Number(right[1]);
    const op = right[2];
    return { name: right[3], least: op === '<' || op === 'lt' ? n + 1 : n };
  }
  return null;
}

// Every element reachable from the schema's roots, without expanding
// `blocked` (it can itself be reached).
function reachableFromRoots(index, schema, blocked = null) {
  const seen = new Set();
  const frontier = [...(index.roots.get(schema) || [])].filter((r) => graphNode(index, schema, r));
  frontier.forEach((r) => seen.add(r));
  while (frontier.length) {
    const name = frontier.pop();
    if (name === blocked) continue;
    for (const child of graphNode(index, schema, name)?.children || []) {
      if (!seen.has(child) && graphNode(index, schema, child)) {
        seen.add(child);
        frontier.push(child);
      }
    }
  }
  return seen;
}

// The schemas of the scope where <name> can appear in a document.
function schemasWith(index, scope, name) {
  return scope.filter((s) => reachableFromRoots(index, s).has(name));
}

// The not(self::a or …) list of an "and" operand, or null.
function selfList(operand) {
  const m = NOT_RE.exec(operand);
  if (!m) return null;
  const names = [];
  for (const part of orOperands(m[1])) {
    const s = SELF_RE.exec(part);
    if (!s) return null;
    names.push(s[1]);
  }
  return names.length ? names : null;
}

function coveredAlternative(index, scope, alternative) {
  const { steps } = pathSteps(alternative);
  const last = steps[steps.length - 1];
  if (!last) return null;
  const operands = last.predicates.flatMap((p) => andOperands(p) || []);
  // (a) X[not(ancestor::Y)] / X[not(parent::Y)]
  if (last.kind === 'element') {
    for (const operand of operands) {
      const m = RELATION_RE.exec(operand);
      if (!m || m[2] === last.name) continue;
      const [, axis, other] = m;
      const element = last.name;
      const where = schemasWith(index, scope, element);
      if (where.length === 0) continue;
      const covered = where.every((s) => {
        if (axis === 'ancestor') return !reachableFromRoots(index, s, other).has(element) || element === other;
        const reachable = reachableFromRoots(index, s);
        return [...reachable].every((p) => p === other || !graphNode(index, s, p)?.children.has(element));
      });
      if (covered) return { kind: axis === 'ancestor' ? 'onlyInside' : 'onlyDirectlyInside', element, other };
    }
    // Mejoras F, Part 2.1: X[not(Y)] when <Y> is a required child of <X>
    // (a plain entry of its content model, never an alternative of a
    // choice), X[not(@a)] when @a is a required attribute -- in every
    // schema of the scope where <X> can appear.
    for (const operand of operands) {
      const child = NOT_CHILD_RE.exec(operand);
      const attr = child ? null : NOT_ATTR_RE.exec(operand);
      if (!child && !attr) continue;
      const element = last.name;
      const where = schemasWith(index, scope, element);
      if (where.length === 0) continue;
      const covered = where.every((s) => {
        const n = graphNode(index, s, element);
        return child ? Boolean(n?.requiredChildren?.has(child[1])) : Boolean(n?.requiredAttrs?.has(attr[1]));
      });
      if (covered) {
        return child
          ? { kind: 'requiredChild', element, other: child[1] }
          : { kind: 'requiredAttribute', element, other: attr[1] };
      }
    }
    // (d) Mejoras G, Part 1.3: X[count(Y) > n] beyond what <X> allows.
    for (const operand of operands) {
      const need = countNeeded(operand.replace(/\s+/g, ' ').trim());
      if (!need || need.least < 1) continue;
      const element = last.name;
      const where = schemasWith(index, scope, element);
      if (where.length === 0) continue;
      if (!where.some((s) => graphNode(index, s, element)?.children.has(need.name))) continue;
      let most = 0;
      const covered = where.every((s) => {
        const n = graphNode(index, s, element);
        if (!n?.children.has(need.name)) return true;
        const max = n.max?.get(need.name);
        if (!Number.isInteger(max)) return false;
        most = Math.max(most, max);
        return max < need.least;
      });
      if (covered) return { kind: 'maxChildren', element, other: need.name, max: most };
    }
    return null;
  }
  // (b) X/*[not(self::a or …)]
  const before = steps[steps.length - 2];
  if ((last.main === '*' || last.main === 'child::*') && last.sep === '/' && before?.kind === 'element' && !before.desc) {
    for (const operand of operands) {
      const list = selfList(operand);
      if (!list) continue;
      const element = before.name;
      const where = schemasWith(index, scope, element);
      if (where.length === 0) continue;
      const children = new Set();
      for (const s of where) for (const c of graphNode(index, s, element)?.children || []) children.add(c);
      if ([...children].every((c) => list.includes(c))) return { kind: 'childrenListed', element, children: [...children].sort() };
    }
  }
  return null;
}

export function schemaCoverage(ruleXml, format, graph, options = {}) {
  if (!BREX_FORMATS.has(format)) return null;
  const index = graphIndex(graph);
  if (!index) return null;
  const parts = rulePathParts(ruleXml, format, options);
  if (parts.length === 0) return null;
  const items = [];
  for (const part of parts) {
    if (part.condition || part.flag !== '0') return null;
    const scope = part.schema && index.bySchema.has(part.schema) ? [part.schema] : index.schemas;
    const alternatives = pathAlternatives(part.path);
    if (alternatives.length === 0) return null;
    for (const alternative of alternatives) {
      const item = coveredAlternative(index, scope, alternative);
      if (!item) return null;
      if (!items.some((i) => i.kind === item.kind && i.element === item.element && i.other === item.other)) items.push({ ruleId: part.ruleId, ...item });
    }
  }
  return items.length ? { items } : null;
}

// Remates de Mejoras G, Part 1.1: the alternatives of the rule that the
// schema covers by a RELATION -- "only inside" (a), "only directly inside"
// (a) and "children listed" (b) --, each on its own, even when the rest of
// the rule is not covered. runExample's schemaCoveredExample reads them:
// an example meant to be rejected is "already ruled out by the schema"
// only when what the schema does not allow in it is exactly one of these
// relations. Only BREX parts that forbid (flag 0), as above. Without a
// graph, none.
// → [{ ruleId, kind, element, other?, children? }]
const RELATION_KINDS = new Set(['onlyInside', 'onlyDirectlyInside', 'childrenListed']);

export function coveredRelationAlternatives(ruleXml, format, graph, options = {}) {
  if (!BREX_FORMATS.has(format)) return [];
  const index = graphIndex(graph);
  if (!index) return [];
  const out = [];
  for (const part of rulePathParts(ruleXml, format, options)) {
    if (part.condition || part.flag !== '0') continue;
    const scope = part.schema && index.bySchema.has(part.schema) ? [part.schema] : index.schemas;
    for (const alternative of pathAlternatives(part.path)) {
      const item = coveredAlternative(index, scope, alternative);
      if (item && RELATION_KINDS.has(item.kind)) out.push({ ruleId: part.ruleId, ...item });
    }
  }
  return out;
}

// One item in the language of `t` (records.ruleTest.covered.*).
export function formatCoverageItem(item, t) {
  if (item.kind === 'structure') {
    return t('records.ruleTest.covered.structure', { element: item.element, parent: item.parent, schema: item.schema || '' });
  }
  return t(`records.ruleTest.covered.${item.kind}`, { element: item.element, other: item.other || '', max: item.max ?? '' });
}

// The same, in English, for the prompt (the LLM is told why no example
// meant to be rejected is asked for).
export function coverageItemEnglish(item) {
  if (item.kind === 'onlyInside') return `<${item.element}> can only go inside <${item.other}>`;
  if (item.kind === 'onlyDirectlyInside') return `<${item.element}> can only go directly inside <${item.other}>`;
  if (item.kind === 'requiredChild') return `<${item.other}> is required in <${item.element}>`;
  if (item.kind === 'requiredAttribute') return `@${item.other} is required in <${item.element}>`;
  if (item.kind === 'maxChildren') return `<${item.element}> allows at most ${item.max} <${item.other}>`;
  if (item.kind === 'documentAlways') return `<${item.element}> is required in every document with the root <${item.other}>`;
  if (item.kind === 'rootsAllowed') return `every document type of the standard has <${item.element}> as its root, which the rule allows`;
  if (item.kind === 'childrenListed') return `the schema only allows the listed children in <${item.element}> (${item.children.map((c) => `<${c}>`).join(', ')})`;
  return `<${item.element}> is not allowed inside <${item.parent}> by the schema`;
}

// ─── Mejoras G, Part 2.3: "every document must contain <x>" ────────────────
// /*[not(P)] and /R[not(P)] with flag 0, P a path of child steps with or
// without a leading // (//dmaddres, //status/qa, idstatus/dmaddres). For
// every schema of the scope whose root is R (any root for /*):
//   always  P is in every document: each step a plain required child of the
//           one before (with //, its first element reached from the root
//           through a chain of required children);
//   cannot  P can never occur: the first element is not in the documents
//           of that schema, or a step is never a child of the one before;
//   depends anything else (it depends on the document).
// BRDP-EXT-02715 /*[not(//dmaddres)]: <dmaddres> is required in every
// data module and cannot exist in comment, ddn, dml or pm.
// → null (another form) | { root, names, target, container, always, cannot, depends }
const PRESENCE_RE = new RegExp(`^/(\\*|${NAME})\\[\\s*not\\s*\\(\\s*(//)?(${NAME}(?:/${NAME})*)\\s*\\)\\s*\\]$`);

function requiredReach(index, schema) {
  const roots = (index.roots.get(schema) || []).filter((r) => graphNode(index, schema, r));
  const seen = new Set(roots);
  const frontier = [...roots];
  while (frontier.length) {
    const name = frontier.pop();
    for (const child of graphNode(index, schema, name)?.requiredChildren || []) {
      if (!seen.has(child) && graphNode(index, schema, child)) {
        seen.add(child);
        frontier.push(child);
      }
    }
  }
  return seen;
}

function presenceIn(index, schema, names, descendant) {
  const root = (index.roots.get(schema) || [])[0];
  if (!root) return 'depends';
  let state;
  const [first, ...rest] = names;
  if (descendant) {
    if (!reachableFromRoots(index, schema).has(first)) return 'cannot';
    state = requiredReach(index, schema).has(first) ? 'always' : 'depends';
  } else {
    const n = graphNode(index, schema, root);
    if (!n?.children.has(first)) return 'cannot';
    state = n.requiredChildren?.has(first) ? 'always' : 'depends';
  }
  let prev = first;
  for (const name of rest) {
    const n = graphNode(index, schema, prev);
    if (!n?.children.has(name)) return 'cannot';
    if (!n.requiredChildren?.has(name)) state = 'depends';
    prev = name;
  }
  return state;
}

export function documentPresence(ruleXml, format, graph, options = {}) {
  if (!BREX_FORMATS.has(format)) return null;
  const index = graphIndex(graph);
  if (!index) return null;
  const parts = rulePathParts(ruleXml, format, options);
  if (parts.length !== 1) return null;
  const [part] = parts;
  if (part.condition || part.flag !== '0') return null;
  const m = PRESENCE_RE.exec(String(part.path || '').replace(/\s+/g, ' ').trim());
  if (!m) return null;
  const [, root, descendant, steps] = m;
  const names = steps.split('/');
  const scope = (part.schema && index.bySchema.has(part.schema) ? [part.schema] : index.schemas).filter(
    (s) => root === '*' || (index.roots.get(s) || []).includes(root)
  );
  if (scope.length === 0) return null;
  const out = { root, names, target: names[names.length - 1], container: names.length > 1 ? names[names.length - 2] : null, always: [], cannot: [], depends: [] };
  for (const schema of scope) out[presenceIn(index, schema, names, Boolean(descendant))].push(schema);
  return out;
}
