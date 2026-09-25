// Docs request ("comprobación de vocabulario solo determinista, sin
// bloqueo, sin referencias inventadas") -- closeout requires tests of
// vocabularyCheck.js covering ONLY the deterministic path now (the LLM
// extraction path is removed entirely this round -- confirmed by grep
// that extractVocabCandidatesViaLLM/buildVocabExtractionPrompt/
// parseVocabExtractionResponse/filterLLMStopwords/isStopword/STOPWORDS no
// longer exist anywhere in the module, see the import list below), plus
// the camelCase/descriptive-word/list-capture heuristics this round adds.
// This repo has no JS test runner (documented in CLAUDE.md) -- same
// convention already used by test-schematron-dita.mjs: import the REAL
// production module directly under plain Node and assert against it, not
// a mock or a duplicated copy.
//
//     node scripts/test-vocabulary-check.mjs
import {
  extractContextCandidates,
  applyRenameSuggestion,
  checkAgainstVocabulary,
  formatWrongTypeMessage,
  hashVocabInputText,
} from "../src/utils/vocabularyCheck.js";

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures += 1;
    console.error("FAIL:", msg);
  } else {
    console.log("OK:", msg);
  }
}

// ---- explicit markup extraction ----

assert(
  extractContextCandidates("The element <pokemon> will not be used.").elements.includes("pokemon"),
  "<pokemon> extracted as element"
);
assert(
  extractContextCandidates("</pokemon> closes the tag.").elements.includes("pokemon"),
  "closing tag </pokemon> also extracted as element (slash excluded from the name)"
);
assert(
  extractContextCandidates("Do not use <del> here.").elements.includes("del"),
  "<del> written explicitly is still extracted by the context path (never filtered -- there is no filter any more)"
);
assert(
  extractContextCandidates("Use @conref to reference content.").attributes.includes("conref"),
  "@conref extracted as attribute"
);
assert(extractContextCandidates("Use @label for this.").attributes.includes("label"), "@label extracted as attribute");

// ---- phrase-trigger extraction: connectors ----

{
  const c = extractContextCandidates("atributos del elemento pokemon");
  assert(c.ambiguous.includes("pokemon"), 'edge case "atributos del elemento pokemon" -> pokemon flagged (re-anchors on the later trigger)');
  assert(
    !c.ambiguous.includes("elemento") && !c.ambiguous.includes("atributos") && !c.ambiguous.includes("del"),
    "trigger/connector words themselves never become candidates"
  );
}
assert(
  extractContextCandidates("the attribute of the element pokemon").ambiguous.includes("pokemon"),
  '"the attribute of the element pokemon" -> pokemon (connectors "of"/"the" skipped)'
);

// ---- follow-up round point 2: descriptive-word skip ----

{
  // The encargo's own reported false positive: "atributo de tipo cl" must
  // yield "cl", never "tipo".
  const c = extractContextCandidates("no lleva atributo de tipo cl");
  assert(c.ambiguous.includes("cl"), '"atributo de tipo cl" -> cl captured');
  assert(!c.ambiguous.includes("tipo"), '"atributo de tipo cl" -> "tipo" never captured (descriptive word, skipped)');
}
{
  const c = extractContextCandidates("el atributo llamado applicRefId");
  assert(c.ambiguous.includes("applicRefId"), '"el atributo llamado applicRefId" -> applicRefId captured (skips "llamado")');
}
{
  const c = extractContextCandidates("the element named pokemon");
  assert(c.ambiguous.includes("pokemon"), '"the element named pokemon" -> pokemon (skips "named")');
}
{
  const c = extractContextCandidates("el elemento de nombre pokemon");
  assert(c.ambiguous.includes("pokemon"), '"el elemento de nombre pokemon" -> pokemon (skips "de nombre")');
}

// ---- follow-up round point 2: list capture ----

{
  const c = extractContextCandidates("atributos de tipo cl, pl ni ip");
  assert(
    c.ambiguous.includes("cl") && c.ambiguous.includes("pl") && c.ambiguous.includes("ip"),
    '"atributos de tipo cl, pl ni ip" -> cl, pl AND ip all captured (comma + "ni" list continuation)'
  );
  assert(!c.ambiguous.includes("tipo"), 'list-capture case still never captures "tipo"');
}
{
  const c = extractContextCandidates("attributes of type cl, pl and ip");
  assert(
    c.ambiguous.includes("cl") && c.ambiguous.includes("pl") && c.ambiguous.includes("ip"),
    "English list capture: comma + \"and\" continuation"
  );
}
{
  // The exact real report, verbatim: "lA ETIQUETA <table> no lleva
  // atributo de tipo cl, pl y de tipo ip si es de valor 23" -- interleaved
  // "de tipo" between the conjunction and the third list item must still
  // be skipped, and the sentence must stop cleanly at "si" (never
  // capturing it or anything after it).
  const c = extractContextCandidates(
    "lA ETIQUETA <table> no lleva atributo de tipo cl, pl y de tipo ip si es de valor 23"
  );
  assert(
    c.ambiguous.includes("cl") && c.ambiguous.includes("pl") && c.ambiguous.includes("ip"),
    "real report: cl, pl and ip all captured despite the interleaved \"de tipo\" before the 3rd item"
  );
  assert(!c.ambiguous.includes("tipo"), "real report: \"tipo\" (appearing twice) never captured");
  assert(!c.ambiguous.includes("lA") && !c.ambiguous.includes("la"), "real report: \"lA\" never captured (not a phrase candidate, and camelCase rejects it too -- see below)");
  assert(!c.ambiguous.includes("si") && !c.ambiguous.includes("es") && !c.ambiguous.includes("valor"), "real report: the list stops cleanly at \"si\" -- nothing after it leaks in");
  assert(c.elements.includes("table"), "real report: <table> still extracted via explicit markup, independent of the list-capture logic");
}

