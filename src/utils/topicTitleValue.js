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
