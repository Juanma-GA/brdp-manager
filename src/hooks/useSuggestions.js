// Prompt-refactor round: Suggest Definition/Proposal/Rule state/logic
// extracted out of RecordsPage.jsx verbatim (no behavior change) -- the
// per-BRDP suggestion map, the request-generation soft-cancel mechanism,
// and Accept/Discard.
import { useEffect, useRef, useState } from 'react';
import { authFetchJson } from '../services/apiClient';
import { sendMessage } from '../api/llmAPI';
import { buildSuggestDefinitionPrompt } from '../prompts/suggestDefinitionPrompt.js';
import { buildSuggestProposalPrompt } from '../prompts/suggestProposalPrompt.js';
import { SUGGEST_TEMPERATURE } from '../prompts/shared.js';

export function useSuggestions({ projectId, standard, selected, aiProvider, handleUpdate, recomputeVocabResult, bumpApprovalsRefreshToken, t }) {
  // Suggest Definition catalog guard (docs request, Suggest Definition
  // corpus round): identifiers of this standard's official catalog,
  // fetched once per project (eagerly, unlike other catalog pickers which
  // only load lazily when their own panel opens) -- needed as soon as a
  // row is selected, to decide whether to disable the button at all, not
  // just when a picker is open.
  const [catalogIdentifierSet, setCatalogIdentifierSet] = useState(new Set());

  // Suggest: one pending/loaded suggestion PER BRDP, kept until Accept or
  // Discard (docs request -- the suggestion belongs to the BRDP it was
  // requested for and survives switching rows). Keyed by brdpId, at most
  // one entry per BRDP -- while an entry exists (loading or resolved) for
  // the SELECTED BRDP, all three Suggest buttons are disabled; regenerating
  // the same kind requires Discard first. In memory only, never
  // localStorage (HR1) -- lost on reload/logout, and explicitly emptied on
  // project change (below). Each entry is one of:
  //   loading:    { brdpId, kind, loading: true, expandedReferenceIds }
  //   text:       { brdpId, kind, text, sourceBrdpIds, format?, similar?,
  //                 styleReferences?, excludedPendingOtherProjects,
  //                 expandedReferenceIds }
  //   notice:     { brdpId, kind, insufficientPrecedent: true, count,
  //                 excludedPendingOtherProjects, expandedReferenceIds }
  //   error:      { brdpId, kind, error, expandedReferenceIds }
  // notice/error entries have no Accept (nothing to write) but DO get a
  // Discard button -- without one, a BRDP that hit "insufficient
  // precedent" or an LLM error would stay blocked from ever suggesting
  // again.
  const [suggestionsByBrdpId, setSuggestionsByBrdpId] = useState(new Map());
  // Per-brdpId request generation counter -- bumped ONLY when a NEW
  // request starts for that brdpId (never by Accept/Discard). A late
  // response only commits if BOTH still hold at the time it arrives: (a)
  // the map still has an entry for that brdpId -- false if it was removed
  // by Accept/Discard/BRDP-delete/project-change, in which case it must
  // never resurrect a removed entry; (b) this ref's counter for that
  // brdpId still equals the token captured when the request started --
  // false if a NEWER request for the SAME brdpId has since begun. A soft
  // cancel, since authFetchJson/sendMessage don't expose real mid-flight
  // cancellation here.
  const suggestGenerationRef = useRef(new Map());

  useEffect(() => {
    // Global reference data (not project-scoped), same source/pattern as
    // the other catalog pickers -- fetched eagerly here since it's needed
    // as soon as a row is selected.
    authFetchJson(`/api/brdp-catalog?standard=${encodeURIComponent(standard)}`)
      .then((entries) => setCatalogIdentifierSet(new Set(entries.map((e) => e.identifier))))
      .catch(() => setCatalogIdentifierSet(new Set()));
    // Per-BRDP suggestions are explicitly scoped to this project (docs
    // request: "al cambiar de proyecto, vaciar el mapa") -- an in-flight
    // request from the PREVIOUS project would otherwise land with a
    // brdpId that no longer means anything here. Clearing the generation
    // ref too means any such stale response fails its isCurrent() check
    // even before the (now-cleared) map's own existence check would.
    setSuggestionsByBrdpId(new Map());
    suggestGenerationRef.current = new Map();
  }, [projectId]);

  const selectedSuggestion = selected ? suggestionsByBrdpId.get(selected.id) || null : null;

  const setSuggestionEntry = (brdpId, entry) =>
    setSuggestionsByBrdpId((prev) => {
      const next = new Map(prev);
      next.set(brdpId, entry);
      return next;
    });

  const removeSuggestionEntry = (brdpId) =>
    setSuggestionsByBrdpId((prev) => {
      if (!prev.has(brdpId)) return prev;
      const next = new Map(prev);
      next.delete(brdpId);
      return next;
    });

  // Suggest Definition's reference rows (docs request, readable references
  // round): which candidate ids currently have their Definition expanded
  // below the row -- several can be open at once. Lives INSIDE each BRDP's
  // suggestion entry (not a page-wide Set) so it travels with that entry
  // when switching rows and back.
  const toggleReferenceExpanded = (brdpId, id) =>
    setSuggestionsByBrdpId((prev) => {
      const entry = prev.get(brdpId);
      if (!entry) return prev;
      const nextExpanded = new Set(entry.expandedReferenceIds);
      if (nextExpanded.has(id)) nextExpanded.delete(id);
      else nextExpanded.add(id);
      const next = new Map(prev);
      next.set(brdpId, { ...entry, expandedReferenceIds: nextExpanded });
      return next;
    });

  // docs/v2 §3: real few-shot precedent from the project's own validated
  // BRDPs, via GET .../similar (pure data, no LLM call in the backend --
  // §4's "FastAPI never builds prompts" rule). §3 point 3 (HR7): when
  // /similar itself reports insufficient precedent, show that verbatim
  // and stop -- never fall back to a no-few-shot LLM call.
  const requestSuggestion = async (kind) => {
    if (!selected || !aiProvider) return;
    const brdpId = selected.id;
    // Defense in depth (docs request): the button is already disabled
    // whenever this BRDP has any entry, loading or resolved -- "para
    // regenerar, primero Discard". Each BRDP's block is independent.
    if (suggestionsByBrdpId.has(brdpId)) return;

    // Bumped ONLY here, never by Accept/Discard -- see suggestGenerationRef
    // above for why both this token check AND the map-existence check in
    // commit() below are needed.
    const token = (suggestGenerationRef.current.get(brdpId) || 0) + 1;
    suggestGenerationRef.current.set(brdpId, token);
    const isCurrent = () => suggestGenerationRef.current.get(brdpId) === token;
    const commit = (entry) => {
      if (!isCurrent()) return; // a newer request for this same BRDP has since started
      setSuggestionsByBrdpId((prev) => {
        if (!prev.has(brdpId)) return prev; // entry removed since (deleted / project changed) -- never resurrect
        const next = new Map(prev);
        next.set(brdpId, entry);
        return next;
      });
    };

    setSuggestionEntry(brdpId, { brdpId, kind, loading: true, expandedReferenceIds: new Set() });

    try {
      const similar = await authFetchJson(`/api/projects/${projectId}/brdps/${brdpId}/similar?kind=${kind}`);
      // HR7 -- never silently degrade: a Validated BRDP in another project
      // of this same standard that hasn't been through ITS OWN project's
      // embedding job yet is invisible to this search; surfaced regardless
      // of whether precedent ended up sufficient or not.
      const excludedPendingOtherProjects = similar.excluded_pending_other_projects || 0;

      // kind='definition' (docs request, Suggest Definition corpus round):
      // its own dedicated prompt + corpus shape (Similar/Style references,
      // no MIN_CANDIDATES gate) -- diverges completely from rule below.
      if (kind === 'definition') {
        const referenceSimilar = similar.candidates;
        const referenceStyle = similar.style_references || [];
        const vocab = await recomputeVocabResult(selected);
        const systemPrompt = buildSuggestDefinitionPrompt(
          selected,
          standard,
          referenceSimilar,
          referenceStyle,
          vocab
        );
        const res = await sendMessage(
          [{ role: 'user', content: 'Write the Definition for this BRDP.' }],
          null,
          aiProvider.model,
          aiProvider.provider,
          systemPrompt,
          { temperature: SUGGEST_TEMPERATURE }
        );
        commit({
          brdpId,
          kind,
          loading: false,
          text: res.content,
          sourceBrdpIds: referenceSimilar.map((c) => c.id),
          similar: referenceSimilar,
          styleReferences: referenceStyle,
          excludedPendingOtherProjects,
          expandedReferenceIds: new Set(),
        });
        return;
      }

      // kind='proposal' (docs request, Suggest Proposal round): its own
      // three-group corpus (Same BRDP in other projects / Similar
      // decisions / This project), no MIN_CANDIDATES gate, own prompt --
      // same architecture as kind='definition' above, diverges completely
      // from kind='rule' below.
      if (kind === 'proposal') {
        const referenceSameBrdp = similar.same_brdp || [];
        const referenceSimilar = similar.candidates;
        const referenceThisProject = similar.this_project || [];
        const vocab = await recomputeVocabResult(selected);
        const systemPrompt = buildSuggestProposalPrompt(
          selected,
          standard,
          referenceSameBrdp,
          referenceSimilar,
          referenceThisProject,
          vocab
        );
        const res = await sendMessage(
          [{ role: 'user', content: 'Write the Proposal for this BRDP.' }],
          null,
          aiProvider.model,
          aiProvider.provider,
          systemPrompt,
          { temperature: SUGGEST_TEMPERATURE }
        );
        commit({
          brdpId,
          kind,
          loading: false,
          text: res.content,
          sourceBrdpIds: [...referenceSameBrdp, ...referenceSimilar, ...referenceThisProject].map((c) => c.id),
          sameBrdp: referenceSameBrdp,
          similar: referenceSimilar,
          thisProject: referenceThisProject,
          excludedPendingOtherProjects,
          expandedReferenceIds: new Set(),
        });
        return;
      }

      if (!similar.sufficient_precedent) {
        commit({
          brdpId,
          kind,
          loading: false,
          insufficientPrecedent: true,
          count: similar.candidates.length,
          excludedPendingOtherProjects,
          expandedReferenceIds: new Set(),
        });
        return;
      }

      const label = t(`records.assistant.suggest${kind.charAt(0).toUpperCase()}${kind.slice(1)}`);
      const examples = similar.candidates
        .map((c, i) => `Example ${i + 1} (BRDP ${c.identifier}, similarity ${c.score.toFixed(2)}):\n${c.text}`)
        .join('\n\n');
      const systemPrompt =
        `You are an S1000D/DITA BRDP expert assistant. Use the following real, validated precedent ` +
        `examples from this project's own dataset as few-shot guidance. Return only the new ${label} ` +
        `text, nothing else.\n\n${examples}`;

      const res = await sendMessage(
        [
          {
            role: 'user',
            content: `Suggest a ${label} for BRDP "${selected.identifier}" (current definition: "${selected.definition}", current proposal: "${selected.proposal}").`,
          },
        ],
        null,
        aiProvider.model,
        aiProvider.provider,
        systemPrompt
      );
      commit({
        brdpId,
        kind,
        loading: false,
        text: res.content,
        sourceBrdpIds: similar.candidates.map((c) => c.id),
        format: similar.format,
        excludedPendingOtherProjects,
        expandedReferenceIds: new Set(),
      });
    } catch (err) {
      // Docs request's explicit edge case: an error entry still gets a
      // Discard so the BRDP's Suggest buttons don't stay blocked forever.
      commit({ brdpId, kind, loading: false, error: err.message, expandedReferenceIds: new Set() });
    }
  };

  const logSuggestionFeedback = (entry, outcome) =>
    authFetchJson('/api/suggestion-feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        brdp_id: entry.brdpId,
        kind: entry.kind,
        suggested_text: entry.text,
        source_brdp_ids: entry.sourceBrdpIds || [],
        outcome,
      }),
    });

  const acceptSuggestion = async () => {
    if (!selected) return;
    const entry = suggestionsByBrdpId.get(selected.id);
    if (!entry?.text) return;
    // Defense in depth (docs request): the entry is looked up BY the
    // selected BRDP's own id above, but double-check the field matches
    // too before writing anything.
    if (entry.brdpId !== selected.id) return;
    if (entry.kind === 'rule') {
      await authFetchJson(`/api/projects/${projectId}/brdps/${selected.id}/approvals/${entry.format}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rule_xml: entry.text, source: 'llm', status: 'pending_review' }),
      });
      bumpApprovalsRefreshToken();
    } else {
      await handleUpdate(selected.id, { [entry.kind]: entry.text });
    }
    await logSuggestionFeedback(entry, 'accepted');
    removeSuggestionEntry(selected.id);
  };

  const discardSuggestion = async () => {
    if (!selected) return;
    const entry = suggestionsByBrdpId.get(selected.id);
    if (!entry) return;
    if (entry.text) await logSuggestionFeedback(entry, 'discarded');
    removeSuggestionEntry(selected.id);
  };

  return {
    catalogIdentifierSet,
    suggestionsByBrdpId,
    selectedSuggestion,
    toggleReferenceExpanded,
    requestSuggestion,
    acceptSuggestion,
    discardSuggestion,
    removeSuggestionEntry,
  };
}
