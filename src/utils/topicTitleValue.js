// Test de reglas DITA: el título del topic montado cuando la regla lo exige.
// A rule can apply only under an element whose <title> has a given value,
// and in a real dossier that element can be the topic itself -- Navantia
// BRDP-EXT-00011 ("DITA 1.3 Xpath3.0"):
//   *[normalize-space(title) = 'LISTA DE REFERENCIAS CONSOLIDADAS']
//     //section//*[self::p or self::entry[not(p)]][matches(normalize-space(.), '^\([a-z]\)')]
// The application always wrote the topic's title as "Example topic"
// (SKELETON_TITLE_TEXT, T4b) and the prompt asked for a <section> with that
// title around the checked content; but a DITA <section> takes no other
// <section>, so the rule selected nothing in any example and every example
// meant to be rejected came back "accepted". Here: when the title can ONLY
// be the topic's, the application writes the rule's value as the topic's
// <title> in every example (same idea as ownSectionValues.js).
//
// What counts (generic, nothing by identifier or by the title's text): the
// FIRST step of a rule's alternative is "*" or the topic type of the test,
// and one predicate of it, not negated and not under an "or", compares its
// title with a literal: title = 'X', normalize-space(title) = 'X', a list
// title = ('A', 'B') (the first one is written), or the same reversed. And
// the rest of the path below that step can only be written inside the topic:
// no element of the topic type that takes a <title> (a <section>, a <fig>,
// a <table>…) can hold it, checked on the topic type's structure. When it
// fits under such an element (*[title = 'X']//table, BRDP-EXT-00001 of the
// DITA template) nothing changes: the LLM writes that element with its
// title, as before.
import { andOperands, pathAlternatives, pathSteps } from '../validation/rulePathCheck.js';
import { ruleMatchExpressions } from './ruleTestSkeleton.js';

const LIT = `'[^']*'|"[^"]*"`;
const TITLE_SIDE = String.raw`(?:normalize-space\(\s*(?:child::)?title\s*\)|(?:child::)?title)`;
const VALUE_SIDE = String.raw`(?:${LIT}|\(\s*(?:${LIT})(?:\s*,\s*(?:${LIT}))*\s*\))`;
const TITLE_EQ_RE = new RegExp(String.raw`^(?:${TITLE_SIDE}\s*(?:=|\seq\s)\s*(${VALUE_SIDE})|(${VALUE_SIDE})\s*(?:=|\seq\s)\s*${TITLE_SIDE})$`);
const LIT_RE = new RegExp(LIT, 'g');

// The literal values a predicate operand compares the step's title with,
// or null when the operand is not such a comparison.
function titleValues(operand) {
  const m = TITLE_EQ_RE.exec(String(operand || '').trim());
  if (!m) return null;
  return [...(m[1] || m[2]).matchAll(LIT_RE)].map((v) => v[0].slice(1, -1));
}

// { step: '*' | name, value, values, rest: [step], expression } for each
// alternative of the rule whose first step asks a title of a literal value.
export function topicTitleConditions(ruleXml) {
  const out = [];
  for (const expression of ruleMatchExpressions(ruleXml)) {
    for (const alternative of pathAlternatives(expression)) {
      const { absolute, steps } = pathSteps(alternative);
      const first = steps[0];
      if (!first) continue;
      // "/*[title = …]" is the document's root; "*[…]", "//*[…]" any element
      // -- in both the topic is the one this module is about.
      if (absolute && first.sep === '/' && first.main !== '*' && first.kind !== 'element') continue;
      const name = first.main === '*' ? '*' : first.kind === 'element' ? first.name : null;
      if (!name) continue;
      for (const predicate of first.predicates) {
        const operands = andOperands(predicate);
        if (!operands) continue; // a top-level "or": no operand on its own
        for (const operand of operands) {
          const values = titleValues(operand);
          if (values && values.length) {
            out.push({ step: name, value: values[0], values, rest: steps.slice(1), expression: alternative.trim() });
          }
        }
      }
    }
  }
  return out;
}

// The element names a step of the rest of the path selects: its name, the
// self:: alternatives of a "*" step (*[self::p or self::entry]), or null
// for any element.
function stepNames(step) {
  if (step.kind === 'element') return new Set([step.name]);
  if (step.kind === 'axis' && step.axis === 'self') return new Set([step.name]);
  if (step.main === '*') {
    for (const predicate of step.predicates) {
      const names = [...predicate.matchAll(/(?<![\w:-])self::([A-Za-z_][\w.-]*)/g)].map((m) => m[1]);
      if (names.length && !/\bnot\s*\(\s*self::/.test(predicate)) return new Set(names);
    }
    return null;
  }
  return undefined; // a step this module does not read
}

function childrenOf(elements, name) {
  return elements[name]?.children || [];
}

function descendantsOf(elements, start) {
  const seen = new Set();
  const queue = [...childrenOf(elements, start)];
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name) || !elements[name]) continue;
    seen.add(name);
    queue.push(...childrenOf(elements, name));
  }
  return seen;
}

