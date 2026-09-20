// Ad hoc, throwaway local mock of Mistral's embeddings endpoint -- lets a
// real Apply/import (which computes a real embedding for every BRDP row
// importing as validation="Validated") run against this dev environment,
// which has no real Mistral API key, without touching the real internet.
// Mirrors exactly the shape backend/tests' own _mock_embeddings_transport
// fixture returns ({"data": [{"embedding": [...], "index": 0}]}) -- same
// "mock only the Mistral HTTP transport, nothing else" convention
// CLAUDE.md documents for the pytest suite, applied here to a real running
// uvicorn server instead of the FastAPI TestClient.
import http from "node:http";

const EMBEDDING_DIM = 1024;
const embedding = new Array(EMBEDDING_DIM).fill(0.1);

let callCount = 0;

const server = http.createServer((req, res) => {
  // A one-line-per-call counter endpoint, plumbed through so verification
  // scripts can assert "N real embedding calls happened" (or didn't)
  // around a reimport, without parsing server logs -- GET /calls returns
  // the running total, POST /reset-calls zeroes it back to 0.
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
    console.log(`embed call #${callCount}`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ embedding, index: 0 }] }));
  });
});

const PORT = 8901;
server.listen(PORT, () => {
  console.log(`Mock Mistral embeddings server listening on http://localhost:${PORT}`);
});
