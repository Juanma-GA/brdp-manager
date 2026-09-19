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

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ embedding, index: 0 }] }));
  });
});

const PORT = 8901;
server.listen(PORT, () => {
  console.log(`Mock Mistral embeddings server listening on http://localhost:${PORT}`);
});