// ---- unchanged edge cases ----

{
  const c = extractContextCandidates("decidir si se usa la lista");
  assert(
    c.elements.length === 0 && c.attributes.length === 0 && c.ambiguous.length === 0,
    'edge case "decidir si se usa la lista" -> zero candidates'
  );
}
{
  // BRDP-S1-00053, a real catalog entry (S1000D 4.2, Verified Rule):
  // ordinary technical English, no <>/@markup, no "element"/"attribute"
  // phrasing -- must produce zero candidates of any kind now that the
  // LLM-guess path (which used to flag "change"/"data"/"marks"/"module"/
  // "changed"/"revised" here) is gone entirely.
  const c = extractContextCandidates("Data module change/revised ratio");
  assert(
    c.elements.length === 0 && c.attributes.length === 0 && c.ambiguous.length === 0,
    "BRDP-S1-00053's real title (\"Data module change/revised ratio\") -> zero candidates"
  );
}

// ---- follow-up round point 2: tighter camelCase (min 2 lowercase, then uppercase, min length 5) ----

assert(
  extractContextCandidates("Confirm proceduralStep numbering is correct.").ambiguous.includes("proceduralStep"),
  "camelCase proceduralStep (long) still captured"
);
assert(extractContextCandidates("See dmCode for details.").ambiguous.includes("dmCode"), "camelCase dmCode (6 chars) captured");
assert(extractContextCandidates("See dmRef for details.").ambiguous.includes("dmRef"), "camelCase dmRef (exactly 5 chars, the minimum) captured");
assert(extractContextCandidates("Use applicRefId here.").ambiguous.includes("applicRefId"), "camelCase applicRefId captured");
assert(
  !extractContextCandidates("lA ETIQUETA no lleva nada.").ambiguous.includes("lA"),
  '"lA" (1 lowercase before the uppercase) never captured as camelCase'
);
assert(
  !extractContextCandidates("abCd is too short.").ambiguous.includes("abCd"),
  '"abCd" (4 chars, below the length-5 minimum) never captured despite matching 2-lowercase-then-uppercase'
);
assert(
  !extractContextCandidates("Confirm this is fine.").ambiguous.includes("this"),
  "a plain lowercase word (no inner uppercase) is never treated as camelCase"
);

// ---- renamable candidates + applyRenameSuggestion ("Did you mean?") ----

{
  const c = extractContextCandidates("el elemento pokemon");
  assert(
    c.renamable.length === 1 && c.renamable[0].name === "pokemon" && c.renamable[0].type === "element",
    '"el elemento pokemon" -> one renamable candidate {name:"pokemon", type:"element"}'
  );
}
{
  const c = extractContextCandidates("el atributo llamado applicRefId");
  assert(
    c.renamable.some((r) => r.name === "applicRefId" && r.type === "attribute"),
    '"el atributo llamado applicRefId" -> renamable as type "attribute"'
  );
}
{
  // Already marked up elsewhere in the same text -- never offered for
  // renaming a second time.
  const c = extractContextCandidates("el elemento <pokemon> ya está bien escrito");
  assert(c.renamable.length === 0, "a name already wrapped in <...> elsewhere in the text is never renamable");
}
{
  const fixed = applyRenameSuggestion("el elemento pokemon", { name: "pokemon", type: "element" });
  assert(fixed === "el elemento <pokemon>", `applyRenameSuggestion wraps the bare word in <...> (got: ${fixed})`);
}
{
  const fixed = applyRenameSuggestion("el atributo pokemon", { name: "pokemon", type: "attribute" });
  assert(fixed === "el atributo @pokemon", `applyRenameSuggestion wraps the bare word in @... for an attribute (got: ${fixed})`);
}
{
  // A suggestion that no longer applies (text changed since it was
  // computed) is a no-op, never a throw.
  const fixed = applyRenameSuggestion("nothing here", { name: "pokemon", type: "element" });
  assert(fixed === "nothing here", "applyRenameSuggestion is a no-op when the name can no longer be found bare");
}

// ---- checkAgainstVocabulary: solo determinista now, no possiblyNotFound ----

