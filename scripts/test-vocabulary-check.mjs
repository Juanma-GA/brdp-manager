// Docs request ("consejo de nombres sin Don't show again y sugerencias
// contextuales sin falsos positivos") -- closeout requires tests of
// vocabularyCheck.js covering: Unicode-aware tokenization (accented words
// never fragment), the new etiqueta(s)/tag(s) trigger synonyms, and the
// vocabulary-gated resolvePhraseCandidates (a phrase-triggered bare word
// is ONLY ever a suggestion, never a "Not found" warning, and only when it
// genuinely resolves against the real vocabulary). Builds on the previous
// round's "solo determinista" tests (camelCase/skip-words/list-capture
// mechanics), most of which are unchanged and kept as regression coverage.
// This repo has no JS test runner (documented in CLAUDE.md) -- same
// convention already used by test-schematron-dita.mjs: import the REAL
// production module directly under plain Node and assert against it, not
// a mock or a duplicated copy.
//
//     node scripts/test-vocabulary-check.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  extractContextCandidates,
  resolvePhraseCandidates,
  resolveDanglingElementSuggestions,
  applyRenameSuggestion,
  checkAgainstVocabulary,
  formatWrongTypeMessage,
  hashVocabInputText,
  extractSchemaFactCandidates,
  selectSchemaFactNames,
  summarizeSchemaFactEntry,
} from "../src/utils/vocabularyCheck.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures += 1;
    console.error("FAIL:", msg);
  } else {
    console.log("OK:", msg);
  }
}

const vocab4_2 = {
  elements: new Set(["topic", "task", "machineryTask", "step", "table"]),
  attributes: new Set(["id", "conref", "label", "applicRefId"]),
};

// ---- explicit markup extraction (unchanged) ----

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
  "<del> written explicitly is still extracted by the context path"
);
assert(
  extractContextCandidates("Use @conref to reference content.").attributes.includes("conref"),
  "@conref extracted as attribute"
);
assert(extractContextCandidates("Use @label for this.").attributes.includes("label"), "@label extracted as attribute");

// ---- "Did you mean con marcado a medias" round, Part 1: half-typed
// bracket markup ("<table" with no ">", "table>" with no "<") is a
// candidate WITHOUT any trigger word -- the encargo's own edge-case table.

{
  const ctx = extractContextCandidates("Title above the <table");
  assert(ctx.elements.includes("table"), "dangling open '<table' (no closing '>') is captured as an element candidate");
  assert(ctx.danglingElements.includes("table"), "'table' is reported as genuinely dangling (not already fully marked up)");
}
{
  const ctx = extractContextCandidates("above the table>");
  assert(ctx.elements.includes("table"), "dangling close 'table>' (no opening '<') is captured as an element candidate");
  assert(ctx.danglingElements.includes("table"), "'table' is reported as genuinely dangling");
}
{
  // Not found in the vocabulary -> treated exactly like a complete
  // <pokemon> tag for the RED WARNING (checkAgainstVocabulary), because
  // the intent to mark up an element is just as explicit as if the
  // bracket had been closed -- but NOT offered as a "Did you mean"
  // completion (there's nothing real to complete it to).
  const ctx = extractContextCandidates("above the <pokemon");
  const checked = checkAgainstVocabulary(ctx, vocab4_2);
  assert(checked.notFound.includes("<pokemon>"), "dangling '<pokemon' (not in vocabulary) still produces the red 'not found' warning");
  assert(resolveDanglingElementSuggestions(ctx.danglingElements, vocab4_2).length === 0, "an unresolvable dangling name is never offered as a completion suggestion");
}
{
  // Found in the vocabulary -> a completion suggestion, and NEVER a red
  // warning (it's a real element, just half-typed).
  const ctx = extractContextCandidates("Title above the <table");
  const checked = checkAgainstVocabulary(ctx, vocab4_2);
  assert(checked.notFound.length === 0, "a resolvable dangling name never produces a red warning");
  const suggestions = resolveDanglingElementSuggestions(ctx.danglingElements, vocab4_2);
  assert(suggestions.length === 1 && suggestions[0].name === "table" && suggestions[0].type === "element", "a resolvable dangling name IS offered as an element completion suggestion");
}
{
  // Never confused with a plain comparison/arrow: the character
  // immediately adjacent to the bracket must be a letter, with nothing in
  // between -- "a < b" has a space, "x<5" has a digit, "->" has no "<" at
  // all right before the ">".
  assert(extractContextCandidates("if a < b then...").danglingElements.length === 0, "'a < b' (space before the candidate letter) is never a dangling-markup candidate");
  assert(extractContextCandidates("x<5 is true").danglingElements.length === 0, "'x<5' (digit right after '<', not a letter) is never a dangling-markup candidate");
  assert(extractContextCandidates("value -> result").danglingElements.length === 0, "'->' (no letter adjacent to any bracket) is never a dangling-markup candidate");
}
{
  // A complete tag is never ALSO reported as dangling (no double-counting,
  // no spurious second suggestion for the same name).
  const complete = extractContextCandidates("<table>");
  assert(complete.elements.includes("table") && complete.danglingElements.length === 0, "a complete <table> tag is captured once as 'elements', never listed in 'danglingElements' too");
  const closing = extractContextCandidates("closing tag </table>");
  assert(closing.elements.includes("table") && closing.danglingElements.length === 0, "a complete closing </table> tag is likewise never reported as dangling");
}
{
  // Completing the markup: applyRenameSuggestion (already fixed in an
  // earlier round for exactly this shape) closes the bracket without
  // duplicating it either way.
  assert(applyRenameSuggestion("Title above the <table", { name: "table", type: "element" }) === "Title above the <table>", "dangling open completes to '<table>' (adds only the missing '>')");
  assert(applyRenameSuggestion("above the table>", { name: "table", type: "element" }) === "above the <table>", "dangling close completes to '<table>' (adds only the missing '<')");
}

