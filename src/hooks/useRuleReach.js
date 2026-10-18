import { useMemo } from 'react';
import { useSchemaGraph } from './useSchemaGraph.js';
import { starReach } from '../validation/ruleRepetition.js';

// Mejoras G, Part 2.1: the elements a "*[@a]" step of the rule reaches
// (starReach), with the standard's graph; [] while it loads or without one.
export function useRuleReach(ruleXml, format, standard, schemaLocation) {
  const graph = useSchemaGraph(standard);
  return useMemo(() => {
    if (!graph || !ruleXml || !format) return [];
    try {
      return starReach(ruleXml, format, graph, { schemaLocation });
    } catch {
      return [];
    }
  }, [graph, ruleXml, format, schemaLocation]);
}
