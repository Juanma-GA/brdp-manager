// Schema cards (GET /api/schema-cards): the common/variant-diff summary
// that the prompt (prompts/shared.js buildSchemaFactsBlock) and the card in
// the interface (components/assistant/SchemaFactCard.jsx) both render.
// Moved unchanged out of utils/vocabularyCheck.js in consolidation C1 --
// presentation of schema facts, not validation.

// Ask-with-schema-cards follow-up round, point 4 ("fichas más compactas con
// variantes"): a real report against this app -- `<para>` in S1000D 4.2
// has 8 variants, and the previous rendering repeated every attribute and
// child for EACH of the 8, producing a wall of near-identical text that
// buried the one or two things that actually differ between variants.
// `entry` is the exact shape GET /api/schema-cards returns for one name
// ({variants: [{schemas, attributes, children, resolved, ...}], parents,
// ...}) -- this function never re-fetches or reformats that data, only
// re-partitions it into "common to every variant" vs "per-variant diff",
// so buildSchemaFactsBlock (the prompt) and SchemaFactCard (the UI) can
// share one single, testable computation instead of two independently-
// drifting formatters.
//
// `parents` is already NOT per-variant in this data (one list for the
// whole element, see backend/app/services/schema_cards.py) -- so it is
// already "common" by construction and is returned as-is, never diffed.
//
// Attributes: an attribute counts as common only if EVERY variant has one
// with the exact same name AND required-ness AND enum (including its own
// truncation flags) -- a same-named attribute that differs in any of
// those between variants is genuinely a difference, so it is left OUT of
// the common set and shown per-variant instead, never silently merged.
// Children: common iff the name appears in every variant's children list
// (plain set membership, no attached properties to compare).
//
// A single-variant entry (the overwhelmingly common case) returns
// `common: null` -- there is nothing to summarize across variants, so
// callers should render it the old, simple way (this function only ever
// changes the OUTPUT SHAPE for entries that genuinely have more than one
// variant, per the encargo's own "si un elemento tiene varias variantes").
function attributeSignature(attr) {
  return [attr.name, attr.required, JSON.stringify(attr.enum || null), !!attr.enum_truncated, attr.enum_omitted || 0].join('\u0000');
}

// "Fichas sin hijos comunes" round: a real 4.2 answer said
// <identAndStatusSection> "has no children" because the card said
// "children: none" under "common to all 6 schema variants" -- no child is
// common to every schema (dmAddress/dmStatus, commentAddress/
// commentStatus, ...), but every schema has some. So each kind now has a
// mode, and callers never write "none" unless no variant has any:
//   'common'   -- something is common to all variants (listed as such,
//                 with per-variant "additional" diffs below);
//   'bySchema' -- nothing is common but some variant has some: listed per
//                 variant group (the diff IS the variant's full list);
//   'none'     -- no variant has any.
// `schemaCount` is how many schemas the card covers (the union of every
// variant's schemas), not how many variant groups there are.
export function summarizeSchemaFactEntry(entry) {
  const variants = entry.variants || [];
  const schemaCount = new Set(variants.flatMap((v) => v.schemas || [])).size;
  if (variants.length <= 1) return { common: null, variants, schemaCount, anyUnresolved: variants.some((v) => !v.resolved) };

  const attrSigSets = variants.map((v) => new Set((v.attributes || []).map(attributeSignature)));
  const commonAttrSigs = [...attrSigSets[0]].filter((sig) => attrSigSets.every((s) => s.has(sig)));
  const commonAttrSigSet = new Set(commonAttrSigs);
  const commonAttributes = (variants[0].attributes || []).filter((a) => commonAttrSigSet.has(attributeSignature(a)));

  const childSets = variants.map((v) => new Set(v.children || []));
  const commonChildren = [...childSets[0]].filter((name) => childSets.every((s) => s.has(name)));
  const commonChildSet = new Set(commonChildren);

  const perVariant = variants.map((v) => ({
    schemas: v.schemas,
    resolved: v.resolved,
    diffAttributes: (v.attributes || []).filter((a) => !commonAttrSigSet.has(attributeSignature(a))),
    attributes_truncated: v.attributes_truncated,
    attributes_omitted: v.attributes_omitted,
    diffChildren: (v.children || []).filter((name) => !commonChildSet.has(name)),
    children_truncated: v.children_truncated,
    children_omitted: v.children_omitted,
  }));

  // A variant whose list was cut counts as having some (its names were
  // just not shown), so "none" is never written over a truncated list.
  const modeOf = (commonList, key) =>
    commonList.length > 0
      ? 'common'
      : variants.some((v) => (v[key] || []).length > 0 || v[`${key}_truncated`])
        ? 'bySchema'
        : 'none';

  return {
    common: { attributes: commonAttributes, children: commonChildren },
    attributesMode: modeOf(commonAttributes, 'attributes'),
    childrenMode: modeOf(commonChildren, 'children'),
    perVariant,
    schemaCount,
    anyUnresolved: variants.some((v) => !v.resolved),
  };
}