// ---- phrase-trigger extraction: connectors, descriptive words, lists (unchanged mechanics) ----

{
  const c = extractContextCandidates("atributos del elemento pokemon");
  assert(
    c.phraseCandidates.some((p) => p.name === "pokemon"),
    'edge case "atributos del elemento pokemon" -> pokemon captured (re-anchors on the later trigger)'
  );
  assert(
    !c.phraseCandidates.some((p) => ["elemento", "atributos", "del"].includes(p.name)),
    "trigger/connector words themselves never become candidates"
  );
}
assert(
  extractContextCandidates("the attribute of the element pokemon").phraseCandidates.some((p) => p.name === "pokemon"),
  '"the attribute of the element pokemon" -> pokemon (connectors "of"/"the" skipped)'
);
{
  const c = extractContextCandidates("no lleva atributo de tipo cl");
  assert(c.phraseCandidates.some((p) => p.name === "cl"), '"atributo de tipo cl" -> cl captured');
  assert(!c.phraseCandidates.some((p) => p.name === "tipo"), '"atributo de tipo cl" -> "tipo" never captured (descriptive word, skipped)');
}
{
  const c = extractContextCandidates("el atributo llamado applicRefId");
  assert(
    c.phraseCandidates.some((p) => p.name === "applicRefId" && p.type === "attribute"),
    '"el atributo llamado applicRefId" -> applicRefId captured as attribute (skips "llamado")'
  );
}
{
  const c = extractContextCandidates("atributos de tipo cl, pl ni ip");
  const names = c.phraseCandidates.map((p) => p.name);
  assert(names.includes("cl") && names.includes("pl") && names.includes("ip"), '"atributos de tipo cl, pl ni ip" -> cl, pl AND ip all captured');
  assert(!names.includes("tipo"), 'list-capture case still never captures "tipo"');
}

// ---- follow-up round point 4: etiqueta(s)/tag(s) as element-type triggers ----

for (const trigger of ["etiqueta", "etiquetas", "tag", "tags"]) {
  const c = extractContextCandidates(`the ${trigger} pokemon should not be used`);
  assert(
    c.phraseCandidates.some((p) => p.name === "pokemon" && p.type === "element"),
    `"${trigger}" triggers a phrase candidate typed as element (got: ${JSON.stringify(c.phraseCandidates)})`
  );
}

// ---- follow-up round point 3: Unicode-aware tokenization (accented words never fragment) ----

