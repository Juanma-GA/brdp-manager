// Corrección propuesta, Part 2: every saved rule of the project checked by
// code (src/validation/ruleCorrection.js) -- which rules have a proposed
// correction and which a defect without a fix -- plus the defect only a
// whole project can have: one rule id used by the rules of two BRDPs.
//
// Where it runs, and why: in the browser, in slices. The checks are the
// same JavaScript the BRDP's ficha uses (names, paths, XPath, format), so
// the list and the ficha can never disagree; porting them to Python would
// be a second copy to keep in step. The rule texts come in one request
// (the bulk export Generate and Excel already use). Each slice runs for at
// most SLICE_MS and then yields, so the page never freezes; progress is
// shown while it works. Results are kept in memory per rule text
// (resultCache below, shared with the ficha): after a rule is saved, only
// that rule is checked again. Nothing is stored in the browser (HR1).
//
// Measured (Node, @xmldom/xmldom -- slower than the browser's DOMParser):
// the 502 rules of the Lufthansa BREX in 0.3 s, the 533 of the CA BREX in
// 6 s, 4.5 of them for its one 1.9 MB rule (BRDP-S1-00007, 4500 rules).
import { useEffect, useMemo, useRef, useState } from 'react';
import { authFetchJson } from '../services/apiClient';
import { ruleXmlHash } from '../utils/ruleHash.js';
import { clashDefects, projectRuleIdClashes, proposeRuleCorrection } from '../validation/ruleCorrection.js';
import { ruleElementIds } from '../utils/ruleSplit.js';
import { loadOtherStandardVocabularies, STANDARD_TO_VOCABULARY_FILE } from '../validation/schemaValidation.js';
import { useSchemaGraphState } from './useSchemaGraph.js';

const SLICE_MS = 40;
const CACHE_MAX = 6000;
const resultCache = new Map();

// The correction of one rule text under one context (shared by the list
// and the ficha, so a big rule is checked once).
export function cachedRuleCorrection(ruleXml, format, ctx) {
  const key = [format, ctx.standard, ctx.schemaLocation || '', ctx.otherVocabularies ? 1 : 0, ctx.graph ? 1 : 0, ctx.vocabulary ? 1 : 0, ruleXml].join('\u0000');
  if (resultCache.has(key)) return resultCache.get(key);
  let result;
  try {
    result = proposeRuleCorrection(ruleXml, format, ctx);
  } catch (err) {
    console.error('Rule correction check failed', err);
    result = { defects: [], proposal: null, needsOtherVocabularies: false, failed: true };
  }
  if (resultCache.size >= CACHE_MAX) resultCache.clear();
  resultCache.set(key, result);
  return result;
}

// What a rule's result means for the lists: 'proposed' (a correction not
// discarded), 'unfixable' (defects, none with a fix), 'dismissed' (its
// correction was discarded for this text), or null (nothing to say).
export function correctionStatus(result, clashes, dismissed) {
  const hasDefects = (result?.defects?.length || 0) + (clashes?.length || 0) > 0;
  if (!hasDefects) return null;
  if (result?.proposal) return dismissed ? 'dismissed' : 'proposed';
  return 'unfixable';
}

// The context every check needs: the project's vocabulary, the other
// standards' (loaded only once some name needs them) and the schema graph.
export function useCorrectionContext({ standard, vocabulary, vocabularyLoadError, schemaLocation }) {
  const { graph, ready: graphReady } = useSchemaGraphState(standard);
  const [others, setOthers] = useState({ standard: null, vocabularies: null });
  const [needOthers, setNeedOthers] = useState(false);
  useEffect(() => {
    if (!needOthers || others.standard === standard) return undefined;
    let alive = true;
    loadOtherStandardVocabularies(standard).then((vocabularies) => {
      if (alive) setOthers({ standard, vocabularies });
    });
    return () => {
      alive = false;
    };
  }, [needOthers, others.standard, standard]);
  const hasVocabularyFile = Boolean(STANDARD_TO_VOCABULARY_FILE[standard]);
  const vocabularyReady = !hasVocabularyFile || Boolean(vocabulary) || Boolean(vocabularyLoadError);
  const otherVocabularies = others.standard === standard ? others.vocabularies : null;
  const ctx = useMemo(
    () => ({ vocabulary, otherVocabularies, graph, standard, schemaLocation }),
    [vocabulary, otherVocabularies, graph, standard, schemaLocation]
  );
  return { ctx, ready: graphReady && vocabularyReady, requestOtherVocabularies: () => setNeedOthers(true) };
}

