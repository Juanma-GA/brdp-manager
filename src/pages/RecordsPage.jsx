import { useEffect, useRef, useState } from 'react';
import { useOutletContext, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { authFetchJson } from '../services/apiClient';
import { sendMessage } from '../api/llmAPI';
import { checkWellFormed } from '../api/generateBREX.js';
import { STANDARD_TO_RULE_FORMAT } from '../constants/ruleFormats';
import { RULE_STATES, ruleStateOf } from '../utils/ruleState';
import SortableHeader from '../components/SortableHeader';
import { ProposalStatusSummary, RuleStatusSummary } from '../components/StatusCountsSummary';
import {
  useActiveEmbeddingJob,
  useComputeEmbeddings,
  useInvalidatePendingEmbeddings,
  usePendingEmbeddings,
} from '../hooks/useEmbeddingJob';
import styles from './RecordsPage.module.css';

const VALIDATION_OPTIONS = ['Pending', 'Validated', 'Refused'];
const SUGGEST_KINDS = ['definition', 'proposal', 'rule'];

// Live estimate from the job's OWN observed rate so far (elapsed time /
// items processed), not a pre-configured ms-per-item setting -- the
// Apply/Import ETA mechanism this replaces (Settings > Import Settings,
// removed this same round) was exactly that kind of static config, and
// embeddings have no equivalent knob any more (HR8: nothing hardcoded).
// Returns null until at least one item has been processed (no rate to
// extrapolate from yet) or once nothing remains.
function estimateEmbeddingEtaSeconds(job) {
  if (!job || job.processed_items <= 0 || job.total_items <= 0) return null;
  const remaining = job.total_items - job.processed_items;
  if (remaining <= 0) return 0;
  const elapsedMs = Date.now() - new Date(job.started_at).getTime();
  if (elapsedMs <= 0) return null;
  const msPerItem = elapsedMs / job.processed_items;
  return Math.max(1, Math.ceil((remaining * msPerItem) / 1000));
}
// v1's BRDPTable/useTableLogic used 25 rows/page (see src/hooks/useTableLogic.js)
// -- this docs request specifically asks for 15 here, same prev/next pattern.
const TABLE_PAGE_SIZE = 15;

// rule_status/proposal_status history values are internal keys ("draft",
// "Validated"...) -- translate them through the same i18n tables the live
// fields already use, so the audit trail reads in the same language as
// everything else. Free-text fields (identifier/title/definition/
// proposal) are shown as-is; an empty value reads as an em dash.
const HISTORY_TRANSLATED_FIELDS = {
  rule_status: 'records.rule.states',
  proposal_status: 'records.validationOptions',
  // "status" is the Trash's own delete/restore audit entry (backend:
  // brdps.py's delete_brdp/reset_project_data, trash.py's restore_brdp --
  // all via record_change(..., "status", "active"|"deleted", ...)), not a
  // real BRDP column -- deliberately absent from REVERTIBLE_HISTORY_FIELDS
  // below, since "reverting" a delete/restore means going through the
  // Papelera, not a generic field PATCH.
  status: 'records.history.statusValues',
};

function formatHistoryValue(t, fieldName, value) {
  const prefix = HISTORY_TRANSLATED_FIELDS[fieldName];
  if (prefix) return t(`${prefix}.${value}`, { defaultValue: value });
  return value || '—';
}

// Same local map as ProjectConfigPage.jsx/GenerateBREXdocPage.jsx (not
// centralized -- established convention in this codebase, see CLAUDE.md).
const RULE_STATUS_LABELS = { todo: 'To Do', draft: 'Draft', verified: 'Verified' };

// A hand-authored Rule can be very long (Navantia's Xpath3.0 few-shot
// examples with inline function expressions run well past this) -- rather
// than risk silently blowing max_tokens/context on a huge prompt (HR7:
// never degrade silently), cut it and say so explicitly IN the prompt
// itself, never just drop it.
const ASK_RULE_MAX_CHARS = 6000;

function ruleTextForAsk(state, ruleXml) {
  if (state === 'todo' || !ruleXml) return 'Not yet defined';
  if (ruleXml.length <= ASK_RULE_MAX_CHARS) return ruleXml;
  return `${ruleXml.slice(0, ASK_RULE_MAX_CHARS)}\n[Rule truncated at ${ASK_RULE_MAX_CHARS} characters]`;
}

// Builds the "Ask a Question" system prompt: strictly scoped to the
// selected BRDP (docs request), with its full live context -- including
// Rule/Rule Status, which askGeneric previously never sent at all -- plus
// an optional second BRDP (from Records or the official catalog) when the
// user has picked one to compare against.
function buildAskSystemPrompt(brdp, ruleApproval, compareBrdp, standard) {
  const ruleState = ruleStateOf(ruleApproval);
  let prompt = `You are an S1000D and DITA business-rules expert assistant embedded in
BRDP Manager. You answer questions strictly about the single BRDP shown
below${compareBrdp ? ' (and the BRDP being compared against, if one is shown below)' : ''} — not general questions, not questions about other BRDPs.

If the question is not about this specific BRDP, say so plainly and ask
the user to select the right BRDP (or rephrase) before asking again —
do not attempt to answer a question unrelated to the BRDP below.

Answer in at most 3 short paragraphs — be direct, no padding, no
restating the question back to the user.

When you cite a specific S1000D chapter, DITA element, or specification
detail, only cite ones you're genuinely confident about — say so plainly
if you're not certain rather than inventing a plausible-sounding
reference.

Answer in the same language as the question.

This project uses the standard: ${standard}.
Answer strictly in terms of this standard and version — use its element
names, rule vocabulary and conventions, and do not mix in other versions
of S1000D or DITA unless the user explicitly asks for a comparison.

Current BRDP context:
ID: ${brdp.identifier}
Title: ${brdp.title}
Definition: ${brdp.definition}
Proposal: ${brdp.proposal}
Proposal Status: ${brdp.validation}`;

  if (brdp.validation === 'Refused' && brdp.comments) {
    prompt += `\nRefusal reason: ${brdp.comments}`;
  }

  prompt += `
Rule Status: ${RULE_STATUS_LABELS[ruleState]}
Rule: ${ruleTextForAsk(ruleState, ruleApproval?.rule_xml)}`;

  if (compareBrdp) {
    prompt += `\n\nBRDP being compared against (source: ${
      compareBrdp.source === 'records' ? 'Records' : 'Catalog'
    }):
ID: ${compareBrdp.identifier}
Title: ${compareBrdp.title}
Definition: ${compareBrdp.definition}`;
    if (compareBrdp.source === 'records') {
      prompt += `
Proposal: ${compareBrdp.proposal}
Proposal Status: ${compareBrdp.validation}
Rule Status: ${RULE_STATUS_LABELS[compareBrdp.ruleState]}
Rule: ${ruleTextForAsk(compareBrdp.ruleState, compareBrdp.ruleXml)}`;
    }
    prompt += `\n\nThe user may ask you to compare the current BRDP with the one above; in that case both are in scope.`;
  }

  return prompt;
}

// Suggest Definition's own system prompt (docs request, Suggest Definition
// corpus round) -- a dedicated function, not inline in requestSuggestion,
// same precedent as buildAskSystemPrompt above. Built ENTIRELY from
// /similar's structured `candidates`/`style_references` arrays (never from
// the LLM) -- the reference list the UI renders under the suggestion comes
// from those exact same arrays, so what the user sees always matches what
// the LLM actually saw. `similar`/`styleReferences` entries carry `source`
// already formatted by the backend ("Records: <project name>" / "Catalog"
// -- similar.py's _get_definition_similar), reused verbatim here and in
// the UI rather than reformatted a second, possibly-diverging way.
function buildSuggestDefinitionPrompt(brdp, standard, similar, styleReferences) {
  const referenceBlock = (c) => `Title: ${c.title}\nDefinition: ${c.text}`;

  let prompt = `You are an expert in ${standard} business rules (BRDPs — Business Rule
Decision Points), assisting in BRDP Manager.

Your task: write the Definition for the BRDP below. A Definition states
the decision point — WHAT must be decided and its scope — in neutral,
concise terms. It does not state the chosen answer (that is the
Proposal) and does not describe XML implementation details (that is
the Rule).

Use this project's standard only: ${standard}. Use its terminology and
element names; do not mix in other versions of S1000D or DITA.

`;

  if (similar.length > 0) {
    prompt += `SIMILAR BRDPs — validated decision points closest in meaning to this
one. Follow their style, length and level of detail:
${similar
  .map((c) => `[${c.identifier} | ${c.source} | similarity ${c.score.toFixed(2)}]\n${referenceBlock(c)}`)
  .join('\n\n')}

`;
  }

  if (styleReferences.length > 0) {
    prompt += `STYLE REFERENCES — validated decision points that are DIFFERENT in
content. Use them only to see how Definitions are written in this
standard; do not copy or reuse their content:
${styleReferences.map((c) => `[${c.identifier} | ${c.source}]\n${referenceBlock(c)}`).join('\n\n')}

`;
  }

  if (similar.length === 0 && styleReferences.length === 0) {
    prompt += `No reference BRDPs are available; write the Definition from your
knowledge of ${standard} alone.

`;
  }

  prompt += `Do not cite specification chapter numbers you are not sure of.

LANGUAGE: Write the Definition in the same language as the BRDP's
Title ("${brdp.title}"). This takes priority over everything else — the
reference BRDPs may be in a different language; do not follow theirs.
If the Title language is unclear, use the language of the Proposal.

Return ONLY the Definition text — no preamble, no references list,
no quotes, no markdown.

BRDP to define:
ID: ${brdp.identifier}
Title: ${brdp.title}
Current Definition: ${brdp.definition || 'empty'}
Proposal: ${brdp.proposal || 'empty'}`;

  return prompt;
}

// One row of Suggest Definition's reference list (docs request, readable
// references round): identifier (clickable, toggles the Definition open
// below), Title truncated to one line with the full text in `title=`, the
// origin, and -- only for the "Similar" group, never "Style references" --
// the similarity score. Never navigates anywhere; expand/collapse is pure
// local UI state owned by the parent (several rows can be open at once).
function ReferenceRow({ candidate, showScore, expanded, onToggle }) {
  return (
    <li>
      <div className={styles.referenceRow}>
        <button type="button" className={styles.referenceIdentifierButton} onClick={onToggle}>
          {candidate.identifier}
        </button>
        <span className={styles.referenceTitle} title={candidate.title}>
          — {candidate.title}
        </span>
        <span className={styles.referenceMeta}>
          — {candidate.source}
          {showScore ? ` — ${candidate.score.toFixed(2)}` : ''}
        </span>
      </div>
      {expanded && <div className={styles.referenceDefinition}>{candidate.definition}</div>}
    </li>
  );
}

// Each dot always carries its own state name as title/aria-label (not
// color alone) per the accessibility requirement -- the current step is
// additionally marked via aria-current and a filled style.
function RuleStatusDots({ state }) {
  const { t } = useTranslation();
  const currentIndex = RULE_STATES.indexOf(state);
  return (
    <span className={styles.dots}>
      {RULE_STATES.map((s, i) => (
        <span
          key={s}
          role="img"
          className={`${styles.dot} ${i <= currentIndex ? styles.dotFilled : ''} ${
            i === currentIndex ? styles.dotCurrent : ''
          }`}
          title={t(`records.rule.states.${s}`)}
          aria-label={t(`records.rule.states.${s}`)}
          aria-current={i === currentIndex ? 'step' : undefined}
        />
      ))}
    </span>
  );
}

// Richer variant for the detail panel only (the table keeps the compact
// dots-only RuleStatusDots above): all 3 stage labels are always visible,
// connected by a track line, reached stages filled, the current one
// highlighted with the ATEXIS primary color + a halo. The dot itself
// keeps its own title/aria-label/aria-current -- the visible label text
// is an addition for sighted users, not a replacement for it.
function RuleStatusStepper({ state }) {
  const { t } = useTranslation();
  const currentIndex = RULE_STATES.indexOf(state);
  return (
    <div className={styles.stepper}>
      {RULE_STATES.map((s, i) => {
        const reached = i <= currentIndex;
        const isCurrent = i === currentIndex;
        return (
          <div key={s} className={styles.stepperStep}>
            {i > 0 && (
              <span className={`${styles.stepperLine} ${reached ? styles.stepperLineFilled : ''}`} />
            )}
            <span
              role="img"
              className={`${styles.stepperDot} ${reached ? styles.stepperDotFilled : ''} ${
                isCurrent ? styles.stepperDotCurrent : ''
              }`}
              title={t(`records.rule.states.${s}`)}
              aria-label={t(`records.rule.states.${s}`)}
              aria-current={isCurrent ? 'step' : undefined}
            />
            <span
              className={`${styles.stepperLabel} ${reached ? styles.stepperLabelReached : ''} ${
                isCurrent ? styles.stepperLabelCurrent : ''
              }`}
            >
              {t(`records.rule.states.${s}`)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// Read-only summary for the table column -- the Edit/Verify/Revoke actions
// and the manual rule editor live in the detail panel below, tied to
// whichever row is selected (see the Rule Status section further down).
function RuleStatusCell({ projectId, brdpId, format, refreshToken }) {
  const { t } = useTranslation();
  const [approval, setApproval] = useState(undefined); // undefined = loading, null = none

  useEffect(() => {
    if (!format) return;
    let cancelled = false;
    authFetchJson(`/api/projects/${projectId}/brdps/${brdpId}/approvals/${format}`).then((data) => {
      if (!cancelled) setApproval(data);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, brdpId, format, refreshToken]);

  if (!format) {
    return (
      <span className={styles.muted} title={t('records.rule.unsupportedStandard')}>
        —
      </span>
    );
  }
  if (approval === undefined) return <span className={styles.muted}>…</span>;
  return <RuleStatusDots state={ruleStateOf(approval)} />;
}

export default function RecordsPage() {
  const { t } = useTranslation();
  const { projectId } = useParams();
  const { project } = useOutletContext();
  // project.effective_role is computed server-side (admin already resolved
  // to 'editor' there, docs/v2 §4.3) -- never re-derive the admin bypass here.
  const canEdit = project.effective_role === 'editor';
  const ruleFormat = STANDARD_TO_RULE_FORMAT[project.standard];

  // On-demand embeddings (docs request): Suggest Definition/Proposal/Rule
  // needs real pgvector precedent, so it stays gated behind whatever is
  // still pending for this project or its standard's catalog -- Ask a
  // Question doesn't use embeddings at all and is never gated by this.
  const { data: pendingEmbeddings } = usePendingEmbeddings(projectId);
  const { data: embeddingJob } = useActiveEmbeddingJob(projectId);
  const computeEmbeddings = useComputeEmbeddings(projectId);
  const invalidatePendingEmbeddings = useInvalidatePendingEmbeddings();
  const embeddingJobRunning = embeddingJob?.status === 'running';
  const totalPendingEmbeddings = (pendingEmbeddings?.project_pending ?? 0) + (pendingEmbeddings?.catalog_pending ?? 0);
  const hasPendingEmbeddings = totalPendingEmbeddings > 0;
  const suggestDisabledByEmbeddings = hasPendingEmbeddings || embeddingJobRunning;
  const prevEmbeddingJobStatusRef = useRef(null);

  // Fires exactly once per job completion (not on every poll tick while
  // already completed) -- refreshes the pending count so the banner/button
  // disappears the moment the job that cleared it actually finishes,
  // mirroring ProjectConfigPage's own import-job completion effect.
  useEffect(() => {
    const prevStatus = prevEmbeddingJobStatusRef.current;
    prevEmbeddingJobStatusRef.current = embeddingJob?.status ?? null;
    if (embeddingJob?.status === 'completed' && prevStatus !== 'completed') {
      invalidatePendingEmbeddings(projectId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [embeddingJob?.status]);

  const [brdps, setBrdps] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [tableSearchQuery, setTableSearchQuery] = useState('');
  const [tablePage, setTablePage] = useState(1);
  // '' = "All" -- omitted from the GET /brdps query entirely (no filter),
  // matching Proposal Status's real "validation" values / Rule Status's
  // RULE_STATES keys exactly, so no separate translation layer is needed
  // between the <select>'s value and the API's own query param vocabulary.
  const [proposalStatusFilter, setProposalStatusFilter] = useState('');
  const [ruleStatusFilter, setRuleStatusFilter] = useState('');
  // The project's REAL totals (GET /brdps/stats) for the header summary --
  // deliberately independent of proposalStatusFilter/ruleStatusFilter
  // above (see brdps.py's get_brdp_stats docstring): the header always
  // shows the whole project's counts, never "count of the currently
  // filtered view". Zeroed by default so a brand-new project's header
  // never shows undefined/NaN before the first real fetch resolves.
  const [stats, setStats] = useState({
    proposal_status_counts: { pending: 0, validated: 0, refused: 0 },
    rule_status_counts: { to_do: 0, draft: 0, verified: 0 },
  });
  // null = unsorted (API order). Sorting is applied to the FULL filtered
  // dataset before pagination (docs request), not just the visible page.
  const [sortField, setSortField] = useState(null);
  const [sortDir, setSortDir] = useState('asc');
  const [approvalsRefreshToken, setApprovalsRefreshToken] = useState(0);
  // Every BRDP's rule-approval status for the project's rule format, in
  // one call -- needed to sort the Rule Status column across the full
  // dataset; the table's per-row RuleStatusCell keeps fetching its own
  // status independently for display, this is only for sorting.
  const [ruleApprovalsById, setRuleApprovalsById] = useState({});

  // Add BRDP creation flow -- opens this panel instead of creating
  // directly from a bare identifier field (docs request: new dedicated
  // flow). newBrdpIdentifier is null while the next-EXT id is loading;
  // once a catalog entry is picked it holds that real identifier instead,
  // but stays just as locked either way -- only Title/Definition become
  // genuinely editable after a catalog pick (they're already editable,
  // just blank, before one).
  const [isCreatingNew, setIsCreatingNew] = useState(false);
  const [newBrdpIdentifier, setNewBrdpIdentifier] = useState(null);
  const [newBrdpTitle, setNewBrdpTitle] = useState('');
  const [newBrdpDefinition, setNewBrdpDefinition] = useState('');
  const [newBrdpProposal, setNewBrdpProposal] = useState('');
  const [newBrdpProposalStatus, setNewBrdpProposalStatus] = useState('Pending');
  const [catalogEntries, setCatalogEntries] = useState([]);
  const [catalogSearchQuery, setCatalogSearchQuery] = useState('');
  const [creatingBusy, setCreatingBusy] = useState(false);
  const [createError, setCreateError] = useState(null);

  const [aiProvider, setAiProvider] = useState(null);
  // `question` is only ever the live DRAFT in the textarea -- it auto-
  // clears on a successful answer (docs request: feel like a mini
  // conversation, not a submitted form) and is intentionally left alone on
  // error, so the user never loses what they typed. The exchange actually
  // shown/asked lives in the fields below, decoupled from the draft.
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [askError, setAskError] = useState(null);
  // The question belonging to the CURRENTLY DISPLAYED exchange (pending,
  // answered, or errored) -- null when there's nothing to show yet. Only
  // one exchange is ever shown, matching the one-turn chaining already in
  // place: what's on screen and what's sent to the LLM as history must
  // always be the same single turn.
  const [lastAsked, setLastAsked] = useState(null);
  // True only while THIS specific request is in flight -- kept separate
  // from `busy` (the Ask panel's own send-button/Enter-key guard) so the
  // "Thinking…" indicator and the disabled button track slightly
  // different things. Suggest no longer shares `busy` at all (docs
  // request, per-BRDP suggestion round below) -- it has its own per-entry
  // `loading` flag in suggestionsByBrdpId.
  const [askPending, setAskPending] = useState(false);
  // The single previous Ask turn ({ question, answer }), or null -- one
  // turn of chaining only (docs request), not unlimited history, so cost
  // and context stay bounded. Set only on a SUCCESSFUL answer (an errored
  // question never becomes something the LLM "remembers"). Cleared by
  // Clear or by switching BRDP.
  const [prevTurn, setPrevTurn] = useState(null);
  // "+ Compare with another BRDP": collapsed by default. compareBrdp holds
  // the chosen entry ({ source: 'records'|'catalog', identifier, title,
  // definition, and for 'records' also proposal/validation/ruleState/
  // ruleXml }) or null. compareCatalogEntries is fetched lazily, once,
  // the first time the search opens (same lazy-load pattern as Add BRDP's
  // catalog picker) -- it's global reference data keyed only by the
  // project's standard, so it stays valid across switching BRDPs and
  // doesn't need to be refetched per selection.
  const [compareOpen, setCompareOpen] = useState(false);
  const [compareQuery, setCompareQuery] = useState('');
  const [compareCatalogEntries, setCompareCatalogEntries] = useState([]);
  const [compareBrdp, setCompareBrdp] = useState(null);
  const [compareBusy, setCompareBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  // Suggest: one pending/loaded suggestion PER BRDP, kept until Accept or
  // Discard (docs request -- the suggestion belongs to the BRDP it was
  // requested for and survives switching rows; the previous round's
  // "clear on BRDP change" behavior is explicitly reversed here). Keyed by
  // brdpId, at most one entry per BRDP -- while an entry exists (loading
  // or resolved) for the SELECTED BRDP, all three Suggest buttons are
  // disabled (see the button row below); regenerating the same kind
  // requires Discard first. In memory only, never localStorage (HR1) --
  // lost on reload/logout, and explicitly emptied on project change
  // (below). Each entry is one of:
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
  // again, which is exactly the "stuck forever" failure this design must
  // avoid (docs request's explicit edge case for the error entry, applied
  // here to the notice entry for the same reason).
  const [suggestionsByBrdpId, setSuggestionsByBrdpId] = useState(new Map());
  // Per-brdpId request generation counter -- bumped ONLY when a NEW
  // request starts for that brdpId (never by Accept/Discard). A late
  // response only commits if BOTH still hold at the time it arrives: (a)
  // the map still has an entry for that brdpId -- false if it was removed
  // by Accept/Discard/BRDP-delete/project-change, in which case it must
  // never resurrect a removed entry; (b) this ref's counter for that
  // brdpId still equals the token captured when the request started --
  // false if a NEWER request for the SAME brdpId has since begun (e.g.
  // Discard unblocked it and the user asked again before the old response
  // landed). Both checks are needed: (a) alone would let an old response
  // overwrite a newer request's still-loading entry; (b) alone would
  // resurrect an entry that was legitimately removed with no new request
  // following it. A soft cancel, since authFetchJson/sendMessage don't
  // expose real mid-flight cancellation here.
  const suggestGenerationRef = useRef(new Map());
  const selectedSuggestion = selectedId ? suggestionsByBrdpId.get(selectedId) || null : null;

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
  // below the row -- several can be open at once. Now lives INSIDE each
  // BRDP's suggestion entry (not a page-wide Set) so it travels with that
  // entry when switching rows and back, same as the rest of the entry.
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
  // Suggest Definition catalog guard (docs request, Suggest Definition
  // corpus round): identifiers of this standard's official catalog,
  // fetched once per project (eagerly, unlike catalogEntries/
  // compareCatalogEntries above which only load lazily when their own
  // panel opens) -- needed as soon as a row is selected, to decide
  // whether to disable the button at all, not just when a picker is open.
  const [catalogIdentifierSet, setCatalogIdentifierSet] = useState(new Set());

  // Rule Status stepper state for the SELECTED BRDP -- the manual editor
  // and Edit/Verify/Revoke actions live here in the detail panel (v1's
  // large plain-text editor), not in the table cell above.
  const [ruleApproval, setRuleApproval] = useState(undefined); // undefined = loading, null = none
  const [ruleEditing, setRuleEditing] = useState(false);
  // Read-only view of the saved rule_xml while Verified -- the only state
  // where the actual rule text was otherwise invisible without Revoke
  // first (docs request). Available to viewer AND editor alike, same
  // criterion as being able to see the stepper at all: this never writes
  // anything, it only reads what's already there.
  const [rulePreviewOpen, setRulePreviewOpen] = useState(false);
  const [ruleDraftText, setRuleDraftText] = useState('');
  const [ruleBusy, setRuleBusy] = useState(false);
  const [ruleValidationError, setRuleValidationError] = useState(null);
  // Distinct from ruleValidationError above: that one is ONLY for the
  // client-side checkWellFormed() pre-check (and reuses its "Not
  // well-formed XML: {error}" template, which is accurate there). This one
  // is for whatever the PUT call itself fails with -- a 500, a 502, a
  // network error, anything -- and is shown as the server's own message
  // verbatim, with no added label. Conflating the two used to mean a
  // completely unrelated server error (e.g. a missing DB table) rendered
  // as "Not well-formed XML: Internal Server Error", which is actively
  // misleading about the real cause.
  const [ruleSaveError, setRuleSaveError] = useState(null);

  // Real per-field audit trail for the selected BRDP (GET .../history) --
  // refetched whenever the selection changes or historyRefreshToken is
  // bumped by a successful field edit or rule-status transition.
  const [history, setHistory] = useState([]);
  const [historyRefreshToken, setHistoryRefreshToken] = useState(0);

  // proposalStatusFilter/ruleStatusFilter reduce the result set in SQL
  // itself (brdps.py's list_brdps -> list_active_brdps), not just in this
  // page's already-existing client-side filteredBrdps/pagedBrdps below --
  // a real, if partial, server-side row-count reduction. Unfiltered
  // ('' for both) is unchanged from before: the full project list, still
  // paginated client-side.
  const refresh = () => {
    const params = new URLSearchParams();
    if (proposalStatusFilter) params.set('proposal_status', proposalStatusFilter);
    if (ruleStatusFilter) params.set('rule_status', ruleStatusFilter);
    const qs = params.toString();
    return authFetchJson(`/api/projects/${projectId}/brdps${qs ? `?${qs}` : ''}`).then((data) => {
      setBrdps(data);
      setIsLoading(false);
    });
  };

  // Always the project's REAL, unfiltered totals (GET .../stats never takes
  // proposalStatusFilter/ruleStatusFilter) -- the header summary must never
  // read as "count of the currently filtered view".
  const refreshStats = () =>
    authFetchJson(`/api/projects/${projectId}/brdps/stats`).then(setStats).catch(() => {});

  useEffect(() => {
    setProposalStatusFilter('');
    setRuleStatusFilter('');
    authFetchJson('/api/config/ai-provider').then(setAiProvider).catch(() => setAiProvider(null));
    authFetchJson(`/api/brdp-catalog?standard=${encodeURIComponent(project.standard)}`)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    refresh();
    refreshStats();
    setTablePage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, proposalStatusFilter, ruleStatusFilter]);

  // Rule Status counts in the header can change from a rule-approval
  // action (Verify/Revoke/manual save/accepted suggestion) alone, with no
  // BRDP field PUT and therefore no other refresh() call site touching it
  // -- approvalsRefreshToken is already the shared signal those actions
  // bump today (see RuleStatusCell/the detail panel's own fetch above).
  useEffect(() => {
    refreshStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approvalsRefreshToken]);

  const selected = brdps.find((b) => b.id === selectedId) || null;

  const handleTableSearchChange = (value) => {
    setTableSearchQuery(value);
    setTablePage(1);
  };

  // Clicking a column header: same column toggles direction, a different
  // one starts fresh at ascending (matches the search box's own "reset to
  // page 1 on any change" behavior above).
  const toggleSort = (field) => {
    if (sortField === field) {
      setSortDir((dir) => (dir === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('asc');
    }
    setTablePage(1);
  };

  // Proposal Status and Rule Status have a natural workflow order, not an
  // alphabetical one (docs request: alphabetical would give
  // Pending/Refused/Validated, which follows no real logic) -- VALIDATION_
  // OPTIONS/RULE_STATES above are already declared in that flow order, so
  // sorting is just each value's position in that array.
  const compareByFlowOrder = (order, a, b) => order.indexOf(a) - order.indexOf(b);

  const filteredBrdps = brdps.filter((b) => {
    const q = tableSearchQuery.trim().toLowerCase();
    if (!q) return true;
    return b.identifier.toLowerCase().includes(q) || (b.title || '').toLowerCase().includes(q);
  });

  const sortedBrdps = !sortField
    ? filteredBrdps
    : [...filteredBrdps].sort((a, b) => {
        let cmp;
        if (sortField === 'identifier') cmp = a.identifier.localeCompare(b.identifier);
        else if (sortField === 'title') cmp = (a.title || '').localeCompare(b.title || '');
        else if (sortField === 'validation') cmp = compareByFlowOrder(VALIDATION_OPTIONS, a.validation, b.validation);
        else if (sortField === 'ruleStatus') {
          cmp = compareByFlowOrder(
            RULE_STATES,
            ruleStateOf(ruleApprovalsById[a.id] ?? null),
            ruleStateOf(ruleApprovalsById[b.id] ?? null)
          );
        } else cmp = 0;
        return sortDir === 'asc' ? cmp : -cmp;
      });

  const tableTotalPages = Math.max(1, Math.ceil(sortedBrdps.length / TABLE_PAGE_SIZE));
  const pagedBrdps = sortedBrdps.slice(
    (tablePage - 1) * TABLE_PAGE_SIZE,
    tablePage * TABLE_PAGE_SIZE
  );

  // Safety net for anything that shrinks the row count out from under the
  // current page without going through handleTableSearchChange's explicit
  // reset -- most notably deleting the last row on the last page (docs
  // request: must not strand the user on an empty "page 2 of 1").
  useEffect(() => {
    setTablePage((p) => Math.min(p, tableTotalPages));
  }, [tableTotalPages]);

  // Bulk fetch for the Rule Status column's sort -- refetched whenever an
  // Edit/Verify/Revoke action bumps approvalsRefreshToken, same trigger
  // RuleStatusCell/the detail panel's own rule-status fetch already use.
  // A standard without a rule format (e.g. DITA) just gets an empty map,
  // so sorting by Rule Status there is a harmless no-op (every row reads
  // as "todo", same as the column already shows "—" for them).
  useEffect(() => {
    if (!ruleFormat) {
      setRuleApprovalsById({});
      return;
    }
    let cancelled = false;
    authFetchJson(`/api/projects/${projectId}/approvals/${ruleFormat}`)
      .then((rows) => {
        if (cancelled) return;
        const byId = {};
        for (const row of rows) byId[row.brdp_id] = { status: row.status };
        setRuleApprovalsById(byId);
      })
      .catch(() => {
        if (!cancelled) setRuleApprovalsById({});
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, ruleFormat, approvalsRefreshToken]);

  useEffect(() => {
    setRuleEditing(false);
    setRulePreviewOpen(false);
    if (!selected || !ruleFormat) {
      setRuleApproval(undefined);
      return;
    }
    let cancelled = false;
    authFetchJson(`/api/projects/${projectId}/brdps/${selected.id}/approvals/${ruleFormat}`).then((data) => {
      if (!cancelled) setRuleApproval(data);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, ruleFormat, approvalsRefreshToken]);

  // Bug fix (docs request): switching the selected BRDP must reset the Ask
  // panel entirely -- previously `answer`/`question` just sat there, so a
  // stale answer (built from and about the PREVIOUS BRDP's context) stayed
  // visible, and the next question would have chained onto it as if it
  // were still about the newly selected BRDP.
  //
  // Suggest Definition/Proposal/Rule is deliberately NOT reset here any
  // more (docs request, "la sugerencia se queda en su BRDP hasta
  // aceptarla o descartarla"): a previous round reset it on every
  // selection change, which avoided writing to the wrong BRDP but also
  // threw away real LLM work the moment the user glanced at another row.
  // Suggest state now lives in suggestionsByBrdpId, keyed by brdpId, and
  // is left completely untouched by switching the selection -- reselecting
  // a BRDP with a pending or resolved entry simply shows it again, with
  // the Suggest buttons still blocked, exactly as it was left.
  useEffect(() => {
    setQuestion('');
    setAnswer('');
    setAskError(null);
    setLastAsked(null);
    setPrevTurn(null);
    setCompareOpen(false);
    setCompareQuery('');
    setCompareBrdp(null);
  }, [selected?.id]);

  useEffect(() => {
    if (!selected) {
      setHistory([]);
      return;
    }
    let cancelled = false;
    authFetchJson(`/api/projects/${projectId}/brdps/${selected.id}/history`).then((data) => {
      if (!cancelled) setHistory(data);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, historyRefreshToken]);

  const openRuleEditor = () => {
    setRuleDraftText(ruleApproval?.rule_xml || '');
    setRuleValidationError(null);
    setRuleSaveError(null);
    setRuleEditing(true);
  };

  const cancelRuleEditor = () => {
    setRuleValidationError(null);
    setRuleSaveError(null);
    setRuleEditing(false);
  };

  // The manual editor is a write path into rule_approvals that bypasses
  // the generation engine entirely, so it also bypasses the engine's own
  // checkWellFormed() safety net (docs/v2 CLAUDE.md) -- without this check
  // a broken tag would surface silently, later, inside a generated
  // BREX/Schematron document instead of here at save time. Reuses the
  // engine's own helper (never duplicated) rather than re-implementing
  // XML parsing; the backend enforces the same rule server-side too.
  const saveRuleEditor = async () => {
    const wellFormed = checkWellFormed(ruleDraftText);
    if (!wellFormed.valid) {
      setRuleValidationError(wellFormed.error);
      return;
    }
    setRuleValidationError(null);
    setRuleSaveError(null);
    setRuleBusy(true);
    try {
      await authFetchJson(`/api/projects/${projectId}/brdps/${selected.id}/approvals/${ruleFormat}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rule_xml: ruleDraftText, source: 'manual', status: 'pending_review' }),
      });
      setRuleEditing(false);
      setApprovalsRefreshToken((n) => n + 1);
      setHistoryRefreshToken((n) => n + 1);
    } catch (err) {
      // Whatever the PUT itself failed with -- the backend's own 422 for a
      // well-formedness rejection already reads as "rule_xml is not
      // well-formed XML: ..." on its own, and any other error (500, 502,
      // network) is shown exactly as the server reported it. Never route
      // this through ruleValidationError/its "Not well-formed XML:"
      // template -- that mislabels an unrelated server error as an XML
      // problem.
      setRuleSaveError(err.message);
    } finally {
      setRuleBusy(false);
    }
  };

  const verifyRule = async () => {
    setRuleBusy(true);
    try {
      await authFetchJson(`/api/projects/${projectId}/brdps/${selected.id}/approvals/${ruleFormat}/approve`, {
        method: 'POST',
      });
      setApprovalsRefreshToken((n) => n + 1);
      setHistoryRefreshToken((n) => n + 1);
    } finally {
      setRuleBusy(false);
    }
  };

  const revokeRule = async () => {
    setRuleBusy(true);
    try {
      await authFetchJson(`/api/projects/${projectId}/brdps/${selected.id}/approvals/${ruleFormat}/revoke`, {
        method: 'POST',
      });
      setApprovalsRefreshToken((n) => n + 1);
      setHistoryRefreshToken((n) => n + 1);
    } finally {
      setRuleBusy(false);
    }
  };

  const openCreatePanel = () => {
    setSelectedId(null);
    setIsCreatingNew(true);
    setCreateError(null);
    setNewBrdpIdentifier(null); // loading, until next-ext-identifier resolves
    setNewBrdpTitle('');
    setNewBrdpDefinition('');
    setNewBrdpProposal('');
    setNewBrdpProposalStatus('Pending');
    setCatalogSearchQuery('');
    setCatalogEntries([]);
    authFetchJson(`/api/projects/${projectId}/brdps/next-ext-identifier`).then((data) =>
      setNewBrdpIdentifier(data.identifier)
    );
    // Global reference data (not project-scoped) -- naturally empty for a
    // standard with no imported catalog, which is exactly how the picker
    // section below decides whether to render at all.
    authFetchJson(`/api/brdp-catalog?standard=${encodeURIComponent(project.standard)}`)
      .then(setCatalogEntries)
      .catch(() => setCatalogEntries([]));
  };

  const closeCreatePanel = () => setIsCreatingNew(false);

  const chooseCatalogEntry = (entry) => {
    setNewBrdpIdentifier(entry.identifier);
    setNewBrdpTitle(entry.title);
    setNewBrdpDefinition(entry.definition);
  };

  const saveNewBrdp = async () => {
    if (!newBrdpIdentifier) return;
    setCreatingBusy(true);
    setCreateError(null);
    try {
      const created = await authFetchJson(`/api/projects/${projectId}/brdps`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: newBrdpIdentifier,
          title: newBrdpTitle,
          definition: newBrdpDefinition,
          proposal: newBrdpProposal,
          validation: newBrdpProposalStatus,
        }),
      });
      setIsCreatingNew(false);
      await refresh();
      refreshStats();
      setSelectedId(created.id);
    } catch (err) {
      // (project_id, identifier) uniqueness is enforced server-side --
      // the catalog picker already excludes identifiers the project has,
      // this is the safety net for whatever slips through (docs request).
      setCreateError(err.message);
    } finally {
      setCreatingBusy(false);
    }
  };

  const handleUpdate = async (brdpId, patch) => {
    await authFetchJson(`/api/projects/${projectId}/brdps/${brdpId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    setHistoryRefreshToken((n) => n + 1);
    refresh();
    refreshStats();
  };

  // Fields to consider for a History "Revert to this" action -- scoped to
  // the simple text fields with real per-field history (docs request):
  // rule_status has its own Revoke mechanism already and must not be mixed
  // with this one. Maps the audit trail's field_name label to the DB
  // column handleUpdate expects (only proposal_status differs, since the
  // column is "validation").
  const REVERTIBLE_HISTORY_FIELDS = {
    title: 'title',
    definition: 'definition',
    proposal: 'proposal',
    proposal_status: 'validation',
  };

  // Reverting restores the field to old_value (the value immediately
  // BEFORE this entry's change), i.e. classic undo semantics -- confirmed
  // with the user. This is a normal PUT through handleUpdate, so it flows
  // through record_change() like any other edit and produces its own new
  // history row; nothing about the original entry is touched.
  const revertHistoryEntry = (entry) => {
    const column = REVERTIBLE_HISTORY_FIELDS[entry.field_name];
    if (!column || !selected) return;
    handleUpdate(selected.id, { [column]: entry.old_value });
  };

  const handleDelete = async (brdpId, identifier) => {
    if (!window.confirm(t('records.deleteConfirm', { identifier }))) return;
    await authFetchJson(`/api/projects/${projectId}/brdps/${brdpId}`, { method: 'DELETE' });
    if (selectedId === brdpId) setSelectedId(null);
    // Docs request edge case: deleting a BRDP with a pending/loaded
    // suggestion removes it from the map immediately -- if a request was
    // still in flight for it, requestSuggestion's own existence check
    // (the map no longer has this brdpId) discards the response when it
    // eventually lands, instead of resurrecting an entry for a BRDP that
    // no longer exists.
    removeSuggestionEntry(brdpId);
    refresh();
    refreshStats();
  };

  // The Ask panel only ever renders inside the `selected` branch of the
  // detail panel (see the JSX below), so `selected` is always set here --
  // no `selected ?` guard needed the way the old context-string ever had.
  const askGeneric = async () => {
    if (!question.trim() || !aiProvider || !selected) return;
    const askedQuestion = question;
    setBusy(true);
    setAskPending(true);
    // Shown immediately (docs request: "mostrar la pregunta enviada ya en
    // la zona de intercambio con un indicador de carga") -- and this is
    // also the point where the exchange on screen switches to the NEW
    // question, replacing whatever was shown before, matching exactly what
    // gets sent as history below (only ever one turn, never both).
    setLastAsked(askedQuestion);
    setAnswer('');
    setAskError(null);
    try {
      const systemPrompt = buildAskSystemPrompt(selected, ruleApproval, compareBrdp, project.standard);
      // One turn of chaining (docs request): the previous Q/A, if any,
      // goes in first as real conversation history so a follow-up like
      // "and why?" resolves correctly, then the new question.
      const messages = [];
      if (prevTurn) {
        messages.push({ role: 'user', content: prevTurn.question });
        messages.push({ role: 'assistant', content: prevTurn.answer });
      }
      messages.push({ role: 'user', content: askedQuestion });

      const res = await sendMessage(messages, null, aiProvider.model, aiProvider.provider, systemPrompt);
      setAnswer(res.content);
      setPrevTurn({ question: askedQuestion, answer: res.content });
      // Auto-clear on success only (docs request) -- an errored question
      // stays in the textarea below so the user never loses what they typed.
      setQuestion('');
    } catch (err) {
      setAskError(err.message);
    } finally {
      setBusy(false);
      setAskPending(false);
    }
  };

  const clearAsk = () => {
    setAnswer('');
    setAskError(null);
    setLastAsked(null);
    setPrevTurn(null);
  };

  const openCompareSearch = () => {
    setCompareOpen(true);
    if (compareCatalogEntries.length === 0) {
      // Global reference data, not project-scoped (same source/pattern as
      // openCreatePanel's catalog fetch above) -- fetched once, lazily, the
      // first time the search actually opens.
      authFetchJson(`/api/brdp-catalog?standard=${encodeURIComponent(project.standard)}`)
        .then(setCompareCatalogEntries)
        .catch(() => setCompareCatalogEntries([]));
    }
  };

  const closeCompareSearch = () => {
    setCompareOpen(false);
    setCompareQuery('');
  };

  // Rule Status/Rule for a Records candidate live in rule_approvals, not on
  // the BRDP row itself (same architecture as the stepper above) -- the
  // bulk-fetched ruleApprovalsById only carries `status` (enough to sort
  // by), not `rule_xml`, so a dedicated fetch is needed here, same endpoint
  // and shape the main ruleApproval effect above already uses.
  const chooseCompareBrdp = async (candidate) => {
    if (candidate.source === 'catalog') {
      const { entry } = candidate;
      setCompareBrdp({ source: 'catalog', identifier: entry.identifier, title: entry.title, definition: entry.definition });
      closeCompareSearch();
      return;
    }
    const { entry } = candidate;
    setCompareBusy(true);
    try {
      const approval = ruleFormat
        ? await authFetchJson(`/api/projects/${projectId}/brdps/${entry.id}/approvals/${ruleFormat}`)
        : null;
      setCompareBrdp({
        source: 'records',
        identifier: entry.identifier,
        title: entry.title,
        definition: entry.definition,
        proposal: entry.proposal,
        validation: entry.validation,
        ruleState: ruleStateOf(approval),
        ruleXml: approval?.rule_xml ?? null,
      });
    } finally {
      setCompareBusy(false);
    }
    closeCompareSearch();
  };

  const clearCompareBrdp = () => setCompareBrdp(null);

  // docs/v2 §3: real few-shot precedent from the project's own validated
  // BRDPs, via GET .../similar (pure data, no LLM call in the backend --
  // §4's "FastAPI never builds prompts" rule). §3 point 3 (HR7): when
  // /similar itself reports insufficient precedent, show that verbatim
  // and stop -- never fall back to a no-few-shot LLM call, which is
  // exactly the Phase-4 behavior this replaces. The notice text itself is
  // built here from structured data (candidate count), not relayed
  // verbatim from the backend's English `message` field, so it can be
  // translated like everything else on this page.
  const requestSuggestion = async (kind) => {
    if (!selected || !aiProvider) return;
    const brdpId = selected.id;
    // Defense in depth (docs request): the button is already disabled
    // whenever this BRDP has any entry, loading or resolved -- "para
    // regenerar, primero Discard". Each BRDP's block is independent.
    if (suggestionsByBrdpId.has(brdpId)) return;

    // Bumped ONLY here, never by Accept/Discard -- see the declaration of
    // suggestGenerationRef above for why both this token check AND the
    // map-existence check in commit() below are needed.
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
      // no MIN_CANDIDATES gate) -- diverges completely from proposal/rule
      // below, which are untouched by this round.
      if (kind === 'definition') {
        const referenceSimilar = similar.candidates;
        const referenceStyle = similar.style_references || [];
        const systemPrompt = buildSuggestDefinitionPrompt(selected, project.standard, referenceSimilar, referenceStyle);
        const res = await sendMessage(
          [{ role: 'user', content: 'Write the Definition for this BRDP.' }],
          null,
          aiProvider.model,
          aiProvider.provider,
          systemPrompt,
          { temperature: 0.3 }
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
      // Discard (rendered below) so the BRDP's Suggest buttons don't stay
      // blocked forever -- the user can discard and retry.
      commit({ brdpId, kind, loading: false, error: err.message, expandedReferenceIds: new Set() });
    }
  };

  // Editor-only (backend enforces this too -- see embedding_jobs.py's
  // require_project_role('editor')): launches the background job. 409 (a
  // second editor already started one, docs request's own edge case) reads
  // fine as-is from the backend's own detail message via computeEmbeddings
  // .error; the mutation always invalidates the job query on settle
  // either way, so the UI reflects whatever IS actually running.
  const handleComputeEmbeddings = () => computeEmbeddings.mutate();

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
    // too before writing anything, same principle as the previous round's
    // guard (kept even though the lookup itself already makes a mismatch
    // essentially unreachable).
    if (entry.brdpId !== selected.id) return;
    if (entry.kind === 'rule') {
      await authFetchJson(`/api/projects/${projectId}/brdps/${selected.id}/approvals/${entry.format}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rule_xml: entry.text, source: 'llm', status: 'pending_review' }),
      });
      setApprovalsRefreshToken((n) => n + 1);
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

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>{t('nav.records')}</h1>
          <p className={styles.subtitle}>
            {t('records.subtitle', { name: project.name, standard: project.standard, count: brdps.length })}
          </p>
        </div>
        <div className={styles.headerActions}>
          <ProposalStatusSummary counts={stats.proposal_status_counts} />
          <RuleStatusSummary counts={stats.rule_status_counts} />
        </div>
      </div>

      <div className={styles.layout}>
        <div className={styles.tableWrap}>
          <div className={styles.createForm}>
            <input
              value={tableSearchQuery}
              onChange={(e) => handleTableSearchChange(e.target.value)}
              placeholder={t('records.searchPlaceholder')}
            />
            {canEdit && (
              <button type="button" onClick={openCreatePanel}>
                {t('records.addButton')}
              </button>
            )}
          </div>

          <div className={styles.tableScroll}>
            {isLoading ? (
              <p>…</p>
            ) : (
              <table className={styles.table}>
                <colgroup>
                  <col className={styles.colId} />
                  <col />
                  <col className={styles.colValidation} />
                  <col className={styles.colRuleStatus} />
                  {canEdit && <col className={styles.colActions} />}
                </colgroup>
                <thead>
                  <tr>
                    <SortableHeader field="identifier" sortField={sortField} sortDir={sortDir} onSort={toggleSort}>
                      {t('records.table.id')}
                    </SortableHeader>
                    <SortableHeader field="title" sortField={sortField} sortDir={sortDir} onSort={toggleSort}>
                      {t('records.table.title')}
                    </SortableHeader>
                    <SortableHeader field="validation" sortField={sortField} sortDir={sortDir} onSort={toggleSort}>
                      {t('records.table.validation')}
                    </SortableHeader>
                    <SortableHeader field="ruleStatus" sortField={sortField} sortDir={sortDir} onSort={toggleSort}>
                      {t('records.table.ruleStatus')}
                    </SortableHeader>
                    {canEdit && <th className={styles.plainHeader}></th>}
                  </tr>
                  {/* Filters live in a second header row, in the SAME table as
                      the columns they filter -- the colgroup above is the only
                      thing that has to agree with itself for these to stay
                      aligned with Proposal Status/Rule Status, unlike the old
                      layout (two separate flex rows whose widths had to be
                      kept in sync by coincidence, which broke under longer
                      Spanish option text). */}
                  <tr className={styles.filterRow}>
                    <th className={styles.plainHeader} colSpan={2}></th>
                    <th className={styles.filterHeaderCell}>
                      <select
                        className={styles.filterSelect}
                        value={proposalStatusFilter}
                        onChange={(e) => setProposalStatusFilter(e.target.value)}
                        aria-label={t('records.filters.proposalStatusLabel')}
                        title={t('records.filters.proposalStatusLabel')}
                      >
                        <option value="">{t('records.filters.all')}</option>
                        {VALIDATION_OPTIONS.map((v) => (
                          <option key={v} value={v}>
                            {t(`records.validationOptions.${v}`)}
                          </option>
                        ))}
                      </select>
                    </th>
                    <th className={styles.filterHeaderCell}>
                      <select
                        className={styles.filterSelect}
                        value={ruleStatusFilter}
                        onChange={(e) => setRuleStatusFilter(e.target.value)}
                        aria-label={t('records.filters.ruleStatusLabel')}
                        title={t('records.filters.ruleStatusLabel')}
                      >
                        <option value="">{t('records.filters.all')}</option>
                        {RULE_STATES.map((s) => (
                          <option key={s} value={s}>
                            {t(`records.rule.states.${s}`)}
                          </option>
                        ))}
                      </select>
                    </th>
                    {canEdit && <th className={styles.plainHeader}></th>}
                  </tr>
                </thead>
                <tbody>
                  {pagedBrdps.map((b) => (
                    <tr
                      key={b.id}
                      className={selectedId === b.id ? styles.selectedRow : ''}
                      onClick={() => setSelectedId(b.id)}
                    >
                      <td className={styles.mono}>
                        {b.identifier}
                        {suggestionsByBrdpId.has(b.id) && (
                          <span
                            className={styles.pendingSuggestionIcon}
                            title={t('records.assistant.pendingSuggestionIndicator', {
                              kind: t(`records.assistant.kindLabels.${suggestionsByBrdpId.get(b.id).kind}`),
                            })}
                          >
                            ✨
                          </span>
                        )}
                      </td>
                      <td className={styles.titleCell} title={b.title || undefined}>
                        {b.title || <span className={styles.muted}>—</span>}
                      </td>
                      <td>
                        <span
                          className={styles[`badge_${b.validation}`] || ''}
                          title={b.validation === 'Refused' && b.comments ? b.comments : undefined}
                        >
                          {t(`records.validationOptions.${b.validation}`, { defaultValue: b.validation })}
                        </span>
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <RuleStatusCell
                          projectId={projectId}
                          brdpId={b.id}
                          format={ruleFormat}
                          refreshToken={approvalsRefreshToken}
                        />
                      </td>
                      {canEdit && (
                        <td onClick={(e) => e.stopPropagation()}>
                          <button onClick={() => handleDelete(b.id, b.identifier)} aria-label={t('records.deleteAria', { identifier: b.identifier })}>
                            <Trash2 size={14} />
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {!isLoading && (
            <div className={styles.tableFooter}>
              <div className={styles.tableFooterInfo}>
                {t('records.pagination.info', {
                  count: filteredBrdps.length,
                  page: tablePage,
                  totalPages: tableTotalPages,
                })}
              </div>
              <div className={styles.pagination}>
                <button
                  type="button"
                  className={styles.paginationBtn}
                  onClick={() => setTablePage((p) => p - 1)}
                  disabled={tablePage === 1}
                >
                  {t('records.pagination.previous')}
                </button>
                <button
                  type="button"
                  className={styles.paginationBtn}
                  onClick={() => setTablePage((p) => p + 1)}
                  disabled={tablePage === tableTotalPages}
                >
                  {t('records.pagination.next')}
                </button>
              </div>
            </div>
          )}
        </div>

        <div className={styles.detailPanel}>
          {isCreatingNew ? (
            <>
              <label className={styles.fieldLabel}>{t('records.fieldId')}</label>
              <input className={styles.input} value={newBrdpIdentifier ?? '…'} disabled />

              <label className={styles.fieldLabel}>{t('records.fieldTitle')}</label>
              <input
                className={styles.input}
                value={newBrdpTitle}
                onChange={(e) => setNewBrdpTitle(e.target.value)}
              />

              <label className={styles.fieldLabel}>{t('records.fieldDefinition')}</label>
              <textarea
                className={styles.textarea}
                value={newBrdpDefinition}
                onChange={(e) => setNewBrdpDefinition(e.target.value)}
              />

              <label className={styles.fieldLabel}>{t('records.fieldProposal')}</label>
              <textarea
                className={styles.textarea}
                value={newBrdpProposal}
                onChange={(e) => setNewBrdpProposal(e.target.value)}
              />

              <label className={styles.fieldLabel}>{t('records.fieldValidation')}</label>
              <select
                className={styles.select}
                value={newBrdpProposalStatus}
                onChange={(e) => setNewBrdpProposalStatus(e.target.value)}
              >
                {VALIDATION_OPTIONS.map((v) => (
                  <option key={v} value={v}>
                    {t(`records.validationOptions.${v}`)}
                  </option>
                ))}
              </select>

              {catalogEntries.length > 0 && (() => {
                const existingIdentifiers = new Set(brdps.map((b) => b.identifier));
                const q = catalogSearchQuery.trim().toLowerCase();
                const matches = catalogEntries
                  .filter((entry) => !existingIdentifiers.has(entry.identifier))
                  .filter(
                    (entry) =>
                      !q || entry.identifier.toLowerCase().includes(q) || entry.title.toLowerCase().includes(q)
                  );
                return (
                  <div className={styles.catalogPicker}>
                    <label className={styles.fieldLabel}>{t('records.newBrdp.catalogSectionTitle')}</label>
                    <input
                      className={styles.input}
                      value={catalogSearchQuery}
                      onChange={(e) => setCatalogSearchQuery(e.target.value)}
                      placeholder={t('records.searchPlaceholder')}
                    />
                    <ul className={styles.catalogList}>
                      {matches.length === 0 && <li className={styles.muted}>{t('records.newBrdp.catalogEmpty')}</li>}
                      {matches.slice(0, 50).map((entry) => (
                        <li key={entry.id} className={styles.catalogItem}>
                          <div className={styles.catalogItemHeader}>
                            <span className={styles.mono}>{entry.identifier}</span>
                            <button type="button" onClick={() => chooseCatalogEntry(entry)}>
                              {t('records.newBrdp.catalogChoose')}
                            </button>
                          </div>
                          <div className={styles.catalogItemTitle}>{entry.title}</div>
                        </li>
                      ))}
                    </ul>
                    {matches.length > 50 && (
                      <p className={styles.hint}>{t('records.newBrdp.catalogTruncated', { count: matches.length })}</p>
                    )}
                  </div>
                );
              })()}

              {createError && (
                <p className={styles.ruleErrorText} role="alert">
                  {createError}
                </p>
              )}

              <div className={styles.suggestionActions}>
                <button onClick={saveNewBrdp} disabled={creatingBusy || !newBrdpIdentifier}>
                  {creatingBusy ? t('records.newBrdp.saving') : t('records.newBrdp.save')}
                </button>
                <button onClick={closeCreatePanel} disabled={creatingBusy}>
                  {t('records.newBrdp.cancel')}
                </button>
              </div>
            </>
          ) : !selected ? (
            <p className={styles.muted}>{t('records.selectHint')}</p>
          ) : (
            <>
              <label className={styles.fieldLabel}>{t('records.fieldId')}</label>
              <p className={styles.mono}>{selected.identifier}</p>
              <label className={styles.fieldLabel}>{t('records.fieldTitle')}</label>
              <input
                className={styles.input}
                value={selected.title}
                disabled={!canEdit}
                onChange={(e) => setBrdps((prev) => prev.map((b) => (b.id === selected.id ? { ...b, title: e.target.value } : b)))}
                onBlur={(e) => canEdit && handleUpdate(selected.id, { title: e.target.value })}
              />
              <label className={styles.fieldLabel}>{t('records.fieldDefinition')}</label>
              <textarea
                className={styles.textarea}
                value={selected.definition}
                disabled={!canEdit}
                onChange={(e) => setBrdps((prev) => prev.map((b) => (b.id === selected.id ? { ...b, definition: e.target.value } : b)))}
                onBlur={(e) => canEdit && handleUpdate(selected.id, { definition: e.target.value })}
              />
              <label className={styles.fieldLabel}>{t('records.fieldProposal')}</label>
              <textarea
                className={styles.textarea}
                value={selected.proposal}
                disabled={!canEdit}
                onChange={(e) => setBrdps((prev) => prev.map((b) => (b.id === selected.id ? { ...b, proposal: e.target.value } : b)))}
                onBlur={(e) => canEdit && handleUpdate(selected.id, { proposal: e.target.value })}
              />

              <label className={styles.fieldLabel}>{t('records.fieldValidation')}</label>
              <select
                className={styles.select}
                value={selected.validation}
                disabled={!canEdit}
                onChange={(e) => handleUpdate(selected.id, { validation: e.target.value })}
              >
                {VALIDATION_OPTIONS.map((v) => (
                  <option key={v} value={v}>
                    {t(`records.validationOptions.${v}`)}
                  </option>
                ))}
              </select>

              {/* Wires up brdps.comments -- already existed end-to-end in
                  the backend model/schemas (create/update/out), just never
                  exposed anywhere in the frontend until now (docs request,
                  confirmed zero references before this). Optional: nothing
                  blocks saving Refused with it left empty, same as every
                  other free-text field here. Only shown for Refused --
                  switching away hides the textbox again but does NOT clear
                  whatever was already saved (docs request explicit edge
                  case), so a later look back at a re-Refused BRDP still has
                  its old reason. */}
              {selected.validation === 'Refused' && (
                <>
                  <label className={styles.fieldLabel}>{t('records.fieldRefusalReason')}</label>
                  <textarea
                    className={styles.textarea}
                    value={selected.comments}
                    disabled={!canEdit}
                    onChange={(e) =>
                      setBrdps((prev) => prev.map((b) => (b.id === selected.id ? { ...b, comments: e.target.value } : b)))
                    }
                    onBlur={(e) => canEdit && handleUpdate(selected.id, { comments: e.target.value })}
                  />
                </>
              )}

              <label className={styles.fieldLabel}>{t('records.fieldRuleStatus')}</label>
              {!ruleFormat ? (
                <p className={styles.muted} title={t('records.rule.unsupportedStandard')}>
                  —
                </p>
              ) : ruleApproval === undefined ? (
                <p className={styles.muted}>…</p>
              ) : ruleEditing ? (
                <div className={styles.ruleEditor}>
                  <textarea
                    className={styles.ruleTextarea}
                    value={ruleDraftText}
                    onChange={(e) => {
                      setRuleDraftText(e.target.value);
                      if (ruleValidationError) setRuleValidationError(null);
                      if (ruleSaveError) setRuleSaveError(null);
                    }}
                    placeholder={t('records.rule.editorPlaceholder')}
                    spellCheck={false}
                    aria-invalid={ruleValidationError || ruleSaveError ? 'true' : undefined}
                  />
                  {ruleValidationError && (
                    <p className={styles.ruleErrorText} role="alert">
                      {t('records.rule.notWellFormed', { error: ruleValidationError })}
                    </p>
                  )}
                  {ruleSaveError && (
                    <p className={styles.ruleErrorText} role="alert">
                      {ruleSaveError}
                    </p>
                  )}
                  <div className={styles.suggestionActions}>
                    <button onClick={saveRuleEditor} disabled={ruleBusy}>
                      {ruleBusy ? t('records.rule.saving') : t('records.rule.save')}
                    </button>
                    <button onClick={cancelRuleEditor} disabled={ruleBusy}>
                      {t('records.rule.cancel')}
                    </button>
                  </div>
                </div>
              ) : (
                <div className={styles.ruleStatusRow}>
                  <RuleStatusStepper state={ruleStateOf(ruleApproval)} />
                  <div className={styles.suggestionActions}>
                    {ruleStateOf(ruleApproval) === 'verified' && (
                      <button onClick={() => setRulePreviewOpen((v) => !v)}>
                        {rulePreviewOpen ? t('records.rule.closePreview') : t('records.rule.preview')}
                      </button>
                    )}
                    {canEdit && (
                      <>
                        {ruleStateOf(ruleApproval) !== 'verified' && (
                          <button onClick={openRuleEditor} disabled={ruleBusy}>
                            {t('records.rule.edit')}
                          </button>
                        )}
                        {ruleStateOf(ruleApproval) === 'draft' && (
                          <button onClick={verifyRule} disabled={ruleBusy}>
                            {ruleBusy ? t('records.rule.verifying') : t('records.rule.verify')}
                          </button>
                        )}
                        {ruleStateOf(ruleApproval) === 'verified' && (
                          <button onClick={revokeRule} disabled={ruleBusy}>
                            {ruleBusy ? t('records.rule.revoking') : t('records.rule.revoke')}
                          </button>
                        )}
                      </>
                    )}
                  </div>
                  {rulePreviewOpen && ruleStateOf(ruleApproval) === 'verified' && (
                    <textarea
                      className={styles.ruleTextarea}
                      value={ruleApproval.rule_xml}
                      readOnly
                      spellCheck={false}
                      aria-label={t('records.rule.preview')}
                    />
                  )}
                </div>
              )}

              <div className={styles.assistant}>
                <h3 className={styles.assistantTitle}>{t('records.assistant.title')}</h3>
                {!aiProvider && <p className={styles.muted}>{t('records.assistant.noProvider')}</p>}

                <label className={styles.fieldLabel}>{t('records.assistant.askLabel')}</label>

                {/* The last exchange -- question + answer/error/loading --
                    always ABOVE the textarea (docs request: feel like a
                    mini conversation, not a submitted form). Only ever ONE
                    exchange shown, matching the one-turn chaining already
                    sent to the LLM: what's on screen and what it remembers
                    are always the same turn. */}
                {lastAsked && (
                  <div className={styles.exchange}>
                    <p className={styles.exchangeQuestion}>
                      <span className={styles.exchangeYou}>{t('records.assistant.you')}:</span> {lastAsked}
                    </p>
                    {askPending ? (
                      <div className={styles.answerBox}>
                        <span className={styles.muted}>{t('records.assistant.thinking')}</span>
                      </div>
                    ) : askError ? (
                      <div className={styles.answerBox} role="alert">
                        {t('records.assistant.errorPrefix')}: {askError}
                      </div>
                    ) : (
                      <div className={styles.answerBox}>
                        <ReactMarkdown>{answer}</ReactMarkdown>
                      </div>
                    )}
                    {!askPending && (
                      <button type="button" className={styles.linkButton} onClick={clearAsk}>
                        {t('records.assistant.clear')}
                      </button>
                    )}
                  </div>
                )}

                <textarea
                  className={styles.textarea}
                  rows={2}
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !busy) {
                      e.preventDefault();
                      askGeneric();
                    }
                  }}
                  placeholder={t(
                    prevTurn ? 'records.assistant.askFollowupPlaceholder' : 'records.assistant.askPlaceholder'
                  )}
                />

                {compareBrdp ? (
                  <div className={styles.compareChip}>
                    <span>{t('records.assistant.comparingWith', { identifier: compareBrdp.identifier })}</span>
                    <button
                      type="button"
                      className={styles.compareChipRemove}
                      onClick={clearCompareBrdp}
                      aria-label={t('records.assistant.compareRemove')}
                    >
                      ✕
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className={styles.linkButton}
                    onClick={compareOpen ? closeCompareSearch : openCompareSearch}
                  >
                    {t('records.assistant.compareLink')}
                  </button>
                )}

                {compareOpen &&
                  !compareBrdp &&
                  (() => {
                    const q = compareQuery.trim().toLowerCase();
                    const recordsMatches = brdps
                      .filter((b) => b.id !== selected.id)
                      .filter(
                        (b) => !q || b.identifier.toLowerCase().includes(q) || (b.title || '').toLowerCase().includes(q)
                      )
                      .map((entry) => ({ source: 'records', entry }));
                    const catalogMatches = compareCatalogEntries
                      .filter((c) => !q || c.identifier.toLowerCase().includes(q) || c.title.toLowerCase().includes(q))
                      .map((entry) => ({ source: 'catalog', entry }));
                    const allMatches = [...recordsMatches, ...catalogMatches];
                    return (
                      <div className={styles.catalogPicker}>
                        <input
                          className={styles.input}
                          value={compareQuery}
                          onChange={(e) => setCompareQuery(e.target.value)}
                          placeholder={t('records.assistant.compareSearchPlaceholder')}
                          autoFocus
                        />
                        <ul className={styles.catalogList}>
                          {allMatches.length === 0 && (
                            <li className={styles.muted}>{t('records.assistant.compareEmpty')}</li>
                          )}
                          {allMatches.slice(0, 50).map((candidate) => (
                            <li key={`${candidate.source}-${candidate.entry.id}`} className={styles.catalogItem}>
                              <div className={styles.catalogItemHeader}>
                                <span className={styles.mono}>{candidate.entry.identifier}</span>
                                <span className={styles.compareSourceTag}>
                                  {t(
                                    candidate.source === 'records'
                                      ? 'records.assistant.compareSourceRecords'
                                      : 'records.assistant.compareSourceCatalog'
                                  )}
                                </span>
                                <button type="button" disabled={compareBusy} onClick={() => chooseCompareBrdp(candidate)}>
                                  {t('records.newBrdp.catalogChoose')}
                                </button>
                              </div>
                              <div className={styles.catalogItemTitle}>{candidate.entry.title}</div>
                            </li>
                          ))}
                        </ul>
                        {allMatches.length > 50 && (
                          <p className={styles.hint}>
                            {t('records.assistant.compareTruncated', { count: allMatches.length })}
                          </p>
                        )}
                      </div>
                    );
                  })()}

                <div>
                  <button onClick={askGeneric} disabled={busy || !question.trim() || !aiProvider}>
                    {busy ? '…' : t('records.assistant.ask')}
                  </button>
                </div>

                <hr className={styles.hr} />

                {/* On-demand embeddings (docs request): Suggest needs real
                    pgvector precedent, so a pending project/catalog backlog
                    (or a job already running) is shown here, next to the
                    buttons it gates -- never in the Ask panel above, which
                    doesn't use embeddings at all. */}
                {embeddingJobRunning ? (
                  <div className={styles.suggestionBox}>
                    <p className={styles.hint}>
                      {t('records.assistant.embeddingJobRunning', {
                        processed: embeddingJob.processed_items,
                        total: embeddingJob.total_items,
                      })}
                    </p>
                    <progress
                      className={styles.progressBar}
                      value={embeddingJob.processed_items}
                      max={embeddingJob.total_items || 1}
                    />
                    {(() => {
                      const etaSeconds = estimateEmbeddingEtaSeconds(embeddingJob);
                      return (
                        <p className={styles.hint}>
                          {etaSeconds === null
                            ? t('records.assistant.embeddingJobEtaEstimating')
                            : etaSeconds < 60
                              ? t('records.assistant.embeddingJobEtaUnderMinute')
                              : t('records.assistant.embeddingJobEtaEstimate', {
                                  minutes: Math.ceil(etaSeconds / 60),
                                })}
                        </p>
                      );
                    })()}
                  </div>
                ) : (
                  hasPendingEmbeddings && (
                    <div className={styles.suggestionBox}>
                      <span className={styles.muted}>
                        ⚠ {t('records.assistant.pendingEmbeddings', { count: totalPendingEmbeddings })}
                      </span>
                      {canEdit && (
                        <div className={styles.suggestionActions}>
                          <button onClick={handleComputeEmbeddings} disabled={computeEmbeddings.isPending}>
                            {computeEmbeddings.isPending
                              ? '…'
                              : t('records.assistant.computeEmbeddings')}
                          </button>
                        </div>
                      )}
                      {computeEmbeddings.isError && (
                        <p className={styles.muted}>{computeEmbeddings.error.message}</p>
                      )}
                    </div>
                  )
                )}

                <div className={styles.suggestionActions}>
                  {SUGGEST_KINDS.map((kind) => {
                    // docs request (Suggest Definition corpus round), point
                    // 1: an official catalog BRDP already has a standard-
                    // issued Definition -- checked against the real
                    // catalog table (catalogIdentifierSet), never by
                    // identifier prefix. Only Suggest Definition is gated
                    // by this; Suggest Proposal/Rule are unaffected.
                    const catalogDisabled = kind === 'definition' && catalogIdentifierSet.has(selected.identifier);
                    // docs request (per-BRDP suggestion round): ANY pending
                    // or resolved entry for this BRDP blocks ALL THREE
                    // buttons, not just the matching kind -- Discard (or
                    // Accept) first to regenerate, even the same kind.
                    const pendingBlocked = !!selectedSuggestion;
                    return (
                      <button
                        key={kind}
                        onClick={() => requestSuggestion(kind)}
                        disabled={pendingBlocked || !aiProvider || suggestDisabledByEmbeddings || catalogDisabled}
                        title={
                          pendingBlocked
                            ? t('records.assistant.pendingSuggestionBlocksNew')
                            : catalogDisabled
                              ? t('records.assistant.suggestDefinitionCatalogDisabled')
                              : undefined
                        }
                      >
                        {selectedSuggestion?.loading && selectedSuggestion.kind === kind
                          ? '…'
                          : t(`records.assistant.suggest${kind.charAt(0).toUpperCase()}${kind.slice(1)}`)}
                      </button>
                    );
                  })}
                </div>

                {selectedSuggestion?.excludedPendingOtherProjects > 0 && (
                  <div className={styles.suggestionBox}>
                    <span className={styles.muted}>
                      ⚠{' '}
                      {t('records.assistant.excludedPendingOtherProjects', {
                        count: selectedSuggestion.excludedPendingOtherProjects,
                      })}
                    </span>
                  </div>
                )}

                {selectedSuggestion?.insufficientPrecedent && (
                  <div className={styles.suggestionBox}>
                    <span className={styles.muted}>
                      ⚠ {t('records.assistant.insufficientPrecedent', { count: selectedSuggestion.count })}
                    </span>
                    <div className={styles.suggestionActions}>
                      <button onClick={discardSuggestion}>{t('records.assistant.discard')}</button>
                    </div>
                  </div>
                )}

                {selectedSuggestion?.error && (
                  <div className={styles.suggestionBox}>
                    <span className={styles.muted}>
                      ⚠ {t('records.assistant.errorPrefix')}: {selectedSuggestion.error}
                    </span>
                    <div className={styles.suggestionActions}>
                      <button onClick={discardSuggestion}>{t('records.assistant.discard')}</button>
                    </div>
                  </div>
                )}

                {selectedSuggestion?.text && (
                  <div className={styles.suggestionBox}>
                    <div className={selectedSuggestion.kind === 'rule' ? styles.suggestionCode : styles.suggestionText}>
                      {selectedSuggestion.text}
                    </div>
                    <div className={styles.suggestionActions}>
                      <button
                        onClick={acceptSuggestion}
                        disabled={!canEdit}
                        title={!canEdit ? t('records.assistant.acceptDisabledTitle') : undefined}
                      >
                        {t('records.assistant.accept')}
                      </button>
                      <button onClick={discardSuggestion}>{t('records.assistant.discard')}</button>
                    </div>

                    {/* docs request (Suggest Definition corpus round): the
                        reference list is app-generated from /similar's own
                        structured data -- the exact same `similar`/
                        `styleReferences` arrays buildSuggestDefinitionPrompt
                        used -- NEVER text the LLM produced, and the
                        accepted text above never includes it. */}
                    {selectedSuggestion.kind === 'definition' && (
                      <div className={styles.suggestionReferences}>
                        {selectedSuggestion.similar.length === 0 && selectedSuggestion.styleReferences.length === 0 ? (
                          <p className={styles.hint}>{t('records.assistant.definitionNoReferences')}</p>
                        ) : (
                          <>
                            {selectedSuggestion.similar.length > 0 && (
                              <div>
                                <h4 className={styles.referencesGroupTitle}>
                                  {t('records.assistant.definitionSimilarGroup')}
                                </h4>
                                <ul className={styles.referencesList}>
                                  {selectedSuggestion.similar.map((c) => (
                                    <ReferenceRow
                                      key={`similar-${c.id}`}
                                      candidate={c}
                                      showScore
                                      expanded={selectedSuggestion.expandedReferenceIds.has(c.id)}
                                      onToggle={() => toggleReferenceExpanded(selected.id, c.id)}
                                    />
                                  ))}
                                </ul>
                              </div>
                            )}
                            {selectedSuggestion.styleReferences.length > 0 && (
                              <div>
                                <h4 className={styles.referencesGroupTitle}>
                                  {t('records.assistant.definitionStyleReferencesGroup')}
                                </h4>
                                <ul className={styles.referencesList}>
                                  {selectedSuggestion.styleReferences.map((c) => (
                                    <ReferenceRow
                                      key={`style-${c.id}`}
                                      candidate={c}
                                      showScore={false}
                                      expanded={selectedSuggestion.expandedReferenceIds.has(c.id)}
                                      onToggle={() => toggleReferenceExpanded(selected.id, c.id)}
                                    />
                                  ))}
                                </ul>
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className={styles.historySection}>
                <h3 className={styles.assistantTitle}>{t('records.history.title')}</h3>
                {history.length === 0 ? (
                  <p className={styles.muted}>{t('records.history.empty')}</p>
                ) : (
                  <ul className={styles.historyList}>
                    {history.map((h) => (
                      <li key={h.id} className={styles.historyItem}>
                        <div className={styles.historyField}>
                          {t(`records.history.fields.${h.field_name}`, { defaultValue: h.field_name })}
                        </div>
                        <div className={styles.historyChange}>
                          <span className={styles.historyOld}>{formatHistoryValue(t, h.field_name, h.old_value)}</span>
                          <span className={styles.historyArrow}>→</span>
                          <span className={styles.historyNew}>{formatHistoryValue(t, h.field_name, h.new_value)}</span>
                        </div>
                        <div className={styles.historyMeta}>
                          {h.user_email || t('records.history.unknownUser')} ·{' '}
                          {new Date(h.changed_at).toLocaleString()}
                        </div>
                        {canEdit && REVERTIBLE_HISTORY_FIELDS[h.field_name] && (
                          <button
                            type="button"
                            className={styles.historyRevertButton}
                            onClick={() => revertHistoryEntry(h)}
                          >
                            {t('records.history.revert')}
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