// Whether the rest of the path can be written below <from>: each step's
// elements reached from the previous step's (child for "/", any depth for
// "//"). A step it cannot read (another axis, a function) ends the walk as
// "yes": never a title written for a path this module cannot judge.
function restFits(elements, from, rest) {
  let current = new Set([from]);
  for (const step of rest) {
    if (step.kind === 'attribute' || step.kind === 'self') return current.size > 0;
    const names = stepNames(step);
    if (names === undefined) return current.size > 0;
    const next = new Set();
    for (const c of current) {
      const reach = step.sep === '//' || (step.kind === 'axis' && step.axis !== 'self') ? descendantsOf(elements, c) : new Set(childrenOf(elements, c));
      for (const n of reach) if (!names || names.has(n)) next.add(n);
    }
    if (next.size === 0) return false;
    current = next;
  }
  return true;
}

// { element, value } -- the title the application writes on the topic of
// this placement -- or null. Only a placement where the application writes
// the topic's title (placement.titled holds the root): a whole-document
// placement has the LLM write it, as before.
export function topicTitleFor(structure, placement, conditions) {
  if (!conditions?.length || !structure?.elements) return null;
  const root = structure.skeleton?.path?.[0];
  if (!root || !(placement?.titled || []).includes(root)) return null;
  const elements = structure.elements;
  // Every element of the topic type, other than the topic, that takes a
  // <title>: where the LLM can write a titled element itself.
  const titledInside = [...descendantsOf(elements, root)].filter((n) => n !== root && childrenOf(elements, n).includes('title'));
  for (const c of conditions) {
    if (c.step !== '*' && c.step !== root) continue;
    if (!restFits(elements, root, c.rest)) continue;
    if (c.step === '*' && titledInside.some((n) => restFits(elements, n, c.rest))) continue;
    return { element: root, value: c.value };
  }
  return null;
}

// The placement with the topic's title the rule asks for, or unchanged.
export function withTopicTitle(placement, structure, conditions) {
  const topicTitle = topicTitleFor(structure, placement, conditions);
  return topicTitle ? { ...placement, topicTitle } : placement;
}

// ─── Fichas del dosier (reglas que solo avisan, Part 2) ─────────────────────
// In a dossier the LLM writes every file whole, so the title a rule looks
// for has to be in the FILES, not only in the document the application
// assembles. Navantia BRDP-EXT-00012:
//   row[not(parent::thead)][ancestor::*[normalize-space(title) = 'LISTA DE MATERIAL OBLIGATORIO']]
// The LLM wrote <taskbody><sectiondiv><title>LISTA…</title><table>… -- a
// <sectiondiv> does not go in <taskbody> and takes no <title> -- and every
// example was invalid. Here, generically: a predicate of any step that asks
// an ANCESTOR for its title (ancestor::*[title = 'X'],
// ancestor-or-self::task[normalize-space(title) = 'X'], not negated and not
// under an "or"), plus the first-step form of topicTitleConditions; and,
// for each topic type of the dossier, where that title can go: the file's
// own topic, or an element inside it that takes a <title> and can hold the
// checked element.
const ANCESTOR_STEP_RE = /^(ancestor(?:-or-self)?)::(\*|[A-Za-z_][\w.-]*)$/;

export function ancestorTitleConditions(ruleXml) {
  const out = [];
  for (const expression of ruleMatchExpressions(ruleXml)) {
    for (const alternative of pathAlternatives(expression)) {
      const { steps } = pathSteps(alternative);
      for (const step of steps) {
        const checked = step.kind === 'element' ? step.name : null;
        for (const predicate of step.predicates) {
          const operands = andOperands(predicate);
          if (!operands) continue;
          for (const operand of operands) {
            const inner = pathSteps(String(operand).trim());
            if (inner.absolute || inner.steps.length !== 1) continue;
            const m = ANCESTOR_STEP_RE.exec(inner.steps[0].main);
            if (!m) continue;
            for (const p of inner.steps[0].predicates) {
              for (const o of andOperands(p) || []) {
                const values = titleValues(o);
                if (values && values.length) out.push({ holder: m[2], orSelf: m[1] === 'ancestor-or-self', checked, value: values[0], values, expression: alternative.trim() });
              }
            }
          }
        }
      }
    }
  }
  return out;
}

