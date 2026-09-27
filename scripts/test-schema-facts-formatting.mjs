// "Pulido de fichas" round (Part 3 of the "refactor + prompt-eval harness +
// schema-facts polish" encargo): tests for buildSchemaFactsBlock's per-
// variant differences formatting -- omitting the "additional
// attributes:"/"additional children:" line entirely when there's nothing
// to add, renaming the labels, and never printing the old "none beyond the
// common set" phrase. The enum-range collapsing itself (@caveat/
// @securityClassification/@changeType) is backend work
// (app/services/schema_cards.py) and tested in
// backend/tests/test_schema_cards.py -- this script only re-confirms the
// REAL, already-collapsed <para> data renders correctly through the
// frontend prompt builder, using the raw generated file directly (no
// backend needed), same fixture-loading pattern already established for
// the Part 1 byte-identical proof.
import fs from "node:fs";
import { buildSchemaFactsBlock } from "../src/prompts/shared.js";

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error("FAIL:", msg);
  }
}

// ---- Synthetic fixtures -- exercise every combination of (diff present /
// diff empty) x (truncated / not truncated) explicitly, including cases
// real <para> data doesn't happen to hit (a truncated-but-empty diff). ----

function makeEntry(variants, parents = ["root"]) {
  return { variants, parents, parents_truncated: false, parents_omitted: 0 };
}

function makeVariant(schemas, { attributes = [], children = [], attributes_truncated = false, attributes_omitted = 0, children_truncated = false, children_omitted = 0, resolved = true } = {}) {
  return { schemas, attributes, attributes_truncated, attributes_omitted, children, children_truncated, children_omitted, resolved };
}

{
  // Two variants: A has an extra attribute AND an extra child; B has
  // neither -- B's diff lines must be omitted entirely (nothing to add,
  // not truncated).
  const entry = makeEntry([
    makeVariant(["a"], { attributes: [{ name: "shared", required: false, enum: null }, { name: "onlyA", required: false, enum: null }], children: ["c1", "c2", "extraChild"] }),
    makeVariant(["b"], { attributes: [{ name: "shared", required: false, enum: null }], children: ["c1", "c2"] }),
  ]);
  const block = buildSchemaFactsBlock("S1000D 4.2", [{ name: "x", entry }]);
  assert(block.includes("[a]"), "variant A's schema header present");
  assert(block.includes("[b]"), "variant B's schema header present");
  assert(block.includes("additional attributes: @onlyA"), "variant A shows its extra attribute under the new label");
  assert(block.includes("additional children: extraChild"), "variant A shows its extra child under the new label");
  // Variant B has nothing to add and isn't truncated -- its diff lines
  // must be absent entirely, not merely empty.
  const bBlockStart = block.indexOf("[b]");
  const afterB = block.slice(bBlockStart, bBlockStart + 200);
  assert(!afterB.includes("additional attributes"), "variant B (nothing to add, not truncated) has NO additional-attributes line at all");
  assert(!afterB.includes("additional children"), "variant B (nothing to add, not truncated) has NO additional-children line at all");
  assert(!block.includes("none beyond the common set"), "the old 'none beyond the common set' phrase never appears anywhere");
  // 4-space indent is specifically the per-variant diff line (the common
  // block above it uses 2-space indent for its own, still-unchanged
  // "attributes:"/"children:" labels -- only the DIFF section's labels
  // were renamed).
  assert(!block.includes("\n    attributes:"), "the per-variant diff never uses the old bare 'attributes:' label");
  assert(!block.includes("\n    children:"), "the per-variant diff never uses the old bare 'children:' label");
}