{
  // The real bug: "elemento <stranger> y cómo usarlos" used to fragment
  // "cómo" into "c"/"mo" at the accented character, and the "y" (list
  // continuation) chained the "c" fragment onto the "elemento" trigger's
  // candidate list as a spurious single-letter "name" -- producing the
  // nonsensical real report "Did you mean `<c>`?".
  const c = extractContextCandidates("en el elemento <stranger> y cómo usarlos.");
  const names = c.phraseCandidates.map((p) => p.name);
  assert(!names.includes("c") && !names.includes("mo"), 'accented word "cómo" never fragments into "c"/"mo" candidates');
  // "stranger" is excluded too, but for the UNRELATED reason that it is
  // already marked up via <stranger> elsewhere in the same text.
  assert(!names.includes("stranger"), '"stranger" excluded from phraseCandidates (already marked up via <stranger>)');
  // Whatever DOES get captured after "y" (if anything) must be the whole
  // word "cómo", never a fragment -- checked directly, not just by absence.
  for (const n of names) assert(/^[\p{L}]+$/u.test(n), `every captured phrase candidate is a real whole word, never a fragment (got: "${n}")`);
}
{
  // Accented words elsewhere in the text (not near any trigger) must also
  // come through the tokenizer whole -- confirmed via a case where the
  // accented word IS the trigger's own candidate.
  const c = extractContextCandidates("el atributo señal debe usarse");
  assert(c.phraseCandidates.some((p) => p.name === "señal"), '"el atributo señal" -> the accented word "señal" captured whole, not fragmented');
}
{
  const c = extractContextCandidates("la utilizará en el proceso");
  // "utilizará" must tokenize as one word -- confirmed indirectly via
  // camelCase extraction never seeing any ASCII fragment of it either
  // (no fragment can accidentally look like camelCase, but the more
  // direct check is that resolvePhraseCandidates/extractContextCandidates
  // never see a lone "utilizar"/"á" pair reported anywhere).
  assert(c.phraseCandidates.length === 0, '"la utilizará en el proceso" has no trigger word, so zero phrase candidates regardless (sanity check, not a fragmentation-specific assertion)');
}

// ---- unchanged edge cases ----

{
  const c = extractContextCandidates("decidir si se usa la lista");
  assert(
    c.elements.length === 0 && c.attributes.length === 0 && c.camelCase.length === 0 && c.phraseCandidates.length === 0,
    'edge case "decidir si se usa la lista" -> zero candidates of any kind'
  );
}
{
  const c = extractContextCandidates("Data module change/revised ratio");
  assert(
    c.elements.length === 0 && c.attributes.length === 0 && c.camelCase.length === 0 && c.phraseCandidates.length === 0,
    "BRDP-S1-00053's real title (\"Data module change/revised ratio\") -> zero candidates of any kind"
  );
}

// ---- camelCase (min 2 lowercase, then uppercase, min length 5) -- unchanged ----

assert(extractContextCandidates("Confirm proceduralStep numbering is correct.").camelCase.includes("proceduralStep"), "camelCase proceduralStep (long) still captured");
assert(extractContextCandidates("See dmCode for details.").camelCase.includes("dmCode"), "camelCase dmCode (6 chars) captured");
assert(extractContextCandidates("See dmRef for details.").camelCase.includes("dmRef"), "camelCase dmRef (exactly 5 chars, the minimum) captured");
assert(!extractContextCandidates("lA ETIQUETA no lleva nada.").camelCase.includes("lA"), '"lA" (1 lowercase before the uppercase) never captured as camelCase');
assert(!extractContextCandidates("abCd is too short.").camelCase.includes("abCd"), '"abCd" (4 chars, below the length-5 minimum) never captured');
assert(!extractContextCandidates("Confirm this is fine.").camelCase.includes("this"), "a plain lowercase word is never treated as camelCase");

// ---- resolvePhraseCandidates: the ONLY path from a phrase-triggered bare
// word to anything user-visible, and only ever a suggestion, never a
// warning ----

