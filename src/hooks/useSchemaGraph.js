import { useEffect, useState } from 'react';
import { fetchSchemaGraph } from '../api/schemaFacts.js';

// Mejoras C, Part 1: the standard's element graph, or null while it loads,
// when the standard has none, or when it could not be loaded -- then the
// path check simply does not run (no warning either), as the encargo asks.
export function useSchemaGraph(standard) {
  const [graph, setGraph] = useState(null);
  useEffect(() => {
    let alive = true;
    setGraph(null);
    if (!standard) return undefined;
    fetchSchemaGraph(standard)
      .then((g) => {
        if (alive) setGraph(g?.available ? g : null);
      })
      .catch(() => {
        if (alive) setGraph(null);
      });
    return () => {
      alive = false;
    };
  }, [standard]);
  return graph;
}