// → { status: 'idle'|'loading'|'checking'|'done'|'error', progress: {done,
//   total}, byBrdpId: Map(brdpId → { result, clashes, dismissed, status }),
//   counts: { proposed, unfixable }, error, retry }
export function useRuleCorrections({ projectId, format, correction, refreshToken }) {
  const { ctx, ready, requestOtherVocabularies } = correction;
  const [rules, setRules] = useState({ key: null, rows: null, error: null });
  const [reloadToken, setReloadToken] = useState(0);
  // `source`/`ctx`: what the results were computed for -- while they are
  // not the current ones, the previous results stay (the list filter does
  // not empty itself on every rule save) and the status says "checking".
  const [state, setState] = useState({ source: null, ctx: null, done: false, progress: { done: 0, total: 0 }, byBrdpId: new Map() });
  const runRef = useRef(0);

  // The rule texts, again after every rule save (refreshToken).
  useEffect(() => {
    if (!format) return undefined;
    let cancelled = false;
    authFetchJson(`/api/projects/${projectId}/approvals/${format}/export`)
      .then((rows) => !cancelled && setRules({ key: `${projectId}|${format}`, rows, error: null }))
      .catch((err) => !cancelled && setRules({ key: `${projectId}|${format}`, rows: null, error: err }));
    return () => {
      cancelled = true;
    };
  }, [projectId, format, refreshToken, reloadToken]);

  const currentRows = rules.key === `${projectId}|${format}` ? rules.rows : null;

  useEffect(() => {
    const run = ++runRef.current;
    if (!ready || !currentRows) return undefined;
    const rows = currentRows.filter((r) => r.rule_xml && r.rule_xml.trim());
    const clashes = projectRuleIdClashes(
      rows.map((r) => ({ brdpId: r.brdp_id, identifier: r.identifier || r.brdp_id, xml: r.rule_xml })),
      format
    );
    const byBrdpId = new Map();
    let index = 0;
    let wantsOthers = false;
    let timer = null;
    const slice = () => {
      if (run !== runRef.current) return;
      const start = performance.now();
      while (index < rows.length && performance.now() - start < SLICE_MS) {
        const row = rows[index];
        const result = cachedRuleCorrection(row.rule_xml, format, ctx);
        if (result.needsOtherVocabularies) wantsOthers = true;
        const ruleClashes = clashDefects(clashes.get(row.brdp_id));
        const dismissed = Boolean(row.correction_dismissed_hash) && row.correction_dismissed_hash === ruleXmlHash(row.rule_xml);
        byBrdpId.set(row.brdp_id, { result, clashes: ruleClashes, dismissed, status: correctionStatus(result, ruleClashes, dismissed), ruleXml: row.rule_xml });
        index += 1;
      }
      const finished = index >= rows.length;
      setState((previous) => ({
        source: currentRows,
        ctx,
        done: finished,
        progress: { done: index, total: rows.length },
        // While a re-check runs, the previous results stand in for the rules not reached yet.
        byBrdpId: finished ? byBrdpId : new Map([...previous.byBrdpId, ...byBrdpId]),
      }));
      if (!finished) {
        timer = setTimeout(slice, 0);
        return;
      }
      if (wantsOthers && !ctx.otherVocabularies) requestOtherVocabularies();
    };
    timer = setTimeout(slice, 0);
    return () => {
      if (timer) clearTimeout(timer);
    };
    // requestOtherVocabularies only sets a flag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, currentRows, ctx, format]);

  const counts = useMemo(() => {
    let proposed = 0;
    let unfixable = 0;
    for (const entry of state.byBrdpId.values()) {
      if (entry.status === 'proposed') proposed += 1;
      else if (entry.status === 'unfixable') unfixable += 1;
    }
    return { proposed, unfixable };
  }, [state.byBrdpId]);

  // Mejoras G, Part 2.2 b: id → the BRDPs whose saved rule uses it, for the
  // warning under a suggested, corrected or pasted rule.
  const idOwners = useMemo(() => {
    const owners = new Map();
    for (const r of currentRows || []) {
      if (!r.rule_xml) continue;
      for (const id of ruleElementIds(r.rule_xml, format)) {
        if (!owners.has(id)) owners.set(id, []);
        if (!owners.get(id).some((o) => o.brdpId === r.brdp_id)) owners.get(id).push({ brdpId: r.brdp_id, identifier: r.identifier || r.brdp_id });
      }
    }
    return owners;
  }, [currentRows, format]);

  const current = state.source === currentRows && state.ctx === ctx;
  const status = !format
    ? 'idle'
    : rules.error && rules.key === `${projectId}|${format}`
      ? 'error'
      : current && state.done
        ? 'done'
        : current
          ? 'checking'
          : 'loading';
  return {
    status,
    progress: current ? state.progress : { done: 0, total: 0 },
    byBrdpId: state.byBrdpId,
    counts,
    idOwners,
    error: rules.error,
    retry: () => setReloadToken((n) => n + 1),
  };
}
