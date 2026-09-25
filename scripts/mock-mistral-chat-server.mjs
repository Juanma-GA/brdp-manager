// Ad hoc, throwaway local mock of Mistral's chat-completions endpoint --
// same "mock only the Mistral HTTP transport" convention as
// mock-mistral-embed-server.mjs (which already mocks the embeddings
// endpoint for imports), applied here to Ask a Question. Needed because
// this sandbox's outbound network cannot reach api.mistral.ai at all --
// confirmed via the real backend log, which shows the agent proxy itself
// rejecting the request with a 403, before it even gets to the "invalid
// API key" question:
//   httpcore.ProxyError: 403 Forbidden
// So this isn't a stand-in for a missing/invalid key -- the real provider
// is categorically unreachable from here, same class of sandbox
// limitation CLAUDE.md already documents elsewhere (Navantia SOPTE scale,
// production-only data, etc.), not an app bug.
//
// GET /last-request exposes the most recently received request body
// (model/messages/system as actually built by buildRequestBody in
// llmAPI.js) so a verification script can assert on the EXACT system
// prompt and message array the app sent -- not just that some request was
// sent -- which is the real thing this docs request needs verified (BRDP
// scoping, one-turn chaining, the compare block).
import http from "node:http";

const PORT = 8902;
let lastRequest = null;

function isOffTopic(text) {
  return /what'?s the weather|qué tiempo hace|weather like/i.test(text || "");
}

// Two deterministic triggers, checked by the verify script for markdown
// rendering and for the "raw HTML in the answer must render as literal
// text, never be interpreted" edge case (same principle as the Generate
// Report HTML-injection fix, commit 90b7e12).
function isMarkdownTest(text) {
  return /MARKDOWN_TEST/.test(text || "");
}
function isHtmlTest(text) {
  return /HTML_TEST/.test(text || "");
}

// Suggest Definition always sends this exact fixed user message (docs
// request round: language/wrap/dedup) -- used here, not a trigger phrase
// inside it (there's no room for one), to return a deliberately LONG,
// unbroken reply so a verification script can confirm the suggestion box
// actually wraps it instead of cutting it off at the panel's right edge.
function isSuggestDefinition(text) {
  return text === "Write the Definition for this BRDP.";
}

// Suggest Rule (proposal/rule kind, unchanged path -- requestSuggestion's
// generic prompt) -- returns a deliberately LONG, unbroken XML line so a
// verification script can confirm the suggestion box's Rule/XML rendering
// (.suggestionCode) keeps its own horizontal scrollbar instead of
// overflowing the panel, same round as the Definition wrap fix above.
function isSuggestRule(text) {
  return /Suggest a Suggest Rule for BRDP/.test(text || "");
}

// "Suggest: clear state on BRDP change" round (docs request): opt-in
// per-call delay, armed via POST /slow-next (disarms itself after being
// consumed once) so a verification script has a real window to switch to
// a different BRDP row (or back again) BEFORE a Suggest request resolves
// -- exercising the stale-response-discard path for real instead of
// relying on timing luck. Not tied to any particular BRDP's content
// (Suggest Definition's user message is always the same fixed string
// regardless of which BRDP it's for), so a flag armed/consumed per call
// is simpler and more reliable than a content marker here.
const SLOW_RESPONSE_DELAY_MS = 2500;
let slowNextArmed = false;
// "Aviso ligado al texto" round: content-independent trigger, armed via
// POST /step-next (one-shot, same convention as /slow-next/-error-next
// above) -- Suggest Definition/Rule's own fixed messages already own a
// dedicated reply (long-text-wrap / long-XML tests, never touched here),
// and Suggest Proposal's fixed user message ("Write the Proposal for this
// BRDP.") carries no room for a content marker either, so this is the
// only way to make ONE Suggest Proposal call return a specific, real
// `<step>`-bearing reply on demand -- needed to actually ACCEPT that text
// into a BRDP's Proposal and observe the vocabulary notice react. Applies
// to whichever call comes next regardless of its own content, exactly
// like /slow-next/-error-next; unarmed, Suggest Proposal keeps its
// existing generic "MOCK-ANSWER: ..." fallback reply unchanged.
let stepNextArmed = false;
// "Suggest: la sugerencia se queda en su BRDP" round (docs request):
// content-independent error trigger, armed via POST /error-next
// (one-shot, like /slow-next). ERROR_TEST above only fires if the
// literal marker ends up inside a user message, but Suggest Definition's
// user message is always the same fixed string regardless of BRDP -- no
// content to embed a marker into -- and Suggest Proposal/Rule's own
// message only forms at all once /similar reports sufficient precedent,
// which the encargo's error-entry edge case doesn't need to set up. This
// flag forces the NEXT call to fail regardless of its content.
let errorNextArmed = false;

