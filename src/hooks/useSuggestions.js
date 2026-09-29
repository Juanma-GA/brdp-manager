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
import { buildCopyablePrompt, buildSuggestRulePrompt, parseSuggestRuleResponse, SUGGEST_RULE_USER_MESSAGE } from '../prompts/suggestRulePrompt.js';
import { fetchSchemaCards, fetchSchemaFacts } from '../api/schemaFacts.js';
import { checkWellFormed } from '../api/generateBREX.js';
import { registerRuleTest } from '../api/ruleTests';
import { ruleXmlHash } from '../utils/ruleHash.js';
import { checkRuleFormat, checkRuleNames, extractRuleNames, invalidRuleXPaths, selectSchemaFactNames } from '../validation/schemaValidation.js';
import {
  coverageOf,
  decideRuleSchemaContext,
  hasSchemaContextBlock,
  supportsSchemaContext,
  wrapRuleInSchemaContexts,
} from '../utils/ruleSchemaContext.js';

// Element names the schema-context decision looks at: every element name
// the BRDP's Title, Definition and Proposal mention (same extraction as the
// schema facts, just not capped at the prompt's 6).
const SCHEMA_CONTEXT_MAX_NAMES = 30;

// Pasted rules get the same wrapper as a generated one when schemas were
// chosen -- unless the pasted text already carries its own context block.
export function finalRuleXml(entry, ruleXml) {
  const schemas = entry.schemas || [];
  if (schemas.length === 0 || hasSchemaContextBlock(ruleXml)) return ruleXml;
  return wrapRuleInSchemaContexts(ruleXml, entry.format, entry.standard, schemas, entry.schemaLocation);
}
import { ruleStateOf } from '../utils/ruleState';

// Suggest Rule validation (docs request, Part 4): deterministic. Two
// things disable Accept: XML that isn't well-formed (the backend would
// reject it anyway) and an XPath expression that isn't syntactically valid
// (schema-location encargo, Part 3 -- e.g. //&lt;emphasis&gt;). Unknown /
// wrong-kind names in the rule's XPath are red warnings with Accept still
// enabled. `acceptable` is the single gate every Accept path uses.
// Consolidation C2, Part 0: a third blocker -- the content must contain a
// rule of the project's format (checkRuleFormat), so loose text such as
// //&lt;emphasis&gt; or a wrapper such as <rules> is never saved as a rule.
export function validateRuleXml(xml, vocabulary, format) {
  const wellFormed = checkWellFormed(xml || '');
  // Only meaningful on well-formed XML (the expressions come out of it).
  const invalidXPaths = wellFormed.valid ? invalidRuleXPaths(xml || '') : [];
  const ruleFormat = wellFormed.valid ? checkRuleFormat(xml || '', format) : null;
  return {
    wellFormed: wellFormed.valid,
    wellFormedError: wellFormed.error,
    invalidXPaths,
    ruleFormat,
    acceptable: wellFormed.valid && invalidXPaths.length === 0 && ruleFormat.ok,
    names: checkRuleNames(xml || '', vocabulary),
  };
}