{
  // Same-type match: applicRefId is a real attribute, triggered as an attribute.
  const c = extractContextCandidates("el atributo applicRefId");
  const resolved = resolvePhraseCandidates(c.phraseCandidates, vocab4_2);
  assert(
    resolved.length === 1 && resolved[0].name === "applicRefId" && resolved[0].type === "attribute",
    '"el atributo applicRefId" -> resolved suggestion {name:"applicRefId", type:"attribute"}'
  );
}
{
  // Other-type correction: "table" triggered as an element via "etiqueta" -> stays element (matches).
  const c = extractContextCandidates("la etiqueta table");
  const resolved = resolvePhraseCandidates(c.phraseCandidates, vocab4_2);
  assert(
    resolved.length === 1 && resolved[0].name === "table" && resolved[0].type === "element",
    '"la etiqueta table" -> resolved as element (got: ' + JSON.stringify(resolved) + ")"
  );
}
{
  // Other-type correction: "table" triggered as an ATTRIBUTE but only exists as an element -> corrected type.
  const c = extractContextCandidates("el atributo table");
  const resolved = resolvePhraseCandidates(c.phraseCandidates, vocab4_2);
  assert(
    resolved.length === 1 && resolved[0].name === "table" && resolved[0].type === "element",
    '"el atributo table" -> corrected to type "element" (got: ' + JSON.stringify(resolved) + ")"
  );
}
{
  // Genuinely invented name -> dropped entirely (accepted limitation).
  const c = extractContextCandidates("el elemento pokemon");
  const resolved = resolvePhraseCandidates(c.phraseCandidates, vocab4_2);
  assert(resolved.length === 0, '"el elemento pokemon" -> no suggestion (pokemon does not exist in either vocabulary set)');
}
{
  // The two real reported false positives -- neither "seleccionados" nor
  // "usar" exist in the vocabulary, so both are dropped entirely.
  const c1 = extractContextCandidates("Atributos seleccionados para la etiqueta <stranger>.");
  assert(resolvePhraseCandidates(c1.phraseCandidates, vocab4_2).length === 0, '"Atributos seleccionados..." -> zero suggestions ("seleccionados" is not real vocabulary)');
  const c2 = extractContextCandidates("Decidir qué atributos usar en el elemento <stranger> y cómo usarlos.");
  assert(resolvePhraseCandidates(c2.phraseCandidates, vocab4_2).length === 0, '"...atributos usar...cómo usarlos." -> zero suggestions ("usar"/"cómo" are not real vocabulary)');
}
{
  // "atributos de tipo cl, pl y ip" -- none of cl/pl/ip exist in this
  // vocabulary, so the whole list resolves to zero suggestions.
  const c = extractContextCandidates("atributos de tipo cl, pl y ip");
  assert(resolvePhraseCandidates(c.phraseCandidates, vocab4_2).length === 0, '"atributos de tipo cl, pl y ip" -> zero suggestions when none exist in vocab');
}
{
  // No vocabulary available for this standard -- never guesses.
  const c = extractContextCandidates("el atributo applicRefId");
  assert(resolvePhraseCandidates(c.phraseCandidates, null).length === 0, "resolvePhraseCandidates(..., null) -> always empty, never guesses");
}
{
  // Dedup: the same name appearing twice (e.g. two separate trigger
  // occurrences in the same text) only ever produces one suggestion.
  const c = extractContextCandidates("el atributo applicRefId y también el atributo applicRefId");
  const resolved = resolvePhraseCandidates(c.phraseCandidates, vocab4_2);
  assert(resolved.length === 1, "resolvePhraseCandidates dedupes by name, even across separate trigger occurrences");
}

// ---- applyRenameSuggestion (unchanged) ----

{
  const fixed = applyRenameSuggestion("el elemento pokemon", { name: "pokemon", type: "element" });
  assert(fixed === "el elemento <pokemon>", `applyRenameSuggestion wraps the bare word in <...> (got: ${fixed})`);
}
{
  const fixed = applyRenameSuggestion("el atributo pokemon", { name: "pokemon", type: "attribute" });
  assert(fixed === "el atributo @pokemon", `applyRenameSuggestion wraps the bare word in @... for an attribute (got: ${fixed})`);
}
{
  const fixed = applyRenameSuggestion("nothing here", { name: "pokemon", type: "element" });
  assert(fixed === "nothing here", "applyRenameSuggestion is a no-op when the name can no longer be found bare");
}
{
  // Accented name, sanity check for the 'u' flag added to the lookaround regex.
  const fixed = applyRenameSuggestion("el atributo señal", { name: "señal", type: "attribute" });
  assert(fixed === "el atributo @señal", `applyRenameSuggestion handles accented names too (got: ${fixed})`);
}

// ---- applyRenameSuggestion: incomplete markup (Ask-with-schema-cards
// follow-up round, point 1 -- real report: "Element <table" (an unclosed
// "<" right before the name) made the button do NOTHING, because the old
// regex's negative lookbehind treated any "<" before the name as "already
// marked up" and refused to match there at all -- since the name occurred
// nowhere else in the string, the whole regex found zero matches and
// returned the input completely unchanged. The mirrored case ("table>", a
// dangling ">" with no opening "<") used to match as an ordinary bare word
// and get wrapped AGAIN, producing a doubled bracket ("<table>>"). ----

