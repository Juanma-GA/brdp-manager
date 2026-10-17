// Test de reglas DITA: el contexto en la raíz decide a qué documentos se
// aplica. Navantia BRDP-EXT-00034 ("DITA 1.3 Xpath3.0"), a correct rule:
//   /*[matches(translate(lower-case(string(normalize-space(concat(@base, ' ', title)))),
//     'áéíóúüñ', 'aeiouun'), 'registro de inspecciones, pruebas y acciones de
//     (reparacion|reacondicionamiento) en taller')]
// The rule only applies to documents whose ROOT title (or @base) says that.
// The prompt asked for a titled <section>, Mistral put the text there and
// left the topic as "Maintenance Procedures": the rule applied to no example
// and the verdict said "the rule does not cover the decision". Here,
// generically (nothing by identifier, title text or element name), for
// Schematron DITA only:
//   - rootContextConditions: the contexts anchored at the document's root
//     ("/*[…]", "/topic[…]", "/task[…]") with a predicate on that first
//     step -- the documents the rule applies to;
//   - rootTitleRequirement: whether that predicate looks at the root's own
//     <title> or @base (for the examples prompt);
//   - rootApplicability: whether a document meets it (a run of the root
//     step alone, with the rule's lets).
// A rule only counts as "root-scoped" when EVERY context alternative is such
// a context: with a context elsewhere, the example can be judged there, as
// before.
import { pathAlternatives, pathSteps } from '../validation/rulePathCheck.js';
import { schematronContexts } from './ruleTestSkeleton.js';
import { stripLiterals } from './ruleTestCommon.js';
import { topicTitleConditions } from './topicTitleValue.js';

const TITLE_IN_PREDICATE_RE = /(?<![@\w:$.-])(?:child::)?title\b(?!\s*\()/;
const BASE_IN_PREDICATE_RE = /(?:@|attribute::)base\b/;

// [{ context, alternative, root: '*' | name, predicates: [text],
//    predicate: '[…][…]', title, base }] for each root-anchored alternative
// with a predicate on its first step.
export function rootContextConditions(ruleXml) {
  const out = [];
  for (const raw of schematronContexts(ruleXml)) {
    const context = raw.replace(/\s+/g, ' ').trim();
    for (const alternative of pathAlternatives(context)) {
      const { absolute, steps } = pathSteps(alternative);
      const first = steps[0];
      if (!absolute || !first || first.sep !== '/') continue;
      const root = first.main === '*' ? '*' : first.kind === 'element' ? first.name : null;
      if (!root || first.predicates.length === 0) continue;
      const text = first.predicates.map((p) => stripLiterals(p)).join(' ');
      out.push({
        context,
        alternative: alternative.trim(),
        root,
        rest: steps.slice(1),
        predicates: first.predicates,
        predicate: first.predicates.map((p) => `[${p}]`).join(''),
        title: TITLE_IN_PREDICATE_RE.test(text),
        base: BASE_IN_PREDICATE_RE.test(text),
      });
    }
  }
  return out;
}

// Whether every context alternative of the rule is anchored at the root
// with a predicate on that step (the rule only applies to some documents).
export function ruleIsRootScoped(ruleXml) {
  const contexts = schematronContexts(ruleXml);
  if (contexts.length === 0) return false;
  const total = contexts.flatMap((c) => pathAlternatives(c.replace(/\s+/g, ' ').trim())).length;
  const scoped = rootContextConditions(ruleXml).length;
  return total > 0 && scoped === total;
}

// For the examples prompt (Part 1): the root's own <title> / @base the rule
// asks for, when the predicate of a root-anchored context looks at them --
//   { root, predicates: [the first step's predicate as written], title,
//     base, literal }
// literal: the title is compared with a literal (topicTitleConditions) --
// the application writes it, as before (topicTitleValue.js). null when no
// root-anchored context looks at the title or @base.
export function rootTitleRequirement(ruleXml) {
  const conditions = rootContextConditions(ruleXml).filter((c) => c.title || c.base);
  if (conditions.length === 0) return null;
  const literalAlternatives = new Set(topicTitleConditions(ruleXml).map((c) => c.expression));
  const predicates = [...new Set(conditions.map((c) => c.predicate))];
  return {
    root: conditions[0].root,
    roots: [...new Set(conditions.map((c) => c.root))],
    predicates,
    title: conditions.some((c) => c.title),
    base: conditions.some((c) => c.base),
    literal: conditions.every((c) => literalAlternatives.has(c.alternative)),
  };
}
