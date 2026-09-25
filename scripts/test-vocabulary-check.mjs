// Docs request (Suggest Proposal round, "comprobación de vocabulario contra
// el esquema") -- closeout requires "tests del extractor por contexto, del
// parseo del JSON del LLM (incluido JSON inválido) y de la comparación".
// This repo has no JS test runner (documented in CLAUDE.md) -- same
// convention already used by test-schematron-dita.mjs/test-schematron-
// dita-lets.mjs: import the REAL production module directly under plain
// Node and assert against it, not a mock or a duplicated copy.
//
//     node scripts/test-vocabulary-check.mjs
import {
  extractContextCandidates,
  checkAgainstVocabulary,
  mergeCandidates,
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

// @... -> attribute
assert(
  extractContextCandidates("Use @conref to reference content.").attributes.includes("conref"),
  "@conref extracted as attribute"
);

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
    !c.elements.includes("pokemon") && !c.attributes.includes("pokemon") && !c.ambiguous.includes("pokemon"),
    'edge case "el pokemon ese que va dentro del step" -> no context-only match (needs the LLM path)'
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

// ---- 3.4 comparison against a real-shaped vocabulary ----

const vocab = { elements: new Set(["topic", "task", "machineryTask"]), attributes: new Set(["id", "conref"]) };

{
  const r = checkAgainstVocabulary({ elements: ["topic", "pokemon"], attributes: [], ambiguous: [] }, vocab);
  assert(r.available === true, "vocabulary marked available when one is supplied");
  assert(
    r.unknownNames.includes("<pokemon>") && !r.unknownNames.some((n) => n.includes("topic")),
    "known element (topic) passes silently, unknown one (pokemon) flagged as <pokemon>"
  );
}
{
  // docs edge case: <topic> in DITA -> no warning
  const r = checkAgainstVocabulary({ elements: ["topic"], attributes: [], ambiguous: [] }, vocab);
  assert(r.unknownNames.length === 0, "edge case: <topic> in DITA -> zero warnings");
}
{
  // no vocabulary at all (standard without a generated file) -> "not available", never a false positive
  const r = checkAgainstVocabulary({ elements: ["anything"], attributes: [], ambiguous: [] }, null);
  assert(r.available === false && r.unknownNames.length === 0, "no vocabulary -> not available, zero false positives");
}
{
  // dedup across buckets: same name from both an element-context match AND the ambiguous bucket
  const r = checkAgainstVocabulary({ elements: ["pokemon"], attributes: [], ambiguous: ["pokemon"] }, vocab);
  assert(r.unknownNames.length === 1 && r.unknownNames[0] === "<pokemon>", "cross-bucket dedup keeps the more specific <x> form, only once");
}
{
  // ambiguous bucket checked against the UNION of elements+attributes
  const r = checkAgainstVocabulary({ elements: [], attributes: [], ambiguous: ["id", "task"] }, vocab);
  assert(r.unknownNames.length === 0, "ambiguous candidates matched against the union of elements+attributes");
}

// ---- mergeCandidates ----
{
  const merged = mergeCandidates(
    { elements: ["a"], attributes: ["b"], ambiguous: ["c"] },
    { elements: ["a", "d"], attributes: [] }
  );
  assert(merged.elements.slice().sort().join(",") === "a,d", "mergeCandidates unions elements without duplicates");
  assert(merged.attributes.join(",") === "b", "mergeCandidates keeps context attributes when the LLM found none");
  assert(merged.ambiguous.join(",") === "c", "mergeCandidates carries the ambiguous bucket through unchanged");
}
{
  const merged = mergeCandidates({ elements: [], attributes: [], ambiguous: [] }, null);
  assert(merged.elements.length === 0 && merged.attributes.length === 0, "mergeCandidates tolerates a null llmCandidates (unavailable path)");
}

// ---- hashVocabInputText (cache key) ----
{
  const h1 = hashVocabInputText("T", "D", "P");
  const h2 = hashVocabInputText("T", "D", "P");
  const h3 = hashVocabInputText("T", "D", "P2");
  assert(h1 === h2, "same (title, definition, proposal) -> same hash (one extraction call, not two)");
  assert(h1 !== h3, "different text -> different hash");
}

// ---- extraction prompt never leaks the real vocabulary ----
{
  const prompt = buildVocabExtractionPrompt();
  assert(!/topic|conref|machineryTask/i.test(prompt), "extraction prompt never mentions any real vocabulary name");
  assert(/do not judge/i.test(prompt), "extraction prompt explicitly forbids judging existence");
}

console.log(failures === 0 ? "\nALL CHECKS PASSED\n" : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
