import { useEffect, useState } from 'react';
import { fetchSchemaGraph } from '../api/schemaFacts.js';

// Mejoras C, Part 1: the standard's element graph, or null while it loads,
// when the standard has none, or when it could not be loaded -- then the
// path check simply does not run (no warning either), as the encargo asks.
// The loaded graph is kept with its standard, so a graph of the previous
// standard is never returned while the new one loads.
//
// useSchemaGraphState also says whether the answer is in (`ready`): the
// check of the project's rules (Corrección propuesta) waits for it, so a
// rule is never counted as "no path defect" just because the graph had not
// arrived yet.
export function useSchemaGraphState(standard) {
  const [loaded, setLoaded] = useState({ standard: null, graph: null });
  useEffect(() => {
    let alive = true;
    if (!standard) return undefined;
    fetchSchemaGraph(standard)
      .then((g) => {
        if (alive) setLoaded({ standard, graph: g?.available ? g : null });
      })
      .catch(() => {
        if (alive) setLoaded({ standard, graph: null });
      });
    return () => {
      alive = false;
    };
  }, [standard]);
  const ready = Boolean(standard) && loaded.standard === standard;
  return { graph: ready ? loaded.graph : null, ready };
}

export function useSchemaGraph(standard) {
  return useSchemaGraphState(standard).graph;
}