{
  const fixed = applyRenameSuggestion("Element <table", { name: "table", type: "element" });
  assert(fixed === "Element <table>", `dangling leading "<" is completed, never left as a no-op (got: ${fixed})`);
}
{
  const fixed = applyRenameSuggestion("Element table>", { name: "table", type: "element" });
  assert(fixed === "Element <table>", `dangling trailing ">" is completed, never doubled into "<table>>" (got: ${fixed})`);
}
{
  const fixed = applyRenameSuggestion("Element <table>", { name: "table", type: "element" });
  assert(fixed === "Element <table>", `an already-complete <table> is left untouched (got: ${fixed})`);
}
{
  // A stray extra ">" right after an already-complete tag is not this
  // fix's concern (extractContextCandidates would never offer a
  // suggestion for an already-marked-up name to begin with) -- confirms
  // the fix does not make this pre-existing, out-of-scope edge case worse.
  const fixed = applyRenameSuggestion("Element <table>>", { name: "table", type: "element" });
  assert(fixed === "Element <table>>", `an extra stray ">" after a complete tag is left alone (got: ${fixed})`);
}
{
  // Two occurrences, one broken (dangling "<") and one bare -- the broken
  // one is fixed in place rather than leaving it broken and wrapping the
  // unrelated bare occurrence instead (the old bug's actual behavior).
  const fixed = applyRenameSuggestion("Element <table and table", { name: "table", type: "element" });
  assert(
    fixed === "Element <table> and table",
    `the dangling occurrence is completed first, the unrelated bare one is left alone (got: ${fixed})`
  );
}
{
  // The fix must never produce an empty string or otherwise drop the
  // name -- the real report's own "Element \"\"" symptom, guarded against
  // structurally: every branch either returns the input completely
  // unchanged or a string that still contains the original name.
  for (const text of ["Element <table", "Element table>", "Element <table>", "the element table"]) {
    const fixed = applyRenameSuggestion(text, { name: "table", type: "element" });
    assert(fixed.includes("table"), `applyRenameSuggestion never drops the original name (text=${JSON.stringify(text)}, got: ${JSON.stringify(fixed)})`);
    assert(fixed !== "", `applyRenameSuggestion never produces an empty string (text=${JSON.stringify(text)})`);
  }
}

// ---- checkAgainstVocabulary: phrase-triggered candidates NEVER feed notFound/wrongType ----

const emptyCtx = { elements: [], attributes: [], camelCase: [], phraseCandidates: [] };

{
  const r = checkAgainstVocabulary({ elements: ["pokemon"], attributes: [], camelCase: [] }, vocab4_2);
  assert(r.available === true, "vocabulary marked available when one is supplied");
  assert(r.notFound.includes("<pokemon>"), "explicit context-path <pokemon> -> notFound (unchanged)");
}
{
  const r = checkAgainstVocabulary({ elements: ["topic"], attributes: [], camelCase: [] }, vocab4_2);
  assert(r.notFound.length === 0 && r.wrongType.length === 0, "edge case: <topic> known -> zero warnings of any kind");
}
{
  const r = checkAgainstVocabulary({ elements: ["anything"], attributes: [], camelCase: [] }, null);
  assert(r.available === false && r.notFound.length === 0 && r.wrongType.length === 0, "no vocabulary -> not available, zero false positives");
}
{
  const r = checkAgainstVocabulary({ elements: [], attributes: [], camelCase: ["id", "task"] }, vocab4_2);
  assert(r.notFound.length === 0, "camelCase candidates matched against the union of elements+attributes (unchanged)");
}
{
  const r = checkAgainstVocabulary(emptyCtx, vocab4_2);
  assert(r.available === true && r.notFound.length === 0 && r.wrongType.length === 0, "empty candidates -> available, zero warnings");
}
{
  // The core fix of this round: checkAgainstVocabulary's input shape has
  // no `phraseCandidates` field at all any more -- confirmed structurally,
  // not just by absence of a warning, that there is nothing left in the
  // API for a phrase-derived name to reach notFound through.
  const c = extractContextCandidates("Atributos seleccionados para la etiqueta <stranger>.");
  const r = checkAgainstVocabulary(c, vocab4_2);
  assert(r.notFound.length === 1 && r.notFound[0] === "<stranger>", `real report 1: notFound contains ONLY <stranger> (got: ${JSON.stringify(r.notFound)})`);
  assert(!r.notFound.some((n) => n.includes("seleccionad")), '"seleccionados" never reaches notFound, regardless of the vocabulary supplied');
}
{
  const c = extractContextCandidates("Decidir qué atributos usar en el elemento <stranger> y cómo usarlos.");
  const r = checkAgainstVocabulary(c, vocab4_2);
  assert(r.notFound.length === 1 && r.notFound[0] === "<stranger>", `real report 2: notFound contains ONLY <stranger> (got: ${JSON.stringify(r.notFound)})`);
  assert(!r.notFound.some((n) => n === "usar" || n === "cómo" || n === "c"), '"usar"/"cómo"/"c" never reach notFound');
}
{
  // "atributos de tipo cl, pl y ip" -- none of cl/pl/ip exist in this
  // vocabulary; under this round's rules they are simply ignored, never
  // flagged red (a deliberate change from the previous round, where a
  // phrase-derived bare word DID feed notFound).
  const c = extractContextCandidates("atributos de tipo cl, pl y ip");
  const r = checkAgainstVocabulary(c, vocab4_2);
  assert(r.notFound.length === 0, `"atributos de tipo cl, pl y ip" -> zero notFound warnings now, even though none of cl/pl/ip exist (got: ${JSON.stringify(r.notFound)})`);
}