// Schema vocabulary check round (docs request, 3.3(b)), extended by the
// real-Mistral follow-up round: the extraction call's own system prompt
// (buildVocabExtractionPrompt() in vocabularyCheck.js) is distinctive
// enough to detect and branch on -- unlike Ask/Suggest, whose triggers
// key off the user message, this one keys off the SYSTEM prompt, since
// the extraction call's user message is always "Title: ...\nDefinition:
// ...\nProposal: ..." regardless of which BRDP or app action triggered
// it. A deterministic stand-in for a real LLM's extraction -- see the
// three branches inline below (over-extraction phrase / "label" wrong-
// kind / plain "pokemon") -- exercises the SAME code path a real model
// would (JSON out, no vocabulary given, no existence judgment) without
// depending on real language understanding. GET /extraction-calls
// exposes a count separate from the main /calls-equivalent (there isn't
// one on this mock) so a verification script can assert "N genuinely
// separate extraction calls happened" -- e.g. confirming the "mismo
// texto dos veces -> una sola llamada" caching case for real.
let extractionCallCount = 0;
function isVocabExtractionSystemPrompt(systemPrompt) {
  return /You extract candidate XML element and attribute names/.test(systemPrompt || "");
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/last-request") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(lastRequest));
    return;
  }
  if (req.method === "POST" && req.url === "/reset") {
    lastRequest = null;
    slowNextArmed = false;
    errorNextArmed = false;
    stepNextArmed = false;
    extractionCallCount = 0;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method === "GET" && req.url === "/extraction-calls") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ count: extractionCallCount }));
    return;
  }
  if (req.method === "POST" && req.url === "/slow-next") {
    slowNextArmed = true;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, delayMs: SLOW_RESPONSE_DELAY_MS }));
    return;
  }
  if (req.method === "POST" && req.url === "/error-next") {
    errorNextArmed = true;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method === "POST" && req.url === "/step-next") {
    stepNextArmed = true;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400);
      res.end("bad json");
      return;
    }
    lastRequest = parsed;
    const messages = parsed.messages || [];
    const systemPrompt = messages.find((m) => m.role === "system")?.content || "";
    const nonSystem = messages.filter((m) => m.role !== "system");
    const lastUser = [...nonSystem].reverse().find((m) => m.role === "user");
    const userText = lastUser?.content || "";
    const hasPriorTurn = nonSystem.length > 1; // prev user+assistant, plus the new question

    // Schema vocabulary check round: the extraction call, detected by its
    // own distinctive system prompt -- handled before ERROR_TEST/
    // errorNextArmed below so /error-next (armed before an Ask/Suggest
    // click) fails THIS call first, exactly the "la llamada de
    // extracción falla" edge case a verification script needs to exercise.
    if (isVocabExtractionSystemPrompt(systemPrompt)) {
      extractionCallCount += 1;
      if (/ERROR_TEST/.test(userText) || errorNextArmed) {
        errorNextArmed = false; // one-shot, same as the main-call path below
        console.log(`extraction call #${extractionCallCount} -- simulated failure`);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "simulated extraction failure" }));
        return;
      }
      // Real-Mistral follow-up round ("falsos positivos del extractor LLM
      // y aviso de tipo equivocado"): three deterministic branches, most
      // specific first.
      //   1. The exact ambiguous phrase from the encargo's own edge case
      //      -- simulates the WORST-CASE real-Mistral behavior reported
      //      by the user (every word, including Spanish stopwords,
      //      treated as a candidate) so a verification script can prove
      //      the client-side stopword filter (filterLLMStopwords) reduces
      //      this to just "pokemon"/"step" regardless of what the model
      //      itself returns -- the filter is the real defense, not the
      //      prompt wording, which this mock deliberately does NOT model
      //      well (a real model's improved-prompt behavior can only be
      //      judged by the user against the real provider).
      //   2. "label" -- S1000D 4.2's real generated vocabulary has
      //      "label" as an attribute only (confirmed by grepping schema-
      //      vocabulary-4-2.json), never as an element -- reported as an
      //      element candidate here to exercise the wrong-kind check for
      //      real, with real vocabulary data, not a synthetic fixture.
      //   3. otherwise, the original "pokemon" substring check.
      let elements = [];
      const attributes = [];
      if (/el pokemon ese que va dentro del step/i.test(userText)) {
        elements = ["del", "dentro", "el", "ese", "pokemon", "que", "step", "va"];
      } else if (/\blabel\b/i.test(userText)) {
        elements = ["label"];
      } else if (/pokemon/i.test(userText)) {
        elements = ["pokemon"];
      }
      const body = JSON.stringify({ elements, attributes });
      console.log(`extraction call #${extractionCallCount} -- elements=${JSON.stringify(elements)}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: body } }] }));
      return;
    }

    // Deterministic failure trigger -- exercises askGeneric's catch branch
    // (the real network-failure path) without relying on a flaky real
    // network condition.
    if (/ERROR_TEST/.test(userText)) {
      console.log("chat call -- simulated 500 (ERROR_TEST)");
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "simulated failure for ERROR_TEST" }));
      return;
    }
    if (errorNextArmed) {
      errorNextArmed = false; // one-shot
      console.log("chat call -- simulated 500 (armed via /error-next)");
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "simulated failure (armed via /error-next)" }));
      return;
    }

    let reply;
    if (stepNextArmed) {
      stepNextArmed = false; // one-shot -- doesn't affect the next unrelated call
      reply = "MOCK-STEP-PROPOSAL: The <step> [YES/NO] be used.";
    } else if (isOffTopic(userText)) {
      reply =
        "MOCK-OFFTOPIC: That question is not about this BRDP. Please select the correct BRDP, or rephrase your question so it's about this one.";
    } else if (isMarkdownTest(userText)) {
      reply =
        "**MOCK-MARKDOWN** answer with real structure:\n\n" +
        "- First point about `allowedObjectFlag`\n" +
        "- Second point, *emphasized*\n\n" +
        "Use `objectPath` for the context.";
    } else if (isHtmlTest(userText)) {
      reply = "MOCK-HTML-TEST: the element <table> and the tag <originator> must render as literal text, never as real HTML.";
    } else if (isSuggestDefinition(userText)) {
      reply =
        "MOCK-LONG-DEFINITION: This decision point governs the applicability and scope of the allowedObjectFlag attribute across every structureObjectRule and nonContextRule in the data module, including split-rule variants, and must be evaluated consistently for every objectPath regardless of dmCode context or system differences. " +
        "Alsounabrokenverylongsingletokenwithnowhitespaceatallxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    } else if (isSuggestRule(userText)) {
      reply =
        '<structureObjectRule id="MOCK-LONG-RULE"><objectPath allowedObjectFlag="1">/dmodule/content/description/verylongunbrokenxpathsegmentnamewithnowhitespaceatallxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx[@attr=\'value\']</objectPath></structureObjectRule>';
    } else if (hasPriorTurn) {
      reply = `MOCK-FOLLOWUP: Building on my previous answer, here is more detail in response to: "${userText}"`;
    } else {
      reply = `MOCK-ANSWER: Here is information about this BRDP, in response to: "${userText}"`;
    }

    console.log(`chat call -- offTopic=${isOffTopic(userText)} hasPriorTurn=${hasPriorTurn}`);
    const send = () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      // OpenAI/Mistral-compatible shape -- matches what llmAPI.js's
      // sendMessage() parses for any non-Anthropic provider:
      // data.choices[0].message.content
      res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
    };
    if (slowNextArmed) {
      slowNextArmed = false; // one-shot -- doesn't affect the next unrelated call
      console.log(`chat call -- delaying ${SLOW_RESPONSE_DELAY_MS}ms (armed via /slow-next)`);
      setTimeout(send, SLOW_RESPONSE_DELAY_MS);
    } else {
      send();
    }
  });
});

server.listen(PORT, () => console.log(`Mock Mistral chat server listening on :${PORT}`));
