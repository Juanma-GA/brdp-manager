// One-off verification-only variant of mock-mistral-embed-server.mjs --
// adds a deliberate per-call delay so a real embedding_jobs run against a
// handful of pending rows takes long enough to observe its "running"
// state (progress bar + ETA) via Playwright, instead of completing
// between one poll tick and the next. Same port/endpoints/response shape
// as the original (this dev environment's .env already points
// MISTRAL_EMBED_ENDPOINT at localhost:8901, so no uvicorn restart is
// needed) -- NOT used by any other script or the app in normal operation,
// throwaway for this round's on-demand-embeddings verification only.
import http from "node:http";

const EMBEDDING_DIM = 1024;
const embedding = new Array(EMBEDDING_DIM).fill(0.1);
const DELAY_MS = 700;

let callCount = 0;

const server = http.createServer((req, res) => {
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
    console.log(`embed call #${callCount} (delayed ${DELAY_MS}ms)`);
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ embedding, index: 0 }] }));
    }, DELAY_MS);
  });
});

const PORT = 8901;
server.listen(PORT, () => {
  console.log(`Delayed mock Mistral embeddings server listening on http://localhost:${PORT}`);
});