// Wrong-kind check (explicit markup only) -- unchanged.
{
  const r = checkAgainstVocabulary({ elements: ["label"], attributes: [], camelCase: [] }, vocab4_2);
  assert(r.wrongType.length === 1 && r.wrongType[0].name === "label", "context <label> (used as element) -> wrongType, not merely notFound");
  assert(r.wrongType[0].usedAs === "element" && r.wrongType[0].actualAs === "attribute", "wrongType records usedAs=element, actualAs=attribute for <label>");
  assert(r.notFound.length === 0, "a wrongType name is never ALSO listed as notFound");
}
{
  const r = checkAgainstVocabulary({ elements: [], attributes: ["label"], camelCase: [] }, vocab4_2);
  assert(r.notFound.length === 0 && r.wrongType.length === 0, "edge case: @label (correct kind) -> zero warnings");
}
{
  const vocabReverse = { elements: new Set(["title"]), attributes: new Set([]) };
  const r = checkAgainstVocabulary({ elements: [], attributes: ["title"], camelCase: [] }, vocabReverse);
  assert(r.wrongType.length === 1 && r.wrongType[0].usedAs === "attribute" && r.wrongType[0].actualAs === "element", "reverse direction: @title (used as attribute) -> wrongType, actualAs=element");
}

// formatWrongTypeMessage -- exact sentence shape (unchanged)
{
  const msg = formatWrongTypeMessage("S1000D 4.2", { name: "label", usedAs: "element", actualAs: "attribute" });
  assert(msg === "<label> is not an element in S1000D 4.2 — it exists as attribute @label.", `formatWrongTypeMessage exact wording (got: ${msg})`);
}
{
  const msg = formatWrongTypeMessage("DITA 1.3", { name: "title", usedAs: "attribute", actualAs: "element" });
  assert(msg === "@title is not an attribute in DITA 1.3 — it exists as element <title>.", `formatWrongTypeMessage exact wording, reverse direction (got: ${msg})`);
}

// ---- hashVocabInputText (cache key) -- unchanged ----
{
  const h1 = hashVocabInputText("T", "D", "P");
  const h2 = hashVocabInputText("T", "D", "P");
  const h3 = hashVocabInputText("T", "D", "P2");
  assert(h1 === h2, "same (title, definition, proposal) -> same hash");
  assert(h1 !== h3, "different text -> different hash");
}

