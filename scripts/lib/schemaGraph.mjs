// A standard's whole element graph for the Node scripts (Mejoras C, Part 1:
// paths that cannot exist) -- the same data GET /api/schema-cards/graph
// serves, read through backend/scripts/schema_graph_json.py so Node never
// re-derives it from the cards. Cached per standard for the process.
//
//   schemaGraph(standard) -> { available, schemas, roots, elements }
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { BACKEND_DIR as BACKEND, pythonCandidates, pythonEnv } from './backendPython.mjs';

const SCRIPT = path.join(BACKEND, 'scripts', 'schema_graph_json.py');
const CACHE = new Map();

export function schemaGraph(standard) {
  if (CACHE.has(standard)) return CACHE.get(standard);
  let lastError;
  for (const python of pythonCandidates()) {
    try {
      const out = execFileSync(python, [SCRIPT, standard], { cwd: BACKEND, env: pythonEnv(), maxBuffer: 64 * 1024 * 1024 });
      const graph = JSON.parse(out.toString('utf8'));
      CACHE.set(standard, graph);
      return graph;
    } catch (err) {
      lastError = err;
      if (err.code !== 'ENOENT') break;
    }
  }
  const detail = lastError?.stderr?.toString().trim() || lastError?.message;
  throw new Error(`could not read the schema graph with ${SCRIPT} (set BACKEND_PYTHON to the backend's Python): ${detail}`);
}
