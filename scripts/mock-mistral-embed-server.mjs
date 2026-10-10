// Ad hoc, throwaway local mock of Mistral's embeddings endpoint -- lets a
// real Apply/import or embedding_jobs run against this dev environment,
// which has no real Mistral API key, without touching the real internet.
// Mirrors the real response shape ({"data": [{"embedding": [...], "index":
// N}, ...]}) -- same "mock only the Mistral HTTP transport, nothing else"
// convention CLAUDE.md documents for the pytest suite, applied here to a
// real running uvicorn server instead of the FastAPI TestClient.
//
// Batch embeddings round (docs request): now handles a real "input" array
// of N texts, not just one -- returns exactly one data item per input
// text, each with the real index it was sent at. Deliberately returns
// them in REVERSED order (not request order) so a verification script
// exercises app/services/embeddings.py's compute_embeddings_batch's own
// "match by the response's own index field, never assume order" logic
// for real, rather than happening to pass because both sides coincidentally
// agree on ordering. Each returned vector is DERIVED from its own input
// text (a simple deterministic hash, not a real embedding model) rather
// than a single constant vector for everything -- lets a verification
// script confirm "vector N is really the one for text N" (and that
// recomputing the same text alone via a single-item request yields the
// identical vector), not just "some vector came back for some text".
import http from "node:http";

const EMBEDDING_DIM = 1024;

let callCount = 0;

// Texts that share words embed close together, like a real model would: a
// shared base direction (weight 0.65) plus a bag of the text's words (each
// word hashed to a dimension and a sign; weight 0.35). Two unrelated texts
// compare at about 0.65 -- every "similar" check of the app (at or above
// 0.5) still finds them -- texts sharing most of their words at about 0.9,
// the same text at 1. Before AI Extract's repetition check every vector was
// a multiple of the same one: any two texts compared at exactly 1, and
// which "similar" rows came first depended only on the tie-break.
const BASE_WEIGHT = Math.sqrt(0.65);
const WORDS_WEIGHT = Math.sqrt(0.35);

function textHash(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function embeddingForText(text) {
  const words = [...new Set(String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])];
  const bag = new Array(EMBEDDING_DIM).fill(0);
  for (const word of words.length ? words : [""]) {
    const h = textHash(word);
    bag[h % EMBEDDING_DIM] += (h >>> 16) & 1 ? 1 : -1;
  }
  const norm = Math.sqrt(bag.reduce((sum, x) => sum + x * x, 0)) || 1;
  const base = 1 / Math.sqrt(EMBEDDING_DIM);
  return bag.map((x) => Number((BASE_WEIGHT * base + (WORDS_WEIGHT * x) / norm).toFixed(6)));
}

const server = http.createServer((req, res) => {
  // A one-line-per-call counter endpoint, plumbed through so verification
  // scripts can assert "N real embedding *requests* happened" (never per
  // item -- a batch of 32 texts in one POST still counts as ONE call
  // here, which is exactly the point of the batch-embeddings round: fewer
  // requests for the same number of embedded items), without parsing
  // server logs -- GET /calls returns the running total, POST
  // /reset-calls zeroes it back to 0.
  if (req.method === "GET" && req.url === "/calls") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ count: callCount }));
    return;
  }
  if (req.method === "POST" && req.url === "/reset-calls") {
    callCount = 0;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ count: callCount }));
    return;
  }
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    callCount += 1;
    let inputs;
    try {
      const parsed = JSON.parse(body);
      inputs = Array.isArray(parsed.input) ? parsed.input : [parsed.input];
    } catch {
      inputs = [""];
    }
    console.log(`embed call #${callCount} (${inputs.length} text(s))`);
    const data = inputs.map((text, index) => ({ embedding: embeddingForText(text), index }));
    // Reversed, not request order -- see module docstring.
    data.reverse();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data }));
  });
});

const PORT = 8901;
server.listen(PORT, () => {
  console.log(`Mock Mistral embeddings server listening on http://localhost:${PORT}`);
});