// ---- extractSchemaFactCandidates / selectSchemaFactNames (docs request,
// "Servicio de fichas de esquema y su uso en Ask") ----
{
  const r = extractSchemaFactCandidates("What attributes does <table> allow?", vocab4_2);
  assert(r.length === 1 && r[0].name === "table" && r[0].type === "element", `explicit <table> markup -> schema-fact candidate (got: ${JSON.stringify(r)})`);
}
{
  // Encargo's own example: "¿Qué atributos admite el elemento table?" ->
  // phrase-triggered, resolves against the vocabulary -> a real candidate.
  const r = extractSchemaFactCandidates("What attributes does the element table allow?", vocab4_2);
  assert(r.length === 1 && r[0].name === "table" && r[0].type === "element", `phrase-triggered "element table" resolves to a real element -> candidate (got: ${JSON.stringify(r)})`);
}
{
  // Encargo's own counter-example: "¿Qué es esto para el proyecto?" -- "para"
  // is a real S1000D element (as it happens), but it's just an ordinary
  // Spanish preposition here, never marked up nor phrase-triggered -> no
  // candidate at all, even though "para" DOES exist in the vocabulary.
  const vocabWithPara = { elements: new Set(["para", "table"]), attributes: new Set([]) };
  const r = extractSchemaFactCandidates("¿Qué es esto para el proyecto?", vocabWithPara);
  assert(r.length === 0, `bare untriggered "para" (a real element name) never becomes a schema-fact candidate (got: ${JSON.stringify(r)})`);
}
{
  // "note" -- same shape: a real element name used as an ordinary English
  // word ("note that...") must never trigger a card lookup on its own.
  const vocabWithNote = { elements: new Set(["note"]), attributes: new Set([]) };
  const r = extractSchemaFactCandidates("Please note that this decision is provisional.", vocabWithNote);
  assert(r.length === 0, `bare untriggered "note" never becomes a schema-fact candidate (got: ${JSON.stringify(r)})`);
}
{
  // <pokemon> -- doesn't exist in the vocabulary -> no schema-fact
  // candidate (it already has its own red "not found" warning elsewhere;
  // there is nothing real to fetch a card for).
  const r = extractSchemaFactCandidates("Is <pokemon> allowed here?", vocab4_2);
  assert(r.length === 0, `<pokemon> (not in vocabulary) never becomes a schema-fact candidate (got: ${JSON.stringify(r)})`);
}
{
  // "elementos de tipo cl, pl y ip" -- only vocabulary hits become
  // candidates, in the encargo's own worked list example (schema-fact
  // candidates are element-only -- see extractSchemaFactCandidates' own
  // docstring -- so this uses elements, not attributes, unlike the
  // equivalent checkAgainstVocabulary test above).
  const vocabList = { elements: new Set(["cl", "ip"]), attributes: new Set([]) };
  const r = extractSchemaFactCandidates("elementos de tipo cl, pl y ip", vocabList);
  const names = r.map((c) => c.name).sort();
  assert(JSON.stringify(names) === JSON.stringify(["cl", "ip"]), `only the list items that exist in the vocabulary become candidates, never "tipo"/"pl" (got: ${JSON.stringify(names)})`);
}
{
  // "el atributo table" -> exists only as an ELEMENT -> corrected type,
  // same as resolvePhraseCandidates' own wrong-type correction.
  const r = extractSchemaFactCandidates("el atributo table debe existir", vocab4_2);
  assert(r.length === 1 && r[0].name === "table" && r[0].type === "element", `wrong-type-corrected phrase candidate still becomes a real schema-fact candidate with the CORRECTED type (got: ${JSON.stringify(r)})`);
}
{
  const r = extractSchemaFactCandidates("<table> and @conref", null);
  assert(r.length === 0, "extractSchemaFactCandidates(..., null) -> always empty, standard has no vocabulary");
}
{
  // Priority order + max cap + cross-text dedup, the encargo's own wording:
  // "priorizando los de la pregunta y luego los del Title".
  const vocabMulti = { elements: new Set(["a", "b", "c", "d", "e", "f", "g"]), attributes: new Set([]) };
  const question = "Is <a> related to <b>?";
  const title = "About <b> and <c> and <d>";
  const definition = "See <e> and <f> and <g>";
  const selected = selectSchemaFactNames([question, title, definition], vocabMulti, 6);
  const names = selected.map((c) => c.name);
  assert(names.length === 6, `caps at max (6), got ${names.length}: ${JSON.stringify(names)}`);
  assert(names[0] === "a" && names[1] === "b", `question's own candidates come first (got: ${JSON.stringify(names)})`);
  assert(names.indexOf("b") < names.indexOf("c"), "question's <b> is not duplicated when Title mentions it again -- kept at its higher (question) priority position");
  assert(JSON.stringify(names.slice(2, 4)) === JSON.stringify(["c", "d"]), `Title's own candidates fill in next, before Definition's (got: ${JSON.stringify(names)})`);
  assert(JSON.stringify(names.slice(4)) === JSON.stringify(["e", "f"]), `Definition's candidates fill the remaining slots up to the cap, "g" left out (got: ${JSON.stringify(names)})`);
}
{
  const r = selectSchemaFactNames(["no xml names here at all"], vocab4_2, 6);
  assert(r.length === 0, "selectSchemaFactNames on plain prose with no names -> empty, never guesses");
}
{
  const r = selectSchemaFactNames(["<table>"], null, 6);
  assert(r.length === 0, "selectSchemaFactNames(..., null) -> always empty");
}