// Elements that take a title and may hold content, in the order they are
// offered (a generic DITA list; the type's structure decides which exist).
const TITLED_HOLDERS = ['section', 'example', 'fig', 'table'];
const DOSSIER_TOPIC_TYPES = ['topic', 'concept', 'task', 'reference', 'troubleshooting'];

function shortestPath(elements, from, to) {
  if (from === to) return [from];
  const previous = new Map([[from, null]]);
  const queue = [from];
  while (queue.length) {
    const name = queue.shift();
    for (const child of childrenOf(elements, name)) {
      if (previous.has(child) || !elements[child]) continue;
      previous.set(child, name);
      if (child === to) {
        const path = [to];
        for (let p = name; p; p = previous.get(p)) path.unshift(p);
        return path;
      }
      queue.push(child);
    }
  }
  return null;
}

// → null, or { value, values, checked, ways: [{ type, topic, inside: [path] }] }
//   ways: per topic type of the dossier, whether the file's topic itself
//   can carry the title (topic) and the paths to the titled elements inside
//   it that can hold the checked element (at most two). structures:
//   { [type]: structure } (loadDossierStructures).
export function dossierTitleRequirements(ruleXml, structures = {}) {
  const first = topicTitleConditions(ruleXml).map((c) => ({ holder: c.step, value: c.value, values: c.values, rest: c.rest, checked: null }));
  const conditions = [...first, ...ancestorTitleConditions(ruleXml)];
  if (conditions.length === 0) return null;
  const c = conditions[0];
  const ways = [];
  for (const type of DOSSIER_TOPIC_TYPES) {
    const structure = structures?.[type];
    const elements = structure?.elements;
    if (!elements) continue;
    const root = structure.skeleton?.path?.[0] || type;
    if (!elements[root]) continue;
    const holds = (t) => {
      if (c.rest) return restFits(elements, t, c.rest);
      if (!c.checked) return true;
      return descendantsOf(elements, t).has(c.checked) || (c.orSelf && t === c.checked);
    };
    const topic = (c.holder === '*' || c.holder === root) && childrenOf(elements, root).includes('title') && holds(root);
    const inside = [];
    if (c.holder === '*' || TITLED_HOLDERS.includes(c.holder)) {
      for (const name of TITLED_HOLDERS) {
        if (inside.length >= 2) break;
        if (c.holder !== '*' && c.holder !== name) continue;
        if (!elements[name] || !childrenOf(elements, name).includes('title') || !holds(name)) continue;
        // Through the topic's body when it can (task/taskbody/example, never
        // task/abstract/fig): the body is where the file's content goes.
        const body = structure.skeleton?.path?.[1];
        const viaBody = body && childrenOf(elements, root).includes(body) ? shortestPath(elements, body, name) : null;
        const path = viaBody ? [root, ...viaBody] : shortestPath(elements, root, name);
        if (path) inside.push(path);
      }
    }
    if (topic || inside.length) ways.push({ type, root, topic, inside });
  }
  return { value: c.value, values: c.values, checked: c.checked || null, ways };
}

// The file's own topic gets the rule's title when nothing else in its type
// can carry it (the same criterion as topicTitleFor): { [type]: value }.
export function dossierTopicTitles(requirements) {
  const out = {};
  for (const w of requirements?.ways || []) if (w.topic && w.inside.length === 0) out[w.type] = requirements.value;
  return out;
}

// The XML with its root's <title> set to `value` (replaced, or written as
// the first child), or null when the text cannot be read that way.
export function setRootTitleText(xml, value) {
  const text = String(xml || '');
  const open = /^(\s*(?:<\?[\s\S]*?\?>\s*|<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*)<([A-Za-z_][\w.:-]*)\b[^>]*?(\/?)>/.exec(text);
  if (!open || open[3] === '/') return null;
  const after = open.index + open[0].length;
  const escaped = String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const title = /^(\s*)<title\b[^>]*>[\s\S]*?<\/title>/.exec(text.slice(after));
  if (title) {
    const current = /<title\b[^>]*>([\s\S]*?)<\/title>/.exec(title[0])[1];
    if (current.replace(/\s+/g, ' ').trim() === String(value).replace(/\s+/g, ' ').trim()) return text;
    return `${text.slice(0, after)}${title[1]}<title>${escaped}</title>${text.slice(after + title[0].length)}`;
  }
  return `${text.slice(0, after)}<title>${escaped}</title>${text.slice(after)}`;
}