{
  // A variant whose raw attribute/children lists were themselves truncated
  // server-side, with an empty diff after removing the common set -- must
  // still show a line (a real difference could be hiding past the
  // truncation), but reworded, never "none beyond the common set".
  const entry = makeEntry([
    makeVariant(["a"], { attributes: [{ name: "shared", required: false, enum: null }] }),
    makeVariant(["b"], {
      attributes: [{ name: "shared", required: false, enum: null }],
      attributes_truncated: true,
      attributes_omitted: 5,
      children_truncated: true,
      children_omitted: 3,
    }),
  ]);
  const block = buildSchemaFactsBlock("S1000D 4.2", [{ name: "y", entry }]);
  // "Did you mean con marcado a medias" round, Part 2: this line no longer
  // cites a bare "+N more" count -- a per-variant DIFF is a subset of that
  // variant's raw (pre-diff) list, so its raw omitted count can't honestly
  // be attributed to the diff (some of what was cut could be common, not a
  // real difference) -- reworded to say so in prose, with no number a
  // model could copy as if it were exact.
  assert(block.includes("additional attributes: not confirmed"), "truncated-but-empty attribute diff still shows a line, reworded");
  assert(block.includes("cut off before comparison, so a real difference could be hiding past the cutoff"), "the truncated-attributes line explains the uncertainty without citing a bare count");
  assert(!/\+\s*\d+\s*more/.test(block), "no bare '+N more' fragment anywhere in this block");
  assert(block.includes("additional children: not confirmed"), "truncated-but-empty children diff still shows a line, reworded");
  assert(!block.includes("none beyond the common set"), "still never the old phrase, even in the truncated case");
}

{
  // Single-variant entry (the overwhelmingly common case, common: null) --
  // must be completely unaffected by any of this round's changes.
  const entry = makeEntry([makeVariant(["only"], { attributes: [{ name: "frame", required: false, enum: ["top", "bottom"] }], children: ["title"] })]);
  const block = buildSchemaFactsBlock("S1000D 4.2", [{ name: "z", entry }]);
  assert(block.includes("attributes: @frame [top|bottom]"), "single-variant entry keeps the plain 'attributes:' label (never 'additional')");
  assert(block.includes("children: title"), "single-variant entry keeps the plain 'children:' label");
  assert(!block.includes("additional attributes"), "single-variant entry never uses the per-variant-diff labels at all");
}

{
  // "Did you mean con marcado a medias y listas de padres cortadas" round,
  // Part 2: a genuinely truncated name list (parents, children, or an
  // enum) must read as "(partial list: N of M shown)" -- never the old
  // bare ", +N more" a real Mistral run was seen literally copying into
  // its own answer ("+3 más") as if it were a fact rather than metadata
  // about the prompt's own capped list.
  const entry = makeEntry(
    [makeVariant(["only"], { attributes: [{ name: "kind", required: false, enum: ["a", "b", "c", "d", "e"], enum_truncated: true, enum_omitted: 3 }] })],
    ["p1", "p2", "p3", "p4", "p5"]
  );
  entry.parents_truncated = true;
  entry.parents_omitted = 3;
  const block = buildSchemaFactsBlock("S1000D 4.2", [{ name: "w", entry }]);
  assert(block.includes("[a|b|c|d|e] (partial list: 5 of 8 shown)"), `enum truncation reads "partial list: N of M shown" (got: ${block})`);
  assert(block.includes("allowed inside: p1, p2, p3, p4, p5 (partial list: 5 of 8 shown)"), `parents truncation reads "partial list: N of M shown" (got: ${block})`);
  assert(!/\+\s*\d+\s*more/.test(block), "no bare '+N more' fragment for either truncation");
}

{
  // Single-variant entry whose OWN attribute list (not an enum, the whole
  // list) was truncated server-side -- same new wording, same exact math.
  const entry = makeEntry([
    makeVariant(["only"], {
      attributes: [{ name: "a1", required: false, enum: null }, { name: "a2", required: false, enum: null }],
      attributes_truncated: true,
      attributes_omitted: 4,
    }),
  ]);
  const block = buildSchemaFactsBlock("S1000D 4.2", [{ name: "v", entry }]);
  assert(block.includes("attributes: @a1, @a2 (partial list: 2 of 6 shown)"), `single-variant attribute-list truncation reads "partial list: N of M shown" (got: ${block})`);
  assert(!/\+\s*\d+\s*more/.test(block), "no bare '+N more' fragment for the single-variant attribute-list truncation");
}

