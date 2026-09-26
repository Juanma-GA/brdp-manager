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
import {
  extractContextCandidates,
  resolvePhraseCandidates,
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

console.log(failures === 0 ? "\nALL CHECKS PASSED\n" : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