const vocab4_2 = { elements: new Set(["topic", "task", "machineryTask", "step", "table"]), attributes: new Set(["id", "conref", "label"]) };
const emptyCtx = { elements: [], attributes: [], ambiguous: [] };

{
  const r = checkAgainstVocabulary({ elements: ["pokemon"], attributes: [], ambiguous: [] }, vocab4_2);
  assert(r.available === true, "vocabulary marked available when one is supplied");
  assert(r.notFound.includes("<pokemon>"), "context-path <pokemon> -> notFound");
  assert(!("possiblyNotFound" in r), "the result shape no longer has a possiblyNotFound key at all");
}
{
  const r = checkAgainstVocabulary({ elements: ["topic"], attributes: [], ambiguous: [] }, vocab4_2);
  assert(r.notFound.length === 0 && r.wrongType.length === 0, "edge case: <topic> known -> zero warnings of any kind");
}
{
  const r = checkAgainstVocabulary({ elements: ["anything"], attributes: [], ambiguous: [] }, null);
  assert(r.available === false && r.notFound.length === 0 && r.wrongType.length === 0, "no vocabulary -> not available, zero false positives");
}
{
  const r = checkAgainstVocabulary({ elements: [], attributes: [], ambiguous: ["id", "task"] }, vocab4_2);
  assert(r.notFound.length === 0, "ambiguous candidates matched against the union of elements+attributes");
}
{
  const r = checkAgainstVocabulary(emptyCtx, vocab4_2);
  assert(r.available === true && r.notFound.length === 0 && r.wrongType.length === 0, "empty candidates -> available, zero warnings");
}

// Wrong-kind check, both directions, real S1000D 4.2 shape (label is an
// attribute only) -- the encargo's own <label> edge case.
{
  const r = checkAgainstVocabulary({ elements: ["label"], attributes: [], ambiguous: [] }, vocab4_2);
  assert(r.wrongType.length === 1 && r.wrongType[0].name === "label", "context <label> (used as element) -> wrongType, not merely notFound");
  assert(r.wrongType[0].usedAs === "element" && r.wrongType[0].actualAs === "attribute", "wrongType records usedAs=element, actualAs=attribute for <label>");
  assert(r.notFound.length === 0, "a wrongType name is never ALSO listed as notFound");
}
{
  const r = checkAgainstVocabulary({ elements: [], attributes: ["label"], ambiguous: [] }, vocab4_2);
  assert(r.notFound.length === 0 && r.wrongType.length === 0, "edge case: @label (correct kind) -> zero warnings");
}
{
  const vocabReverse = { elements: new Set(["title"]), attributes: new Set([]) };
  const r = checkAgainstVocabulary({ elements: [], attributes: ["title"], ambiguous: [] }, vocabReverse);
  assert(r.wrongType.length === 1 && r.wrongType[0].usedAs === "attribute" && r.wrongType[0].actualAs === "element", "reverse direction: @title (used as attribute) -> wrongType, actualAs=element");
}
{
  // The real report's <table> and cl/pl/ip attributes, run end to end
  // through the full extraction + comparison pipeline.
  const c = extractContextCandidates(
    "lA ETIQUETA <table> no lleva atributo de tipo cl, pl y de tipo ip si es de valor 23"
  );
  const r = checkAgainstVocabulary(c, vocab4_2);
  assert(!r.notFound.includes("table") && !r.notFound.includes("<table>"), "real report: <table> is real S1000D 4.2 vocabulary -> not in notFound");
  assert(
    ["cl", "pl", "ip"].every((n) => r.notFound.includes(n)),
    "real report: cl, pl and ip all reported as not-found attributes (none exist in this vocab)"
  );
  assert(!r.notFound.includes("tipo") && !r.notFound.includes("lA"), "real report: \"tipo\"/\"lA\" never appear in the final warnings either");
}

// formatWrongTypeMessage -- exact sentence shape (unchanged by this round)
{
  const msg = formatWrongTypeMessage("S1000D 4.2", { name: "label", usedAs: "element", actualAs: "attribute" });
  assert(
    msg === "<label> is not an element in S1000D 4.2 — it exists as attribute @label.",
    `formatWrongTypeMessage exact wording (got: ${msg})`
  );
}
{
  const msg = formatWrongTypeMessage("DITA 1.3", { name: "title", usedAs: "attribute", actualAs: "element" });
  assert(
    msg === "@title is not an attribute in DITA 1.3 — it exists as element <title>.",
    `formatWrongTypeMessage exact wording, reverse direction (got: ${msg})`
  );
}

// ---- hashVocabInputText (cache key) -- unchanged by this round ----
{
  const h1 = hashVocabInputText("T", "D", "P");
  const h2 = hashVocabInputText("T", "D", "P");
  const h3 = hashVocabInputText("T", "D", "P2");
  assert(h1 === h2, "same (title, definition, proposal) -> same hash");
  assert(h1 !== h3, "different text -> different hash");
}

console.log(failures === 0 ? "\nALL CHECKS PASSED\n" : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