{
  // Non-empty per-variant DIFF whose raw (pre-diff) list was ALSO
  // truncated server-side -- unlike the plain name-list/enum cases above,
  // the diff's own shown+omitted is NOT an honest total (some of what was
  // cut could belong to the common set, not the diff), so this must never
  // print a number here -- only the prose PARTIAL_DIFF_NOTE.
  const entry = makeEntry([
    makeVariant(["a"], { attributes: [{ name: "shared", required: false, enum: null }] }),
    makeVariant(["b"], {
      attributes: [{ name: "shared", required: false, enum: null }, { name: "onlyB", required: false, enum: null }],
      attributes_truncated: true,
      attributes_omitted: 9,
      children: ["c1"],
      children_truncated: true,
      children_omitted: 7,
    }),
  ]);
  const block = buildSchemaFactsBlock("S1000D 4.2", [{ name: "u", entry }]);
  assert(block.includes("additional attributes: @onlyB (this variant"), `non-empty truncated attribute diff carries the prose note, no number (got: ${block})`);
  assert(block.includes("further differences may exist beyond what is shown"), "the prose note itself is present");
  assert(!/\+\s*\d+\s*more/.test(block), "no bare '+N more' fragment for the non-empty truncated diff either");
}

// ---- Real data: <para> in S1000D 4.2, loaded directly from the generated
// file (no backend needed) -- confirms the labels/omission rules hold
// against the actual 8-variant, real-schema case the encargo names. ----

const realCards = JSON.parse(fs.readFileSync(new URL("../backend/schema_cards/schema-cards-4-2.json", import.meta.url), "utf8"));
const paraVariants = realCards.cards.para;
const paraParents = realCards.parents.para || [];

// Mirror the backend's own compaction limits/shape closely enough for this
// test (no MAX_* truncation ever kicks in for <para>'s real attribute/
// child counts, confirmed by the existing pytest suite) -- and apply the
// SAME range-collapsing the backend now does at serve time, since this
// script reads the raw pre-collapse generator output directly from disk.
function collapseEnumForTest(values) {
  if (!values) return values;
  const parsed = values.map((v) => {
    const m = /^([A-Za-z_]*)(\d+)$/.exec(v);
    return m ? { prefix: m[1], digits: m[2] } : null;
  });
  if (parsed.some((p) => p === null)) return values;
  const prefixes = new Set(parsed.map((p) => p.prefix));
  const widths = new Set(parsed.map((p) => p.digits.length));
  if (prefixes.size !== 1 || widths.size !== 1) return values;
  const prefix = [...prefixes][0];
  const width = [...widths][0];
  const nums = [...new Set(parsed.map((p) => parseInt(p.digits, 10)))].sort((a, b) => a - b);
  const fmt = (n) => `${prefix}${String(n).padStart(width, "0")}`;
  const tokens = [];
  let start = nums[0];
  let prev = nums[0];
  for (const n of nums.slice(1)) {
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    tokens.push(start === prev ? fmt(start) : `${fmt(start)}–${fmt(prev)}`);
    start = prev = n;
  }
  tokens.push(start === prev ? fmt(start) : `${fmt(start)}–${fmt(prev)}`);
  return tokens;
}

const realEntry = {
  variants: paraVariants.map((v) => ({
    schemas: v.schemas,
    resolved: v.resolved !== false,
    attributes: (v.attributes || []).map((a) => ({ ...a, enum: collapseEnumForTest(a.enum), enum_truncated: false, enum_omitted: 0 })),
    attributes_truncated: false,
    attributes_omitted: 0,
    children: v.children || [],
    children_truncated: false,
    children_omitted: 0,
  })),
  parents: paraParents,
  parents_truncated: false,
  parents_omitted: 0,
};

const realBlock = buildSchemaFactsBlock("S1000D 4.2", [{ name: "para", entry: realEntry }]);

assert(realBlock.includes("@caveat [cv01–cv99]"), "real <para>: @caveat renders as the full cv01–cv99 range");
assert(realBlock.includes("@securityClassification [01–99]"), "real <para>: @securityClassification renders as the full 01–99 range");
assert(realBlock.includes("@changeType [add|delete|modify]"), "real <para>: @changeType stays a plain listing, never a range (not a numeric sequence)");
assert(!realBlock.includes("none beyond the common set"), "real <para>: the old phrase never appears");
assert(realBlock.includes("additional children:"), "real <para>: at least one variant has a real children difference, shown under the new label");
assert(!realBlock.includes("\n    attributes:"), "real <para>: no variant needs an 'additional attributes' line (all 11 real attributes are common to all 8 variants) -- confirms empty diffs are omitted, not just relabeled");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