// ---- summarizeSchemaFactEntry: compact common/variant-diff format
// (Ask-with-schema-cards follow-up round, point 4) -- against the REAL
// S1000D 4.2 <para> card the encargo itself names ("la ficha de <para>
// tiene 8 variantes"), loaded straight from
// backend/schema_cards/schema-cards-4-2.json (the generator's own raw
// output, no running backend needed) rather than a hand-built fixture, so
// this proves the real, exact reduction: 8 schema-file variants collapse
// to one shared attribute/children list plus a short per-schema diff. The
// raw generator file's `cards.para` array is the same per-variant shape
// GET /api/schema-cards' `variants` uses, minus the compaction
// (attributes_truncated/etc.) flags the backend route adds on top --
// added here as false/0 (this card is well under the compaction limits:
// 11 attributes, at most 28 children, both < the 30/40 caps), matching
// exactly what the real endpoint served (verified live against the
// running backend during this round). ----
{
  const raw = JSON.parse(readFileSync(join(__dirname, "..", "backend", "schema_cards", "schema-cards-4-2.json"), "utf-8"));
  const rawVariants = raw.cards.para;
  assert(rawVariants.length === 8, `real S1000D 4.2 <para> card has 8 variants, matching the encargo's own count (got: ${rawVariants.length})`);

  const entry = {
    variants: rawVariants.map((v) => ({
      schemas: v.schemas,
      resolved: v.resolved,
      attributes: v.attributes.map((a) => ({ ...a, enum_truncated: false, enum_omitted: 0 })),
      attributes_truncated: false,
      attributes_omitted: 0,
      children: v.children,
      children_truncated: false,
      children_omitted: 0,
    })),
    parents: raw.parents.para || [],
    parents_truncated: false,
    parents_omitted: 0,
  };

  const summary = summarizeSchemaFactEntry(entry);
  assert(summary.common !== null, "an 8-variant entry produces a non-null common section");
  assert(!summary.anyUnresolved, "the real <para> card has no unresolved variant");

  const commonAttrNames = summary.common.attributes.map((a) => a.name).sort();
  const allAttrNamesEverywhere = new Set(rawVariants.flatMap((v) => v.attributes.map((a) => a.name)));
  assert(
    commonAttrNames.length === allAttrNamesEverywhere.size,
    `all 11 real <para> attributes are identical (name+required+enum) across all 8 schemas, so all 11 land in the common set, none left as a per-variant diff (got ${commonAttrNames.length} of ${allAttrNamesEverywhere.size})`
  );
  for (const pv of summary.perVariant) {
    assert(pv.diffAttributes.length === 0, `no schema variant has an attribute difference for real <para> (schemas=${pv.schemas.join(",")})`);
  }

  // Every child in the common set must genuinely appear in EVERY real
  // variant's own children list -- not just the first one.
  for (const childName of summary.common.children) {
    for (const v of rawVariants) {
      assert(v.children.includes(childName), `common child "${childName}" is missing from a real variant (schemas=${v.schemas.join(",")}) -- common set is not truly common`);
    }
  }
  // And nothing left in a per-variant diff list may ALSO be in the common
  // set (the whole point of the split -- never repeat a fact twice).
  for (const pv of summary.perVariant) {
    for (const childName of pv.diffChildren) {
      assert(
        !summary.common.children.includes(childName),
        `per-variant diff child "${childName}" (schemas=${pv.schemas.join(",")}) is never also repeated in the common set`
      );
    }
  }
  // The real, hand-confirmed reduction for this exact card (verified live
  // against the running backend during this round): 17 children common to
  // all 8 variants, with "footnote" a genuine per-variant difference --
  // present in the "crew" variant's own children, but absent from the
  // "comrep,frontmatter,ipd,schedul,update" group's, so it correctly
  // cannot land in the common set either.
  assert(summary.common.children.length === 17, `real <para> has exactly 17 children common to all 8 variants (got: ${summary.common.children.length})`);
  const crewGroup = summary.perVariant.find((pv) => pv.schemas.includes("crew"));
  assert(!!crewGroup && crewGroup.diffChildren.includes("footnote"), `"footnote" is a real per-variant difference for the "crew" variant (got: ${JSON.stringify(crewGroup?.diffChildren)})`);
  const comrepGroup = summary.perVariant.find((pv) => pv.schemas.includes("comrep"));
  assert(!!comrepGroup && !comrepGroup.diffChildren.includes("footnote"), `"footnote" is absent from the comrep/frontmatter/ipd/schedul/update group's own children too, so it is not a difference there (got: ${JSON.stringify(comrepGroup?.diffChildren)})`);
  assert(!summary.common.children.includes("footnote"), `"footnote" is NOT common to all 8 variants (it is genuinely absent from some) (got common list: ${JSON.stringify(summary.common.children)})`);

  // parents are already NOT per-variant in the real data -- summarize
  // must never attempt to diff them; the caller renders entry.parents
  // once, unconditionally (confirmed by re-reading buildSchemaFactsBlock/
  // SchemaFactCard, which never touch summary for parents at all).
  assert(Array.isArray(entry.parents) && entry.parents.length > 0, "real <para> has a real, non-empty parents list (used as-is, never diffed per variant)");
}
{
  // Single-variant entry (the overwhelmingly common case) -> common: null,
  // so callers fall back to the old simple per-variant rendering.
  const entry = {
    variants: [
      {
        schemas: ["s1"],
        resolved: true,
        attributes: [{ name: "id", required: true, enum: null, enum_truncated: false, enum_omitted: 0 }],
        attributes_truncated: false,
        attributes_omitted: 0,
        children: ["child1"],
        children_truncated: false,
        children_omitted: 0,
      },
    ],
    parents: ["parent1"],
    parents_truncated: false,
    parents_omitted: 0,
  };
  const summary = summarizeSchemaFactEntry(entry);
  assert(summary.common === null, "a single-variant entry never produces a common/diff split (common: null)");
}

console.log(failures === 0 ? "\nALL CHECKS PASSED\n" : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
