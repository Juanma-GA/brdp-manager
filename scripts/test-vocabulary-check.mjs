// Docs request (Suggest Proposal round, "comprobación de vocabulario contra
// el esquema") -- closeout requires "tests del extractor por contexto, del
// parseo del JSON del LLM (incluido JSON inválido) y de la comparación".
// Extended by the real-Mistral follow-up round ("falsos positivos del
// extractor LLM y aviso de tipo equivocado") -- closeout requires "tests
// del filtro (solo afecta a la vía LLM), del aviso de tipo equivocado y
// del parseo con los ejemplos anteriores".
// This repo has no JS test runner (documented in CLAUDE.md) -- same
// convention already used by test-schematron-dita.mjs/test-schematron-
// dita-lets.mjs: import the REAL production module directly under plain
// Node and assert against it, not a mock or a duplicated copy.
//
//     node scripts/test-vocabulary-check.mjs
import {
  extractContextCandidates,
  checkAgainstVocabulary,
  isStopword,
  filterLLMStopwords,
  formatWrongTypeMessage,
  parseVocabExtractionResponse,
  hashVocabInputText,
  buildVocabExtractionPrompt,
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

// ---- 3.3(a) context extractor ----

// <...> -> element
assert(
  extractContextCandidates("The element <pokemon> will not be used.").elements.includes("pokemon"),
  "<pokemon> extracted as element"
);
assert(
  extractContextCandidates("</pokemon> closes the tag.").elements.includes("pokemon"),
  "closing tag </pokemon> also extracted as element (slash excluded from the name)"
);
// follow-up round's own edge case: an explicit tag spelled like a
// stopword must still be extracted by the context path -- the filter
// below never touches this path.
assert(extractContextCandidates("Do not use <del> here.").elements.includes("del"), "<del> written explicitly is still extracted by the context path");

// @... -> attribute
assert(
  extractContextCandidates("Use @conref to reference content.").attributes.includes("conref"),
  "@conref extracted as attribute"
);
assert(extractContextCandidates("Use @label for this.").attributes.includes("label"), "@label extracted as attribute");

// docs request's own edge case: "atributos del elemento pokemon" (no <>) -> pokemon
{
  const c = extractContextCandidates("atributos del elemento pokemon");
  assert(c.ambiguous.includes("pokemon"), 'edge case "atributos del elemento pokemon" -> pokemon flagged');
  assert(
    !c.ambiguous.includes("elemento") && !c.ambiguous.includes("atributos") && !c.ambiguous.includes("del"),
    "trigger/connector words themselves never become candidates"
  );
}

// English equivalent + connector skipping
assert(
  extractContextCandidates("the attribute of the element pokemon").ambiguous.includes("pokemon"),
  '"the attribute of the element pokemon" -> pokemon (connectors "of"/"the" skipped)'
);

// docs request's own edge case: "el pokemon ese que va dentro del step" -> NOTHING from (a) alone
{
  const c = extractContextCandidates("el pokemon ese que va dentro del step");
  assert(
    c.elements.length === 0 && c.attributes.length === 0 && c.ambiguous.length === 0,
    'edge case "el pokemon ese que va dentro del step" -> zero context-path candidates (needs the LLM path)'
  );
}

// docs request's own edge case: "decidir si se usa la lista" -> no warning at all
{
  const c = extractContextCandidates("decidir si se usa la lista");
  assert(
    c.elements.length === 0 && c.attributes.length === 0 && c.ambiguous.length === 0,
    'edge case "decidir si se usa la lista" -> zero candidates'
  );
}

// lower-camelCase
assert(
  extractContextCandidates("Confirm proceduralStep numbering is correct.").ambiguous.includes("proceduralStep"),
  "camelCase proceduralStep captured as ambiguous"
);
assert(
  !extractContextCandidates("Confirm this is fine.").ambiguous.includes("this"),
  "a plain lowercase word (no inner uppercase) is never treated as camelCase"
);

// ---- 3.3(b) LLM JSON parsing ----

{
  const p = parseVocabExtractionResponse(JSON.stringify({ elements: ["pokemon"], attributes: [] }));
  assert(p && p.elements.length === 1 && p.elements[0] === "pokemon", "parses valid JSON");
}
{
  const p = parseVocabExtractionResponse(
    "```json\n" + JSON.stringify({ elements: [], attributes: ["conref"] }) + "\n```"
  );
  assert(p && p.attributes[0] === "conref", "parses JSON wrapped in a markdown code fence");
}
assert(parseVocabExtractionResponse("not json at all") === null, "invalid JSON -> null (never throws)");
assert(parseVocabExtractionResponse(JSON.stringify({ foo: "bar" })) === null, "wrong shape (missing keys) -> null");
assert(parseVocabExtractionResponse(JSON.stringify(["a", "b"])) === null, "a JSON array (not an object) -> null");
assert(parseVocabExtractionResponse(null) === null, "non-string input -> null");
assert(parseVocabExtractionResponse(undefined) === null, "undefined input -> null");

// The follow-up encargo's 3 worked examples for the prompt -- confirms the
// SHAPE each one is meant to parse into (the model's actual judgment on
// them can only be checked against the real provider, documented in the
// closeout; this only proves parseVocabExtractionResponse handles them).
{
  const p1 = parseVocabExtractionResponse(JSON.stringify({ elements: ["pokemon", "step"], attributes: [] }));
  assert(p1.elements.join(",") === "pokemon,step" && p1.attributes.length === 0, 'example 1 shape: "el pokemon ese que va dentro del step" -> {elements:[pokemon,step]}');
}
{
  const p2 = parseVocabExtractionResponse(JSON.stringify({ elements: [], attributes: [] }));
  assert(p2.elements.length === 0 && p2.attributes.length === 0, 'example 2 shape: "Decidir si se usa la lista numerada" -> {}');
}
{
  const p3 = parseVocabExtractionResponse(JSON.stringify({ elements: [], attributes: ["emphasisType"] }));
  assert(p3.elements.length === 0 && p3.attributes.join(",") === "emphasisType", 'example 3 shape: attribute-only extraction ("emphasisType") with no spurious "text" element');
}

// ---- point 2: deterministic stopword filter (LLM path only) ----

assert(isStopword("del") && isStopword("EL") && isStopword("que") && isStopword("va") && isStopword("dentro") && isStopword("ese"), "Spanish stopwords recognized case-insensitively");
assert(isStopword("the") && isStopword("of") && isStopword("is"), "English stopwords recognized");
assert(!isStopword("pokemon") && !isStopword("step") && !isStopword("label") && !isStopword("proceduralStep"), "real candidate words are never stopwords");

{
  // The exact worst-case real-Mistral report: nearly every word of the
  // ambiguous phrase came back as an "element". The filter must reduce
  // this to just the two genuine candidates.
  const filtered = filterLLMStopwords({ elements: ["del", "dentro", "el", "ese", "pokemon", "que", "step", "va"], attributes: [] });
  assert(filtered.elements.slice().sort().join(",") === "pokemon,step", "filterLLMStopwords strips all 6 stopwords from the real-Mistral over-extraction report, keeping only pokemon/step");
}
{
  const filtered = filterLLMStopwords({ elements: [], attributes: ["the", "conref", "a"] });
  assert(filtered.attributes.join(",") === "conref", "filterLLMStopwords also filters the attributes bucket");
}
assert(filterLLMStopwords(null) === null, "filterLLMStopwords tolerates null (unavailable path)");

// ---- 3.4 comparison: confidence split + wrong-kind (follow-up round) ----

const vocab4_2 = { elements: new Set(["topic", "task", "machineryTask", "step"]), attributes: new Set(["id", "conref", "label"]) };
const emptyCtx = { elements: [], attributes: [], ambiguous: [] };

{
  // context/explicit markup -> high confidence, "notFound"
  const r = checkAgainstVocabulary({ elements: ["pokemon"], attributes: [], ambiguous: [] }, null, vocab4_2);
  assert(r.available === true, "vocabulary marked available when one is supplied");
  assert(r.notFound.includes("<pokemon>") && r.possiblyNotFound.length === 0, "context-path <pokemon> -> notFound (high confidence), never possiblyNotFound");
}
{
  // LLM-only -> low confidence, "possiblyNotFound"
  const r = checkAgainstVocabulary(emptyCtx, { elements: ["pokemon"], attributes: [], unavailable: false }, vocab4_2);
  assert(r.possiblyNotFound.includes("<pokemon>") && r.notFound.length === 0, "LLM-only pokemon -> possiblyNotFound (low confidence), never notFound");
}
{
  // found via BOTH context and LLM -> still high confidence (context wins)
  const r = checkAgainstVocabulary({ elements: ["pokemon"], attributes: [], ambiguous: [] }, { elements: ["pokemon"], attributes: [], unavailable: false }, vocab4_2);
  assert(r.notFound.includes("<pokemon>") && r.possiblyNotFound.length === 0, "name found via both paths -> high confidence (context/explicit outranks LLM-only)");
}
{
  // docs edge case: <topic> known -> no warning
  const r = checkAgainstVocabulary({ elements: ["topic"], attributes: [], ambiguous: [] }, null, vocab4_2);
  assert(r.notFound.length === 0 && r.possiblyNotFound.length === 0 && r.wrongType.length === 0, "edge case: <topic> known -> zero warnings of any kind");
}
{
  // no vocabulary at all -> "not available", never a false positive
  const r = checkAgainstVocabulary({ elements: ["anything"], attributes: [], ambiguous: [] }, null, null);
  assert(r.available === false && r.notFound.length === 0 && r.possiblyNotFound.length === 0 && r.wrongType.length === 0, "no vocabulary -> not available, zero false positives of any kind");
}
{
  // ambiguous bucket checked against the UNION of elements+attributes
  const r = checkAgainstVocabulary({ elements: [], attributes: [], ambiguous: ["id", "task"] }, null, vocab4_2);
  assert(r.notFound.length === 0, "ambiguous candidates matched against the union of elements+attributes");
}

// Point 4: wrong-kind check, with real S1000D 4.2 shape (label is an
// attribute only) -- the encargo's own <label> edge case.
{
  const r = checkAgainstVocabulary({ elements: ["label"], attributes: [], ambiguous: [] }, null, vocab4_2);
  assert(r.wrongType.length === 1 && r.wrongType[0].name === "label", "context <label> (used as element) -> wrongType, not merely notFound");
  assert(r.wrongType[0].usedAs === "element" && r.wrongType[0].actualAs === "attribute", "wrongType records usedAs=element, actualAs=attribute for <label>");
  assert(r.notFound.length === 0 && r.possiblyNotFound.length === 0, "a wrongType name is never ALSO listed as notFound/possiblyNotFound");
}
{
  // edge case: @label -> no warning at all (used correctly as an attribute)
  const r = checkAgainstVocabulary({ elements: [], attributes: ["label"], ambiguous: [] }, null, vocab4_2);
  assert(r.notFound.length === 0 && r.possiblyNotFound.length === 0 && r.wrongType.length === 0, "edge case: @label (correct kind) -> zero warnings");
}
{
  // reverse direction: attribute-only vocab entry used as an attribute
  // that's actually an element -- sanity check both directions work
  const vocabReverse = { elements: new Set(["title"]), attributes: new Set([]) };
  const r = checkAgainstVocabulary({ elements: [], attributes: ["title"], ambiguous: [] }, null, vocabReverse);
  assert(r.wrongType.length === 1 && r.wrongType[0].usedAs === "attribute" && r.wrongType[0].actualAs === "element", "reverse direction: @title (used as attribute) -> wrongType, actualAs=element");
}
{
  // wrong-kind detection also applies to the LLM path's typed buckets
  const r = checkAgainstVocabulary(emptyCtx, { elements: ["label"], attributes: [], unavailable: false }, vocab4_2);
  assert(r.wrongType.length === 1 && r.wrongType[0].name === "label", "LLM-path element also gets wrong-kind checked, not just context path");
}

// formatWrongTypeMessage -- exact sentence shape
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

// End-to-end: the exact real-Mistral over-extraction report, filtered,
// then checked -- confirms only pokemon/step survive as (low-confidence)
// warnings, with none of the 6 stopwords appearing anywhere.
{
  const rawLLM = { elements: ["del", "dentro", "el", "ese", "pokemon", "que", "step", "va"], attributes: [], unavailable: false };
  const filtered = { ...rawLLM, elements: filterLLMStopwords(rawLLM).elements };
  const r = checkAgainstVocabulary(emptyCtx, filtered, vocab4_2);
  assert(r.possiblyNotFound.join(",") === "<pokemon>", "end-to-end: only pokemon survives as possiblyNotFound (step IS in this vocab)");
  assert(r.notFound.length === 0 && r.wrongType.length === 0, "end-to-end: no stopword ever reaches notFound/wrongType");
}

// ---- hashVocabInputText (cache key) ----
{
  const h1 = hashVocabInputText("T", "D", "P");
  const h2 = hashVocabInputText("T", "D", "P");
  const h3 = hashVocabInputText("T", "D", "P2");
  assert(h1 === h2, "same (title, definition, proposal) -> same hash (one extraction call, not two)");
  assert(h1 !== h3, "different text -> different hash");
}

// ---- extraction prompt: never leaks real vocabulary, carries the 3 examples ----
{
  const prompt = buildVocabExtractionPrompt();
  assert(!/topic|conref|machineryTask/i.test(prompt), "extraction prompt never mentions any real vocabulary name");
  assert(/do not judge/i.test(prompt), "extraction prompt explicitly forbids judging existence");
  assert(prompt.includes('"el pokemon ese que va dentro del step" -> {"elements": ["pokemon", "step"], "attributes": []}'), "prompt carries worked example 1 verbatim");
  assert(prompt.includes('"Decidir si se usa la lista numerada" -> {"elements": [], "attributes": []}'), "prompt carries worked example 2 verbatim");
  assert(
    prompt.includes('"Use of the attribute emphasisType in the text element" -> {"elements": [], "attributes": ["emphasisType"]}'),
    "prompt carries worked example 3 verbatim (the generic-noun trap)"
  );
  assert(/Articles, pronouns, prepositions/.test(prompt), "prompt carries the explicit negative instruction");
}

console.log(failures === 0 ? "\nALL CHECKS PASSED\n" : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