export function useSuggestions({ projectId, standard, schemaLocation, selected, aiProvider, vocabulary, ruleApproval, handleUpdate, recomputeVocabResult, bumpApprovalsRefreshToken, onRuleTestRecordError, t }) {
  // Suggest Definition catalog guard (docs request, Suggest Definition
  // corpus round): identifiers of this standard's official catalog,
  // fetched once per project (eagerly, unlike other catalog pickers which
  // only load lazily when their own panel opens) -- needed as soon as a
  // row is selected, to decide whether to disable the button at all, not
  // just when a picker is open.
  // C3, Part 2: null when the catalog could not be loaded -- the check is
  // then unavailable (never "no catalog BRDPs", which would silently
  // enable Suggest Definition on an official BRDP) and catalogLoadError
  // says so in the panel (HR7). The backend still refuses Suggest
  // Definition on a catalog BRDP with 400.
  const [catalogIdentifierSet, setCatalogIdentifierSet] = useState(new Set());
  const [catalogLoadError, setCatalogLoadError] = useState(null);

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
  //   error:      { brdpId, kind, error, expandedReferenceIds }
  //   selector:   { brdpId, kind: 'rule', selector, prepare, coverageByName,
  //                 expandedReferenceIds } -- Suggest Rule part 2: the
  //                 inline schema choice shown BEFORE generating (S1000D).
  // kind='rule' entries (docs request, Suggest Rule round) also carry
  // `copyablePrompt` (for Copy prompt, whenever a prompt was built),
  // `pastedRule` (the Paste rule field), the reference groups, and --
  // instead of `text` -- `notCheckable` (the model's reason) when the
  // decision can't be verified on the XML.
  // error / NOT_CHECKABLE entries have no Accept for the generated text
  // but DO get a Discard button -- otherwise the BRDP would stay blocked
  // from ever suggesting again.
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
    setCatalogLoadError(null);
    authFetchJson(`/api/brdp-catalog?standard=${encodeURIComponent(standard)}`)
      .then((entries) => setCatalogIdentifierSet(new Set(entries.map((e) => e.identifier))))
      .catch((err) => {
        setCatalogIdentifierSet(null);
        setCatalogLoadError(err.message || String(err));
      });
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
  // Latest map, for checks after an await (the closure's copy is stale).
  const suggestionsRef = useRef(suggestionsByBrdpId);
  suggestionsRef.current = suggestionsByBrdpId;

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

  // docs/v2 §3: real few-shot precedent via GET .../similar (pure data,
  // no LLM call in the backend -- §4's "FastAPI never builds prompts"
  // rule); each kind builds its own prompt from it here.
  // `prepare` (optional, Suggest Rule adjustments round): awaited first,
  // inside the loading entry -- RecordsPage passes "embed this BRDP" when
  // it is the project's only pending embedding. Its failure becomes the
  // entry's error (with Discard), like any other.
  // `options` (Suggest Rule part 2): { schemas, coverageByName,
  // fromSelector, failedTest } -- the schemas chosen in the selector (empty
  // = general rule), the element coverage already fetched for the decision,
  // whether the call replaces this BRDP's own entry, and (T3b) the failed
  // test of the rule being corrected.
  const requestSuggestion = async (kind, prepare = null, options = {}) => {
    if (!selected || !aiProvider) return;
    const brdpId = selected.id;
    // Defense in depth (docs request): the button is already disabled
    // whenever this BRDP has any entry, loading or resolved -- "para
    // regenerar, primero Discard". Each BRDP's block is independent. The
    // one exception is the schema selector's own Generate.
    if (suggestionsByBrdpId.has(brdpId) && !options.fromSelector) return;

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
      if (prepare) await prepare();
      const similar = await authFetchJson(`/api/projects/${projectId}/brdps/${brdpId}/similar?kind=${kind}`);
      // HR7 -- never silently degrade: a Validated BRDP in another project
      // of this same standard that hasn't been through ITS OWN project's
      // embedding job yet is invisible to this search -- always surfaced.
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

      // kind='rule' (docs request, Suggest Rule round): four groups from
      // /similar (same_brdp / candidates / standard_fallback /
      // template_fallback), schema facts for the names in the Proposal and
      // Definition, one general rule in the standard's format. The prompt
      // is kept on the entry so Copy prompt works even if the LLM call
      // itself then fails.
      const sameBrdp = similar.same_brdp || [];
      const ruleSimilar = similar.candidates;
      const standardFallback = similar.standard_fallback || [];
      const templateFallback = similar.template_fallback || [];
      const schemaFacts = await fetchSchemaFacts(standard, vocabulary, [selected.proposal, selected.definition], 6);
      const schemas = options.schemas || [];
      const systemPrompt = buildSuggestRulePrompt(
        selected,
        standard,
        similar.format,
        { sameBrdp, similar: ruleSimilar, formatExamples: [...standardFallback, ...templateFallback] },
        schemaFacts,
        { schemas },
        options.failedTest || null
      );
      const ruleBase = {
        brdpId,
        kind,
        loading: false,
        format: similar.format,
        standard,
        // The project's "Schema location" (flat / master) -- the context
        // block URL form the wrapper writes.
        schemaLocation,
        schemas,
        coverageByName: options.coverageByName || {},
        sameBrdp,
        similar: ruleSimilar,
        standardFallback,
        templateFallback,
        // Only real BRDPs -- template rows are not BRDPs.
        sourceBrdpIds: [...sameBrdp, ...ruleSimilar, ...standardFallback].map((c) => c.id),
        excludedPendingOtherProjects,
        // T3b: written to correct a rule whose test the review blamed on
        // the rule -- shown as a note; testable straight away like any other.
        correctedFromTest: Boolean(options.failedTest),
        copyablePrompt: buildCopyablePrompt(systemPrompt),
        pastedRule: '',
        expandedReferenceIds: new Set(),
      };
      let res;
      try {
        res = await sendMessage(
          [{ role: 'user', content: SUGGEST_RULE_USER_MESSAGE }],
          null,
          aiProvider.model,
          aiProvider.provider,
          systemPrompt,
          { temperature: SUGGEST_TEMPERATURE }
        );
      } catch (err) {
        commit({ ...ruleBase, error: err.message });
        return;
      }
      const parsed = parseSuggestRuleResponse(res.content);
      if (parsed.notCheckable !== undefined) {
        commit({ ...ruleBase, notCheckable: parsed.notCheckable || '—' });
      } else {
        // The LLM writes only the inner rule; the app adds one context
        // block per chosen schema. With schemas chosen, the coverage of the
        // rule's own element names is fetched too, for the per-schema
        // warning (Part 5) -- a failed fetch only loses that warning, the
        // vocabulary check still runs.
        const text = finalRuleXml(ruleBase, parsed.xml);
        const coverageByName = schemas.length
          ? await fetchMissingCoverage(extractRuleNames(parsed.xml).elements, ruleBase.coverageByName)
          : ruleBase.coverageByName;
        commit({ ...ruleBase, coverageByName, text });
      }
    } catch (err) {
      // Docs request's explicit edge case: an error entry still gets a
      // Discard so the BRDP's Suggest buttons don't stay blocked forever.
      commit({ brdpId, kind, loading: false, error: err.message, expandedReferenceIds: new Set() });
    }
  };

  // name -> Set(schemas) for `names` not in `known` yet, merged into it.
  const fetchMissingCoverage = async (names, known) => {
    const missing = names.filter((n) => !known[n]);
    if (missing.length === 0) return known;
    try {
      const res = await fetchSchemaCards(standard, missing);
      const merged = { ...known };
      for (const [name, entry] of Object.entries(res.cards || {})) merged[name] = coverageOf(entry);
      return merged;
    } catch {
      return known;
    }
  };

  // Suggest Rule entry point (part 2). S1000D: decides deterministically
  // whether to offer the schema choice (utils/ruleSchemaContext.js) and
  // either shows the selector or generates a general rule straight away.
  // `manual` = the "Limit to specific schemas…" link: always shows it.
  // DITA (no schema context): straight to a general rule.
  const startRuleSuggestion = async ({ prepare = null, manual = false } = {}) => {
    if (!selected || !aiProvider) return;
    const brdpId = selected.id;
    if (suggestionsByBrdpId.has(brdpId)) return;
    if (!supportsSchemaContext(standard)) {
      await requestSuggestion('rule', prepare);
      return;
    }
    setSuggestionEntry(brdpId, { brdpId, kind: 'rule', loading: true, expandedReferenceIds: new Set() });
    let decision;
    let coverageByName = {};
    try {
      const texts = [selected.title, selected.definition, selected.proposal];
      const names = selectSchemaFactNames(texts, vocabulary, SCHEMA_CONTEXT_MAX_NAMES).map((c) => c.name);
      const res = await fetchSchemaCards(standard, names);
      for (const [name, entry] of Object.entries(res.cards || {})) coverageByName[name] = coverageOf(entry);
      decision = decideRuleSchemaContext({
        standard,
        documentSchemas: res.document_schemas || [],
        cards: res.cards || {},
        text: texts.join('\n'),
      });
    } catch (err) {
      // Never silently fall back to a general rule (HR7): the user sees the
      // error and Discards it.
      if (!suggestionsRef.current.has(brdpId)) return; // BRDP deleted / project changed meanwhile
      setSuggestionEntry(brdpId, { brdpId, kind: 'rule', loading: false, error: err.message, expandedReferenceIds: new Set() });
      return;
    }
    if (!suggestionsRef.current.has(brdpId)) return; // BRDP deleted / project changed meanwhile
    if (!decision.supported || (!decision.showSelector && !manual)) {
      removeSuggestionEntry(brdpId);
      await requestSuggestion('rule', prepare, { schemas: [], coverageByName, fromSelector: true });
      return;
    }
    setSuggestionEntry(brdpId, {
      brdpId,
      kind: 'rule',
      loading: false,
      selector: decision,
      prepare,
      coverageByName,
      expandedReferenceIds: new Set(),
    });
  };

  // The selector's Generate: nothing checked = a general rule.
  const generateRuleWithSchemas = async (schemas) => {
    if (!selected) return;
    const entry = suggestionsByBrdpId.get(selected.id);
    if (!entry?.selector) return;
    await requestSuggestion('rule', entry.prepare, {
      schemas,
      coverageByName: entry.coverageByName,
      fromSelector: true,
    });
  };

  // T3b "Suggest a corrected rule": the review of a failed test blamed the
  // rule. Opens Suggest Rule with a "PREVIOUS RULE FAILED ITS TEST" block
  // (previous rule, mismatched examples, diagnosis), limited to the same
  // schemas as the previous rule. Replaces this BRDP's current entry -- the
  // suggestion under test, when the review ran on one (logged as
  // discarded, it was never accepted). Nothing is recorded: only a new
  // test of the new rule is.
  const suggestCorrectedRule = async ({ ruleXml, schemas, mismatches, diagnosis }, prepare = null) => {
    if (!selected || !aiProvider) return;
    const existing = suggestionsByBrdpId.get(selected.id);
    if (existing?.text) await logSuggestionFeedback(existing, 'discarded');
    await requestSuggestion('rule', prepare, {
      schemas: schemas || [],
      fromSelector: true,
      failedTest: { ruleXml, mismatches, diagnosis },
    });
  };

  // Paste rule with schemas chosen: coverage for the pasted rule's names,
  // for the per-schema warning.
  const ensurePastedCoverage = async (brdpId, ruleXml) => {
    const entry = suggestionsByBrdpId.get(brdpId);
    if (!entry || !(entry.schemas || []).length) return;
    const coverageByName = await fetchMissingCoverage(extractRuleNames(ruleXml).elements, entry.coverageByName || {});
    if (coverageByName === entry.coverageByName) return;
    setSuggestionsByBrdpId((prev) => {
      const current = prev.get(brdpId);
      if (!current) return prev;
      const next = new Map(prev);
      next.set(brdpId, { ...current, coverageByName: { ...current.coverageByName, ...coverageByName } });
      return next;
    });
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

  // Test de reglas T3: a Test rule run on a suggestion (the rule in
  // memory) is kept in its entry, with the exact rule it tested, and
  // recorded when that rule is accepted -- only if the accepted rule is the
  // tested one, byte for byte (a new suggestion replaces the entry, so a
  // test of an earlier suggestion never carries over).
  const recordSuggestionTest = (brdpId, testedRuleXml, record) =>
    setSuggestionsByBrdpId((prev) => {
      const entry = prev.get(brdpId);
      if (!entry || entry.text !== testedRuleXml) return prev;
      const next = new Map(prev);
      next.set(brdpId, { ...entry, testRecord: { ...record, ruleXml: testedRuleXml } });
      return next;
    });

  const saveRuleAsDraft = async (entry, ruleXml, source) => {
    // A Draft already exists -> the user confirms replacing it (docs
    // request). A Verified rule can't get here: Suggest Rule is disabled
    // for it and the backend refuses it too.
    if (ruleStateOf(ruleApproval) === 'draft' && !window.confirm(t('records.assistant.replaceDraftRuleConfirm'))) {
      return false;
    }
    await authFetchJson(`/api/projects/${projectId}/brdps/${selected.id}/approvals/${entry.format}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rule_xml: ruleXml, source, status: 'pending_review' }),
    });
    const tested = entry.testRecord;
    if (tested && ruleXmlHash(tested.ruleXml) === ruleXmlHash(ruleXml)) {
      try {
        await registerRuleTest(projectId, selected.id, entry.format, ruleXml, tested);
      } catch (err) {
        // The rule is saved; only its test result is missing -- say so.
        onRuleTestRecordError?.(err.message);
      }
    }
    bumpApprovalsRefreshToken();
    return true;
  };

  const acceptSuggestion = async () => {
    if (!selected) return;
    const entry = suggestionsByBrdpId.get(selected.id);
    if (!entry?.text) return;
    // Defense in depth (docs request): the entry is looked up BY the
    // selected BRDP's own id above, but double-check the field matches
    // too before writing anything.
    if (entry.brdpId !== selected.id) return;
    if (entry.kind === 'rule') {
      if (!validateRuleXml(entry.text, vocabulary, entry.format).acceptable) return;
      if (!(await saveRuleAsDraft(entry, entry.text, 'llm'))) return;
    } else {
      await handleUpdate(selected.id, { [entry.kind]: entry.text });
    }
    await logSuggestionFeedback(entry, 'accepted');
    removeSuggestionEntry(selected.id);
  };

  // Paste rule (docs request): a rule obtained from another LLM with Copy
  // prompt, pasted back. Same validation as a generated rule; saved as
  // Draft with source "external_llm" so it stays distinguishable from an
  // in-app generation. Not logged as suggestion feedback -- that table
  // measures the app's own suggestions.
  const setPastedRule = (brdpId, value) =>
    setSuggestionsByBrdpId((prev) => {
      const entry = prev.get(brdpId);
      if (!entry) return prev;
      const next = new Map(prev);
      next.set(brdpId, { ...entry, pastedRule: value });
      return next;
    });

  const acceptPastedRule = async () => {
    if (!selected) return;
    const entry = suggestionsByBrdpId.get(selected.id);
    const pasted = (entry?.pastedRule || '').trim();
    if (!entry || entry.kind !== 'rule' || !pasted) return;
    const ruleXml = finalRuleXml(entry, pasted);
    if (!validateRuleXml(ruleXml, vocabulary, entry.format).acceptable) return;
    if (!(await saveRuleAsDraft(entry, ruleXml, 'external_llm'))) return;
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
    catalogLoadError,
    suggestionsByBrdpId,
    selectedSuggestion,
    toggleReferenceExpanded,
    requestSuggestion,
    startRuleSuggestion,
    generateRuleWithSchemas,
    suggestCorrectedRule,
    ensurePastedCoverage,
    acceptSuggestion,
    acceptPastedRule,
    setPastedRule,
    recordSuggestionTest,
    discardSuggestion,
    removeSuggestionEntry,
  };
}
