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
//       every child the schema allows in X is in the list.
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

// One item in the language of `t` (records.ruleTest.covered.*).
export function formatCoverageItem(item, t) {
  if (item.kind === 'structure') {
    return t('records.ruleTest.covered.structure', { element: item.element, parent: item.parent, schema: item.schema || '' });
  }
  return t(`records.ruleTest.covered.${item.kind}`, { element: item.element, other: item.other || '' });
}

// The same, in English, for the prompt (the LLM is told why no example
// meant to be rejected is asked for).
export function coverageItemEnglish(item) {
  if (item.kind === 'onlyInside') return `<${item.element}> can only go inside <${item.other}>`;
  if (item.kind === 'onlyDirectlyInside') return `<${item.element}> can only go directly inside <${item.other}>`;
  if (item.kind === 'childrenListed') return `the schema only allows the listed children in <${item.element}> (${item.children.map((c) => `<${c}>`).join(', ')})`;
  return `<${item.element}> is not allowed inside <${item.parent}> by the schema`;
}
