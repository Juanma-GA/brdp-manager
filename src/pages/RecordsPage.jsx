import { useEffect, useMemo, useRef, useState } from 'react';
import { useOutletContext, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import { Trash2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { authFetchJson } from '../services/apiClient';
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
import { useVocabularyCheck } from '../hooks/useVocabularyCheck';
import { useAskAssistant } from '../hooks/useAskAssistant';
import { useSuggestions } from '../hooks/useSuggestions';
import { useResizableSplit } from '../hooks/useResizableSplit';
import ReferenceRow from '../components/assistant/ReferenceRow';
import SchemaFactCard from '../components/assistant/SchemaFactCard';
import NamingTip from '../components/assistant/NamingTip';
import RenameSuggestions from '../components/assistant/RenameSuggestions';
import RuleSuggestionPanel from '../components/assistant/RuleSuggestionPanel';
import RuleSchemaSelector from '../components/assistant/RuleSchemaSelector';
import { schemaLocationOf, supportsSchemaContext } from '../utils/ruleSchemaContext.js';
import { hasUnfilledMarkers } from '../utils/proposalMarkers';
import RuleStatusStepper from '../components/RuleStatusStepper';
import RuleTestPanel, { canTestRule, formatTestDate, TestRuleButton } from '../components/assistant/RuleTestPanel';
import { RuleTestIndicator, VerifyWarningDialog } from '../components/assistant/RuleTestIndicator';
import SavedRuleTestPanel from '../components/assistant/SavedRuleTestPanel';
import { savedPassedTest } from '../utils/ruleTestSaved.js';
import { registerRuleTest } from '../api/ruleTests';
import { parseRuleTestHistoryValue, verifyWarning } from '../utils/ruleTestStatus.js';
import { formatRuleTestReason } from '../utils/ruleTestReasons.js';
import RuleStatusCell from '../components/RuleStatusCell';
import SchemaIssueLines from '../components/assistant/SchemaIssueLines';
import SchemaNavCard from '../components/assistant/SchemaNavCard';
import BrdpCompareDialog from '../components/compare/BrdpCompareDialog';
import SchemaSearch from '../components/assistant/SchemaSearch';
import { useSchemaNavigation } from '../hooks/useSchemaNavigation';
import { fetchSchemaAttribute, fetchSchemaCards } from '../api/schemaFacts.js';
import { parseMoreMarker, schemaLinkTarget } from '../utils/schemaNavigation.js';
import { AnswerMoreNames, SchemaNameLink } from '../components/assistant/SchemaAnswerLinks';
import { checkRuleFormat, nameIssues, ruleFormatIssues } from '../validation/schemaValidation.js';
import styles from './RecordsPage.module.css';

// The data-testids the verification scripts read on the Ask answer's
// name warnings.
const ANSWER_ISSUE_TEST_IDS = {
  names_not_found: 'ask-answer-unknown-names',
  wrong_type_as_element: 'ask-answer-wrong-type',
  wrong_type_as_attribute: 'ask-answer-wrong-type',
};

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

// Split between the table and the detail panel (C1, Part 3). The divider is
// also the gap between the two (it replaces the layout's 16px gap).
const DETAIL_PANEL_DEFAULT_WIDTH = 460;
const DETAIL_PANEL_MIN_WIDTH = 360;
const TABLE_MIN_WIDTH = 480;
const SPLIT_DIVIDER_WIDTH = 16;

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

// Long free-text history values (a whole rule's XML, a long Definition)
// are shortened in the list, with the full text on hover -- the history
// panel is a narrow side column. The rule's XML also has its indentation
// collapsed first so the shortened text shows content, not whitespace.
const HISTORY_MAX_CHARS = 160;

// A "rule_test" History value (T3) is JSON codes, {"result", "reason"},
// never a sentence: translated here, so it reads in the viewer's language.
// A passed test reached by editing examples by hand says so, with the count
// (its XML is shown under the entry: HistoryEditedExamples).
function formatRuleTestHistoryValue(t, value) {
  if (!value) return t('records.ruleTest.indicator.notTested');
  const parsed = parseRuleTestHistoryValue(value);
  if (!parsed) return value;
  if (parsed.result === 'passed' && parsed.editedExamples.length > 0) {
    return t('records.ruleTest.results.passedEdited', { count: parsed.editedExamples.length });
  }
  const result = t(`records.ruleTest.results.${parsed.result}`, { defaultValue: parsed.result });
  const reason = formatRuleTestReason(parsed.reason, t);
  let text = reason ? t('records.ruleTest.results.withReason', { result, reason }) : result;
  // A test run on the saved examples of an earlier passed test.
  if (parsed.examplesFrom) {
    const from = new Date(parsed.examplesFrom).toLocaleDateString(i18n.language, { year: 'numeric', month: 'short', day: 'numeric' });
    text = t('records.ruleTest.results.onSavedExamples', { result: text, date: from });
  }
  // "Mantener la anterior": an attempt that was not recorded.
  if (parsed.notRecorded) {
    const date = parsed.keptTestAt ? new Date(parsed.keptTestAt).toLocaleDateString(i18n.language, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
    return t('records.ruleTest.results.notRecorded', { result: text, date });
  }
  return text;
}

// "Usar esta Regla" (Comparar dos BRDP): the "rule_copied" event's value is
// JSON ({ project_name, identifier, standard, ... }); it reads as
// "<project> / <BRDP>".
function formatRuleCopiedValue(value) {
  if (!value) return '—';
  try {
    const parsed = JSON.parse(value);
    return `${parsed.project_name} / ${parsed.identifier}`;
  } catch {
    return value;
  }
}

// The full value on hover: the raw text, except a rule test (its codes
// would read as JSON), which shows its translated text.
function historyValueTitle(t, fieldName, value) {
  if (!value) return undefined;
  if (fieldName === 'rule_copied') return formatRuleCopiedValue(value);
  return fieldName === 'rule_test' ? formatRuleTestHistoryValue(t, value) : value;
}

// The examples edited by hand of a recorded rule test, as they were run --
// shown under the History entry once it is expanded ("Show more").
function HistoryEditedExamples({ value }) {
  const parsed = parseRuleTestHistoryValue(value);
  if (!parsed || parsed.editedExamples.length === 0) return null;
  return (
    <div className={styles.historyEditedExamples} data-testid="history-edited-examples">
      {parsed.editedExamples.map((ex, i) => (
        <div key={i} className={styles.historyEditedExample}>
          {ex.label && <div className={styles.historyEditedExampleLabel}>{ex.label}</div>}
          <pre className={styles.historyEditedExampleXml}>{ex.xml}</pre>
        </div>
      ))}
    </div>
  );
}

// "Historial desplegable": an entry is long -- collapsed behind "Show more"
// -- when a free-text value does not fit HISTORY_MAX_CHARS (a rule's XML, a
// long Definition) or it carries examples edited by hand (their XML).
function isLongHistoryEntry(entry) {
  if (entry.field_name === 'rule_test') return (parseRuleTestHistoryValue(entry.new_value)?.editedExamples.length || 0) > 0;
  if (HISTORY_TRANSLATED_FIELDS[entry.field_name] || entry.field_name === 'rule_copied') return false;
  return [entry.old_value, entry.new_value].some((v) => historyText(entry.field_name, v).length > HISTORY_MAX_CHARS);
}

function historyText(fieldName, value) {
  if (!value) return '';
  return fieldName === 'rule' ? value.replace(/\s+/g, ' ').trim() : value;
}

// The whole value of an expanded entry: the text as it was saved (a rule
// keeps its line breaks and indentation).
function fullHistoryValue(t, fieldName, value) {
  if (fieldName === 'rule_test' || fieldName === 'rule_copied' || HISTORY_TRANSLATED_FIELDS[fieldName]) return formatHistoryValue(t, fieldName, value);
  return value || '—';
}

// The History section starts collapsed ("History (N)" and the date of the
// latest entry); open or closed is remembered for this browser tab, also
// when another BRDP is selected -- a UI preference, never data (HR1 does
// not apply; sessionStorage may be unavailable, so every access is
// guarded).
const HISTORY_OPEN_KEY = 'brdp-records-history-open';
function readHistoryOpen() {
  try {
    return sessionStorage.getItem(HISTORY_OPEN_KEY) === '1';
  } catch {
    return false;
  }
}
function writeHistoryOpen(open) {
  try {
    sessionStorage.setItem(HISTORY_OPEN_KEY, open ? '1' : '0');
  } catch {
    // not remembered: the section still works
  }
}

// A rule test recorded as "review" (the examples passed but the rule does
// not seem to implement the Proposal) reads as an amber label in History,
// like the indicator.
function historyReviewTag(entry) {
  return entry.field_name === 'rule_test' && parseRuleTestHistoryValue(entry.new_value)?.result === 'review';
}

function formatHistoryValue(t, fieldName, value) {
  if (fieldName === 'rule_test') return formatRuleTestHistoryValue(t, value);
  if (fieldName === 'rule_copied') return formatRuleCopiedValue(value);
  const prefix = HISTORY_TRANSLATED_FIELDS[fieldName];
  if (prefix) return t(`${prefix}.${value}`, { defaultValue: value });
  if (!value) return '—';
  const text = historyText(fieldName, value);
  return text.length > HISTORY_MAX_CHARS ? `${text.slice(0, HISTORY_MAX_CHARS)}…` : text;
}

export default function RecordsPage() {
  const { t } = useTranslation();
  const { projectId } = useParams();
  const { project } = useOutletContext();
  // project.effective_role is computed server-side (admin already resolved
  // to 'editor' there, docs/v2 §4.3) -- never re-derive the admin bypass here.
  const canEdit = project.effective_role === 'editor';
  const ruleFormat = STANDARD_TO_RULE_FORMAT[project.standard];

  // Naming-convention tip round, follow-up ("sin Don't show again"): the
  // user decided the tip is a genuinely useful reminder in an app used
  // only sporadically, so it always comes back next session -- the
  // permanent, server-side dismissal is gone entirely (users.hide_
  // naming_tip dropped, migration 0016). `namingTipAnchor` is which field
  // (if any) is CURRENTLY showing the tip -- 'title' | 'definition' |
  // 'proposal' | 'ask' | null, at most one at a time. `namingTipSessionSeenRef`
  // is the "once per session" latch (docs request: "una sola vez por
  // sesión" is ONE tip total, not one per field -- confirmed by the edge
  // case "primera escritura -> aparece; segunda -> no", which doesn't say
  // "segunda en OTRO campo"): set the instant the tip is triggered
  // anywhere, so no other field can trigger a second one later in the
  // same session. "Got it" is the only dismissal left -- it hides the tip
  // until the next session (a fresh page load resets the ref), never
  // persisted anywhere (HR1).
  const [namingTipAnchor, setNamingTipAnchor] = useState(null);
  const namingTipSessionSeenRef = useRef(false);

  const triggerNamingTip = (field) => {
    if (namingTipSessionSeenRef.current) return;
    namingTipSessionSeenRef.current = true;
    setNamingTipAnchor(field);
  };

  const dismissNamingTipForSession = () => setNamingTipAnchor(null);

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

  // Rule Status stepper state for the SELECTED BRDP -- the manual editor
  // and Edit/Verify/Revoke actions live here in the detail panel (v1's
  // large plain-text editor), not in the table cell above.
  const [ruleApproval, setRuleApproval] = useState(undefined); // undefined = loading, null = none
  // Test de reglas T3: the warning shown before Verify (utils/ruleTestStatus
  // verifyWarning), and an error recording a test result.
  const [verifyDialog, setVerifyDialog] = useState(null);
  const [ruleTestRecordError, setRuleTestRecordError] = useState(null);
  const [ruleEditing, setRuleEditing] = useState(false);
  // Read-only view of the saved rule_xml while Verified -- the only state
  // where the actual rule text was otherwise invisible without Revoke
  // first (docs request). Available to viewer AND editor alike, same
  // criterion as being able to see the stepper at all: this never writes
  // anything, it only reads what's already there.
  const [rulePreviewOpen, setRulePreviewOpen] = useState(false);
  // Test rule (T2) on the saved Draft rule -- open for this BRDP only.
  const [draftTestOpenFor, setDraftTestOpenFor] = useState(null);
  // Guardar la prueba aprobada: the kept passed test shown for this BRDP.
  const [savedTestOpenFor, setSavedTestOpenFor] = useState(null);
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
  // "Historial desplegable": the section starts collapsed and remembers
  // open/closed for the tab (also across BRDPs); long entries open one by
  // one with "Show more".
  const [historyOpen, setHistoryOpen] = useState(readHistoryOpen);
  const toggleHistory = () =>
    setHistoryOpen((open) => {
      writeHistoryOpen(!open);
      return !open;
    });
  const [expandedHistoryIds, setExpandedHistoryIds] = useState(() => new Set());
  const toggleHistoryEntry = (id) =>
    setExpandedHistoryIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const latestHistoryAt = history.reduce((latest, h) => (!latest || h.changed_at > latest ? h.changed_at : latest), null);
  const [historyRefreshToken, setHistoryRefreshToken] = useState(0);
  // "Comparar dos BRDP lado a lado": the comparison dialog of the selected
  // BRDP, and the Ask question box it focuses on "Explain the differences".
  const [compareDialogOpen, setCompareDialogOpen] = useState(false);
  const askTextareaRef = useRef(null);

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
  // Suggest Rule adjustments round, Part 6: when the ONLY pending embedding
  // (project and catalog) is the selected BRDP itself -- e.g. its Proposal
  // was just edited -- Suggest isn't blocked: it embeds that one BRDP
  // first (editor-only, like "Compute embeddings"), then runs. Any other
  // pending row keeps the old block, since precedent would be missing.
  const onlySelectedPendingEmbedding =
    canEdit &&
    !!selected &&
    !embeddingJobRunning &&
    (pendingEmbeddings?.catalog_pending ?? 0) === 0 &&
    (pendingEmbeddings?.project_pending ?? 0) === 1 &&
    pendingEmbeddings?.only_pending_brdp_id === selected.id;
  const suggestDisabledByEmbeddings = embeddingJobRunning || (hasPendingEmbeddings && !onlySelectedPendingEmbedding);
  const embedSelectedBrdpFirst = async (brdpId) => {
    await authFetchJson(`/api/projects/${projectId}/embeddings/brdps/${brdpId}`, { method: 'POST' });
    invalidatePendingEmbeddings(projectId);
  };

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

  // T3: another BRDP starts without the previous one's warning or error
  // (not on an approvals refresh -- that one follows the very recording
  // whose error must stay visible).
  useEffect(() => {
    setRuleTestRecordError(null);
    setVerifyDialog(null);
  }, [selected?.id]);

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

  // Prompt-refactor round: the vocabulary check (its own "recompute on
  // BRDP selection" effect included), the Ask panel (its own "reset on
  // BRDP selection" effect included) and Suggest are each a dedicated hook
  // now -- see src/hooks/{useVocabularyCheck,useAskAssistant,
  // useSuggestions}.js. Same behavior as before the refactor, split by
  // concern instead of one giant effect.
  const { vocabulary, vocabResult, recomputeVocabResult } = useVocabularyCheck(project.standard, selected);

  const handleUpdate = async (brdpId, patch) => {
    await authFetchJson(`/api/projects/${projectId}/brdps/${brdpId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    setHistoryRefreshToken((n) => n + 1);
    refresh();
    refreshStats();
    // An edit of Title/Definition/Proposal/validation can make this BRDP
    // pending (or not) -- keep the Suggest gate honest right away.
    invalidatePendingEmbeddings(projectId);
    // "Aviso ligado al texto" round, point 1: a save touching Title/
    // Definition/Proposal invalidates whatever vocabulary notice is
    // showing -- recompute the deterministic part immediately (no LLM
    // call) against the text JUST saved, so the notice/Suggest-blocking
    // update without needing another Ask/Suggest click. Covers BOTH "al
    // guardar" (any direct field edit, which flows through this same
    // function) and "al aceptar una sugerencia" (acceptSuggestion's
    // Definition/Proposal branch is itself a call to handleUpdate).
    // Merges onto the row's own pre-update fields (closure -- may be one
    // render behind the `refresh()` just kicked off above) since `patch`
    // alone may only carry ONE of the three fields; that's fine, only
    // title/definition/proposal/id matter here, and `patch` always holds
    // the authoritative new value for whichever of those three it touches.
    if (brdpId === selectedId && ('title' in patch || 'definition' in patch || 'proposal' in patch)) {
      const priorBrdp = brdps.find((b) => b.id === brdpId) || {};
      recomputeVocabResult({ ...priorBrdp, ...patch, id: brdpId });
    }
  };

  const ask = useAskAssistant({
    projectId,
    standard: project.standard,
    ruleFormat,
    selected,
    ruleApproval,
    aiProvider,
    vocabulary,
    recomputeVocabResult,
  });
  // "Nombres navegables en las respuestas de Ask sin IA": the floating
  // schema card opened from a name in an answer taken from the schema. Its
  // cache is emptied (and the card closed) on a BRDP or project change.
  const schemaNav = useSchemaNavigation({
    standard: project.standard,
    resetKey: `${projectId}:${selected?.id ?? ''}`,
    fetchCards: fetchSchemaCards,
    fetchAttribute: fetchSchemaAttribute,
  });
  // A new answer (or none) takes away the link the card was opened from.
  const closeSchemaNav = schemaNav.close;
  const schemaNavOpen = schemaNav.isOpen;
  useEffect(() => {
    if (schemaNavOpen) closeSchemaNav();
    // Only a change of the answer shown closes the card.
  }, [ask.answer, ask.lastAsked]);
  // In an answer taken from the schema, each `<x>`/`@y` that exists in the
  // vocabulary as that kind is a link; anything else stays plain code, and
  // each cut list's "+N more" marker is a button that expands its names.
  // The renderer must keep its identity across renders: ReactMarkdown uses it
  // as a component type, and a new one would remount the link the card is
  // anchored to. The latest `open` and the answer's cut lists are read
  // through refs.
  const openSchemaNavRef = useRef(schemaNav.open);
  openSchemaNavRef.current = schemaNav.open;
  const schemaAnswerCutsRef = useRef([]);
  schemaAnswerCutsRef.current = ask.schemaAnswerView?.cuts || [];
  const schemaAnswerComponents = useMemo(() => {
    const onOpen = (target, anchor) => openSchemaNavRef.current(target, anchor);
    return {
      code({ children, className }) {
        if (!className && typeof children === 'string') {
          const cutId = parseMoreMarker(children);
          const cut = cutId === null ? null : schemaAnswerCutsRef.current[cutId];
          if (cut) return <AnswerMoreNames cut={cut} vocabulary={vocabulary} onOpen={onOpen} />;
          const target = schemaLinkTarget(children, vocabulary);
          if (target) return <SchemaNameLink target={target} onOpen={onOpen} />;
        }
        return <code className={className}>{children}</code>;
      },
    };
  }, [vocabulary]);

  const suggestions = useSuggestions({
    projectId,
    standard: project.standard,
    schemaLocation: schemaLocationOf(project.project_config),
    selected,
    aiProvider,
    vocabulary,
    ruleApproval,
    handleUpdate,
    recomputeVocabResult,
    onRuleTestRecordError: setRuleTestRecordError,
    // Accepting a rule (suggested or pasted) changes both the rule and the
    // BRDP's History -- refresh both at once (Suggest Rule adjustments
    // round: History used to show the change only after a reload).
    bumpApprovalsRefreshToken: () => {
      setApprovalsRefreshToken((n) => n + 1);
      setHistoryRefreshToken((n) => n + 1);
    },
    t,
  });
  const selectedSuggestion = suggestions.selectedSuggestion;
  // Guardar la prueba aprobada: the kept passed test of the saved rule (and
  // whether the rule or the Proposal changed since), or null.
  const savedTest = selected && ruleApproval && canTestRule(ruleFormat) ? savedPassedTest(ruleApproval, selected.proposal) : null;

  // docs request (Suggest Rule round), Part 1: why Suggest Rule is
  // unavailable for the selected BRDP, or null when it is. Order matters
  // only for which single reason the tooltip shows.
  const suggestRuleBlockedReason = () => {
    if (!ruleFormat) return t('records.assistant.suggestRuleNoFormat', { standard: project.standard });
    if (!selected.proposal?.trim()) return t('records.assistant.suggestRuleNeedsProposal');
    if (hasUnfilledMarkers(selected.proposal)) return t('records.assistant.suggestRuleFillPlaceholders');
    if (selected.validation !== 'Validated') return t('records.assistant.suggestRuleNeedsValidated');
    if (ruleApproval === undefined) return t('records.assistant.suggestRuleLoadingRule');
    if (ruleStateOf(ruleApproval) === 'verified') return t('records.assistant.suggestRuleAlreadyVerified');
    return null;
  };

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
    // C2, Part 0: the Save button is already disabled while the draft is
    // not a rule of the project's format; this is the same gate.
    if (!checkRuleFormat(ruleDraftText, ruleFormat).ok) return;
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

  // C2, Part 0: while editing, the draft must contain a rule of the
  // project's format -- checked live (on well-formed XML; malformed XML keeps
  // its own error on Save). An empty draft only disables Save, silently.
  const ruleDraftFormat =
    ruleEditing && ruleDraftText.trim() && checkWellFormed(ruleDraftText).valid ? checkRuleFormat(ruleDraftText, ruleFormat) : null;
  const ruleDraftBlocked = ruleEditing && (!ruleDraftText.trim() || (ruleDraftFormat && !ruleDraftFormat.ok));

  const doVerifyRule = async () => {
    setRuleBusy(true);
    try {
      await authFetchJson(`/api/projects/${projectId}/brdps/${selected.id}/approvals/${ruleFormat}/approve`, {
        method: 'POST',
      });
      setVerifyDialog(null);
      setApprovalsRefreshToken((n) => n + 1);
      setHistoryRefreshToken((n) => n + 1);
    } finally {
      setRuleBusy(false);
    }
  };

  // Test de reglas T3, Part 3: moving a rule to Verified warns -- never
  // blocks (user decision) -- when its recorded test is missing, outdated,
  // failed, inconclusive or could not run. This is the only path in the
  // application that moves a rule to Verified (the Excel import is left as
  // it is, docs request; v1's BRDPPage/DetailPanel are not routed).
  const verifyRule = () => {
    const warning = verifyWarning(ruleApproval, ruleFormat);
    if (warning) setVerifyDialog(warning);
    else doVerifyRule();
  };

  const testNowFromVerifyDialog = () => {
    setVerifyDialog(null);
    setDraftTestOpenFor(selected.id);
  };

  // Records the result of a Test rule run on the saved Draft rule (T3,
  // Part 1). Editor only: a viewer can run the test, but only an editor's
  // run is recorded (the backend requires editor too). A failure to record
  // is shown next to the Rule Status indicator, never swallowed (HR7).
  // Returns whether it was saved (the panel's notice about a corrected
  // test with hand-edited examples depends on it).
  // keepPrevious ("Mantener la anterior"): the result is not recorded, only
  // noted in History (Part 2 of "resultado Revisar...").
  const recordDraftRuleTest = async (brdpId, testedRuleXml, record, { keepPrevious = false } = {}) => {
    if (!canEdit || !ruleFormat) return false;
    setRuleTestRecordError(null);
    try {
      await registerRuleTest(projectId, brdpId, ruleFormat, testedRuleXml, record, { keepPrevious });
      setApprovalsRefreshToken((n) => n + 1);
      setHistoryRefreshToken((n) => n + 1);
      return true;
    } catch (err) {
      setRuleTestRecordError(err.message);
      return false;
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
    suggestions.removeSuggestionEntry(brdpId);
    refresh();
    refreshStats();
  };


  // Editor-only (backend enforces this too -- see embedding_jobs.py's
  // require_project_role('editor')): launches the background job. 409 (a
  // second editor already started one, docs request's own edge case) reads
  // fine as-is from the backend's own detail message via computeEmbeddings
  // .error; the mutation always invalidates the job query on settle
  // either way, so the UI reflects whatever IS actually running.
  const handleComputeEmbeddings = () => computeEmbeddings.mutate();

  // Consolidation C1, Part 3: draggable divider between the table and the
  // detail panel (width remembered in this browser only).
  const split = useResizableSplit({
    storageKey: 'brdp-records-detail-width',
    defaultSize: DETAIL_PANEL_DEFAULT_WIDTH,
    minSize: DETAIL_PANEL_MIN_WIDTH,
    minOther: TABLE_MIN_WIDTH,
    dividerSize: SPLIT_DIVIDER_WIDTH,
  });

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

      <div className={styles.layout} ref={split.containerRef}>
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
                        {suggestions.suggestionsByBrdpId.has(b.id) && (
                          <span
                            className={styles.pendingSuggestionIcon}
                            title={t('records.assistant.pendingSuggestionIndicator', {
                              kind: t(`records.assistant.kindLabels.${suggestions.suggestionsByBrdpId.get(b.id).kind}`),
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

        <div
          {...split.dividerProps}
          className={`${styles.splitDivider}${split.dragging ? ` ${styles.splitDividerDragging}` : ''}`}
          aria-label={t('records.resizeDivider.label')}
          title={t('records.resizeDivider.hint')}
          data-testid="records-split-divider"
        />

        <div className={styles.detailPanel} style={{ width: split.size }}>
          {isCreatingNew ? (
            <>
              <label className={styles.fieldLabel}>{t('records.fieldId')}</label>
              <input className={styles.input} value={newBrdpIdentifier ?? '…'} disabled />

              <label className={styles.fieldLabel}>{t('records.fieldTitle')}</label>
              <input
                className={styles.input}
                value={newBrdpTitle}
                onFocus={() => triggerNamingTip('title')}
                onChange={(e) => {
                  triggerNamingTip('title');
                  setNewBrdpTitle(e.target.value);
                }}
              />
              {namingTipAnchor === 'title' && (
                <NamingTip
                  standard={project.standard}
                  onGotIt={dismissNamingTipForSession}
                />
              )}
              <RenameSuggestions text={newBrdpTitle} vocabulary={vocabulary} onApply={setNewBrdpTitle} />

              <label className={styles.fieldLabel}>{t('records.fieldDefinition')}</label>
              <textarea
                className={styles.textarea}
                value={newBrdpDefinition}
                onFocus={() => triggerNamingTip('definition')}
                onChange={(e) => {
                  triggerNamingTip('definition');
                  setNewBrdpDefinition(e.target.value);
                }}
              />
              {namingTipAnchor === 'definition' && (
                <NamingTip
                  standard={project.standard}
                  onGotIt={dismissNamingTipForSession}
                />
              )}
              <RenameSuggestions text={newBrdpDefinition} vocabulary={vocabulary} onApply={setNewBrdpDefinition} />

              <label className={styles.fieldLabel}>{t('records.fieldProposal')}</label>
              <textarea
                className={styles.textarea}
                value={newBrdpProposal}
                onFocus={() => triggerNamingTip('proposal')}
                onChange={(e) => {
                  triggerNamingTip('proposal');
                  setNewBrdpProposal(e.target.value);
                }}
              />
              {namingTipAnchor === 'proposal' && (
                <NamingTip
                  standard={project.standard}
                  onGotIt={dismissNamingTipForSession}
                />
              )}
              <RenameSuggestions text={newBrdpProposal} vocabulary={vocabulary} onApply={setNewBrdpProposal} />
              <p className={styles.hint}>{t('records.vocabHint')}</p>

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
              <div className={styles.idRow}>
                <p className={styles.mono}>{selected.identifier}</p>
                <button type="button" onClick={() => setCompareDialogOpen(true)} title={t('records.compare.buttonTitle')} data-testid="compare-open">
                  {t('records.compare.button')}
                </button>
              </div>
              {compareDialogOpen && (
                <BrdpCompareDialog
                  projectId={projectId}
                  project={project}
                  selected={selected}
                  brdps={brdps}
                  canEdit={canEdit}
                  ruleFormat={ruleFormat}
                  vocabulary={vocabulary}
                  handleUpdate={handleUpdate}
                  onRuleCopied={() => {
                    setApprovalsRefreshToken((n) => n + 1);
                    setHistoryRefreshToken((n) => n + 1);
                  }}
                  onExplain={(entry) => {
                    ask.compareWith(entry);
                    setCompareDialogOpen(false);
                    requestAnimationFrame(() => {
                      askTextareaRef.current?.scrollIntoView({ block: 'center' });
                      askTextareaRef.current?.focus();
                    });
                  }}
                  onClose={() => setCompareDialogOpen(false)}
                />
              )}
              <label className={styles.fieldLabel}>{t('records.fieldTitle')}</label>
              <input
                className={styles.input}
                value={selected.title}
                disabled={!canEdit}
                onFocus={() => triggerNamingTip('title')}
                onChange={(e) => {
                  triggerNamingTip('title');
                  setBrdps((prev) => prev.map((b) => (b.id === selected.id ? { ...b, title: e.target.value } : b)));
                }}
                onBlur={(e) => canEdit && handleUpdate(selected.id, { title: e.target.value })}
              />
              {namingTipAnchor === 'title' && (
                <NamingTip
                  standard={project.standard}
                  onGotIt={dismissNamingTipForSession}
                />
              )}
              {canEdit && (
                <RenameSuggestions
                  text={selected.title}
                  vocabulary={vocabulary}
                  onApply={(newText) => {
                    setBrdps((prev) => prev.map((b) => (b.id === selected.id ? { ...b, title: newText } : b)));
                    handleUpdate(selected.id, { title: newText });
                  }}
                />
              )}
              <label className={styles.fieldLabel}>{t('records.fieldDefinition')}</label>
              <textarea
                className={styles.textarea}
                value={selected.definition}
                disabled={!canEdit}
                onFocus={() => triggerNamingTip('definition')}
                onChange={(e) => {
                  triggerNamingTip('definition');
                  setBrdps((prev) => prev.map((b) => (b.id === selected.id ? { ...b, definition: e.target.value } : b)));
                }}
                onBlur={(e) => canEdit && handleUpdate(selected.id, { definition: e.target.value })}
              />
              {namingTipAnchor === 'definition' && (
                <NamingTip
                  standard={project.standard}
                  onGotIt={dismissNamingTipForSession}
                />
              )}
              {canEdit && (
                <RenameSuggestions
                  text={selected.definition}
                  vocabulary={vocabulary}
                  onApply={(newText) => {
                    setBrdps((prev) => prev.map((b) => (b.id === selected.id ? { ...b, definition: newText } : b)));
                    handleUpdate(selected.id, { definition: newText });
                  }}
                />
              )}
              <label className={styles.fieldLabel}>{t('records.fieldProposal')}</label>
              <textarea
                className={styles.textarea}
                value={selected.proposal}
                disabled={!canEdit}
                onFocus={() => triggerNamingTip('proposal')}
                onChange={(e) => {
                  triggerNamingTip('proposal');
                  setBrdps((prev) => prev.map((b) => (b.id === selected.id ? { ...b, proposal: e.target.value } : b)));
                }}
                onBlur={(e) => canEdit && handleUpdate(selected.id, { proposal: e.target.value })}
              />
              {namingTipAnchor === 'proposal' && (
                <NamingTip
                  standard={project.standard}
                  onGotIt={dismissNamingTipForSession}
                />
              )}
              {canEdit && (
                <RenameSuggestions
                  text={selected.proposal}
                  vocabulary={vocabulary}
                  onApply={(newText) => {
                    setBrdps((prev) => prev.map((b) => (b.id === selected.id ? { ...b, proposal: newText } : b)));
                    handleUpdate(selected.id, { proposal: newText });
                  }}
                />
              )}
              <p className={styles.hint}>{t('records.vocabHint')}</p>

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
                  <SchemaIssueLines
                    issues={ruleFormatIssues(ruleDraftFormat)}
                    testIds={Object.fromEntries(ruleFormatIssues(ruleDraftFormat).map((i) => [i.code, 'rule-editor-format-error']))}
                  />
                  {ruleSaveError && (
                    <p className={styles.ruleErrorText} role="alert">
                      {ruleSaveError}
                    </p>
                  )}
                  <div className={styles.suggestionActions}>
                    <button
                      onClick={saveRuleEditor}
                      disabled={ruleBusy || ruleDraftBlocked}
                      title={ruleDraftFormat && !ruleDraftFormat.ok ? t('records.assistant.ruleAcceptDisabledFormat') : undefined}
                    >
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
                  {ruleApproval && canTestRule(ruleFormat) && <RuleTestIndicator approval={ruleApproval} />}
                  {savedTest && (
                    <div className={styles.ruleTestSavedActions}>
                      <button
                        type="button"
                        className={styles.linkButton}
                        onClick={() => setSavedTestOpenFor((id) => (id === selected.id ? null : selected.id))}
                        aria-expanded={savedTestOpenFor === selected.id}
                        data-testid="saved-rule-test-open"
                      >
                        {t('records.ruleTest.saved.open', { date: formatTestDate(savedTest.at, i18n.language) })}
                      </button>
                    </div>
                  )}
                  {ruleTestRecordError && (
                    <p className={styles.ruleErrorText} role="alert">
                      {t('records.ruleTest.recordError', { error: ruleTestRecordError })}
                    </p>
                  )}
                  <div className={styles.suggestionActions}>
                    {ruleStateOf(ruleApproval) === 'draft' && canTestRule(ruleFormat) && (
                      <TestRuleButton
                        aiProvider={aiProvider}
                        open={draftTestOpenFor === selected.id}
                        onToggle={() => setDraftTestOpenFor((id) => (id === selected.id ? null : selected.id))}
                      />
                    )}
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
                  {savedTest && savedTestOpenFor === selected.id && (
                    <SavedRuleTestPanel
                      key={selected.id}
                      saved={savedTest}
                      format={ruleFormat}
                      standard={project.standard}
                      vocabulary={vocabulary}
                      onClose={() => setSavedTestOpenFor(null)}
                      rerun={
                        ruleStateOf(ruleApproval) === 'draft'
                          ? {
                              ruleXml: ruleApproval.rule_xml,
                              approval: canEdit ? ruleApproval : null,
                              onRecord: (record) => recordDraftRuleTest(selected.id, ruleApproval.rule_xml, record),
                              onKeepPrevious: (record) => recordDraftRuleTest(selected.id, ruleApproval.rule_xml, record, { keepPrevious: true }),
                            }
                          : null
                      }
                    />
                  )}
                  {draftTestOpenFor === selected.id && ruleStateOf(ruleApproval) === 'draft' && aiProvider && canTestRule(ruleFormat) && (
                    <RuleTestPanel
                      key={`${selected.id}:${ruleApproval.rule_xml}`}
                      ruleXml={ruleApproval.rule_xml}
                      format={ruleFormat}
                      standard={project.standard}
                      schemaLocation={schemaLocationOf(project.project_config)}
                      brdp={selected}
                      aiProvider={aiProvider}
                      vocabulary={vocabulary}
                      onClose={() => setDraftTestOpenFor(null)}
                      onResult={(record) => recordDraftRuleTest(selected.id, ruleApproval.rule_xml, record)}
                      approval={canEdit ? ruleApproval : null}
                      onKeepPrevious={(record) => recordDraftRuleTest(selected.id, ruleApproval.rule_xml, record, { keepPrevious: true })}
                      onSuggestCorrectedRule={(failed) =>
                        suggestions.suggestCorrectedRule(
                          failed,
                          onlySelectedPendingEmbedding ? () => embedSelectedBrdpFirst(selected.id) : null
                        )
                      }
                      correctedRuleBlockedReason={
                        selectedSuggestion
                          ? t('records.assistant.pendingSuggestionBlocksNew')
                          : suggestDisabledByEmbeddings
                            ? t('records.ruleTest.review.blockedByEmbeddings')
                            : suggestRuleBlockedReason()
                      }
                    />
                  )}
                  {verifyDialog && (
                    <VerifyWarningDialog
                      warning={verifyDialog}
                      busy={ruleBusy}
                      onTestNow={testNowFromVerifyDialog}
                      onVerifyAnyway={doVerifyRule}
                      onCancel={() => setVerifyDialog(null)}
                    />
                  )}
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

                {/* Docs request (schema vocabulary check round), simplified
                    by the "solo determinista" follow-up: entirely
                    deterministic now, recomputed on selection/save -- non-
                    blocking, HR7-safe (never a false "not found": a
                    standard without a generated vocabulary shows the "not
                    available" notice instead of guessing). Two warning
                    kinds, both red, plus the neutral/muted "not available"
                    notice. Guarded by brdpId so a result from a PREVIOUS
                    BRDP never shows here after switching rows. */}
                {vocabResult && vocabResult.brdpId === selected.id && (
                  <div className={styles.vocabNotice}>
                    {!vocabResult.available && (
                      <p className={styles.muted}>
                        {t('records.assistant.vocabCheckUnavailable', { standard: project.standard })}
                      </p>
                    )}
                    <SchemaIssueLines issues={nameIssues(vocabResult, 'brdp', { standard: project.standard })} />
                  </div>
                )}

                {/* Ask header: the label and the schema search, which opens
                    the same floating card as the names in an answer. Keyed
                    by BRDP and project so a change empties it. */}
                <div className={styles.askHeader}>
                  <label className={styles.fieldLabel}>{t('records.assistant.askLabel')}</label>
                  <SchemaSearch
                    key={`${projectId}:${selected.id}`}
                    vocabulary={vocabulary}
                    standard={project.standard}
                    onOpen={schemaNav.open}
                  />
                </div>

                {/* The last exchange -- ask.question + ask.answer/error/loading --
                    always ABOVE the textarea (docs request: feel like a
                    mini conversation, not a submitted form). Only ever ONE
                    exchange shown, matching the one-turn chaining already
                    sent to the LLM: what's on screen and what it remembers
                    are always the same turn. */}
                {ask.lastAsked && (
                  <div className={styles.exchange}>
                    <p className={styles.exchangeQuestion}>
                      <span className={styles.exchangeYou}>{t('records.assistant.you')}:</span> {ask.lastAsked}
                    </p>
                    {ask.askPending ? (
                      <div className={styles.answerBox}>
                        <span className={styles.muted}>{t('records.assistant.thinking')}</span>
                      </div>
                    ) : ask.askError ? (
                      <div className={styles.answerBox} role="alert">
                        {t('records.assistant.errorPrefix')}: {ask.askError}
                      </div>
                    ) : (
                      <div className={styles.answerBox}>
                        {/* C1, Part 2: a structural question answered from the
                            schema cards, without the LLM. */}
                        {ask.answerSource === 'schema' && (
                          <p className={styles.schemaAnswerLabel} data-testid="ask-answer-deterministic">
                            {t('records.assistant.answerFromSchema', { standard: project.standard })}
                          </p>
                        )}
                        {/* Keyed by the text shown, so a new answer starts with
                            every "+N more" folded again. */}
                        {ask.answerSource === 'schema' && ask.schemaAnswerView ? (
                          <ReactMarkdown key={ask.schemaAnswerView.seq} components={schemaAnswerComponents}>
                            {ask.schemaAnswerView.display}
                          </ReactMarkdown>
                        ) : (
                          <ReactMarkdown>{ask.answer}</ReactMarkdown>
                        )}
                      </div>
                    )}
                    {/* "Ask: comprobar los nombres de la respuesta": names the
                        answer presents as real that the standard's schema
                        does not have (or has only as the other kind). A
                        warning only -- the answer above is never changed. */}
                    {!ask.askPending && !ask.askError && (
                      <SchemaIssueLines
                        issues={nameIssues(ask.answerNameCheck, 'answer', { standard: project.standard })}
                        testIds={ANSWER_ISSUE_TEST_IDS}
                      />
                    )}
                    {/* Docs request ("Servicio de fichas de esquema y su uso
                        en Ask"): discrete, clickable line under the ask.answer
                        -- absent entirely when no real schema names were
                        mentioned or the standard has no generated cards
                        (no line, matching the prompt having no SCHEMA FACTS
                        block either). Uses the EXACT same array that built
                        the prompt, never a second, possibly-diverging one. */}
                    {!ask.askPending && !ask.askError && ask.lastAskedSchemaFacts.length > 0 && (
                      <div className={styles.answerBox}>
                        <span className={styles.muted}>{t('records.assistant.schemaFactsUsed')}</span>{' '}
                        {ask.lastAskedSchemaFacts.map(({ name }, idx) => (
                          <span key={name}>
                            {idx > 0 && ', '}
                            <button
                              type="button"
                              className={styles.linkButton}
                              onClick={() =>
                                ask.setExpandedSchemaFactNames((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(name)) next.delete(name);
                                  else next.add(name);
                                  return next;
                                })
                              }
                            >
                              &lt;{name}&gt;
                            </button>
                          </span>
                        ))}
                        {ask.lastAskedSchemaFacts
                          .filter(({ name }) => ask.expandedSchemaFactNames.has(name))
                          .map(({ name, entry }) => (
                            <SchemaFactCard key={name} name={name} entry={entry} />
                          ))}
                      </div>
                    )}
                    {!ask.askPending && (
                      <button type="button" className={styles.linkButton} onClick={ask.clearAsk}>
                        {t('records.assistant.clear')}
                      </button>
                    )}
                  </div>
                )}

                <SchemaNavCard nav={schemaNav} standard={project.standard} />

                <textarea
                  ref={askTextareaRef}
                  className={styles.textarea}
                  rows={2}
                  value={ask.question}
                  onFocus={() => triggerNamingTip('ask')}
                  onChange={(e) => {
                    triggerNamingTip('ask');
                    ask.setQuestion(e.target.value);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !ask.busy) {
                      e.preventDefault();
                      ask.askGeneric();
                    }
                  }}
                  placeholder={t(
                    ask.prevTurn ? 'records.assistant.askFollowupPlaceholder' : 'records.assistant.askPlaceholder'
                  )}
                />
                {namingTipAnchor === 'ask' && (
                  <NamingTip
                    standard={project.standard}
                    onGotIt={dismissNamingTipForSession}
                  />
                )}

                {ask.compareBrdp ? (
                  <div className={styles.compareChip}>
                    <span>{t('records.assistant.comparingWith', { identifier: ask.compareBrdp.identifier })}</span>
                    <button
                      type="button"
                      className={styles.compareChipRemove}
                      onClick={ask.clearCompareBrdp}
                      aria-label={t('records.assistant.compareRemove')}
                    >
                      ✕
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className={styles.linkButton}
                    onClick={ask.compareOpen ? ask.closeCompareSearch : ask.openCompareSearch}
                  >
                    {t('records.assistant.compareLink')}
                  </button>
                )}

                {ask.compareOpen &&
                  !ask.compareBrdp &&
                  (() => {
                    const q = ask.compareQuery.trim().toLowerCase();
                    const recordsMatches = brdps
                      .filter((b) => b.id !== selected.id)
                      .filter(
                        (b) => !q || b.identifier.toLowerCase().includes(q) || (b.title || '').toLowerCase().includes(q)
                      )
                      .map((entry) => ({ source: 'records', entry }));
                    const catalogMatches = ask.compareCatalogEntries
                      .filter((c) => !q || c.identifier.toLowerCase().includes(q) || c.title.toLowerCase().includes(q))
                      .map((entry) => ({ source: 'catalog', entry }));
                    const allMatches = [...recordsMatches, ...catalogMatches];
                    return (
                      <div className={styles.catalogPicker}>
                        <input
                          className={styles.input}
                          value={ask.compareQuery}
                          onChange={(e) => ask.setCompareQuery(e.target.value)}
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
                                <button type="button" disabled={ask.compareBusy} onClick={() => ask.chooseCompareBrdp(candidate)}>
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
                  <button onClick={ask.askGeneric} disabled={ask.busy || !ask.question.trim() || !aiProvider}>
                    {ask.busy ? '…' : t('records.assistant.ask')}
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

                {suggestions.catalogLoadError && (
                  <p className={styles.vocabWarning} role="alert" data-testid="catalog-load-warning">
                    ⚠ {t('records.assistant.catalogLoadFailed', { error: suggestions.catalogLoadError })}
                  </p>
                )}
                <div className={styles.suggestionActions}>
                  {SUGGEST_KINDS.map((kind) => {
                    // docs request (Suggest Definition corpus round), point
                    // 1: an official catalog BRDP already has a standard-
                    // issued Definition -- checked against the real
                    // catalog table (suggestions.catalogIdentifierSet), never by
                    // identifier prefix. Only Suggest Definition is gated
                    // by this; Suggest Proposal/Rule are unaffected.
                    // (null = the catalog could not be loaded: the check is
                    // unavailable and said so below, never "not a catalog BRDP".)
                    const catalogDisabled = kind === 'definition' && Boolean(suggestions.catalogIdentifierSet?.has(selected.identifier));
                    // docs request (Suggest Proposal corpus round): Proposal
                    // is built ON TOP OF the Definition (the prompt cites it
                    // as fixed context) -- an empty Definition means there is
                    // nothing to build on, so the button is disabled here
                    // (the backend also rejects with 400, belt-and-braces).
                    // Allowed on catalog BRDPs -- the Proposal is the
                    // PROJECT's own, unlike Definition which the catalog
                    // already provides.
                    const definitionEmptyForProposal = kind === 'proposal' && !selected.definition?.trim();
                    // docs request (Suggest Rule round), Part 1: a rule
                    // implements a DECIDED Proposal -- disabled, with the
                    // reason shown, until it is (the backend repeats every
                    // check). Catalog BRDPs are allowed.
                    const ruleBlockedReason = kind === 'rule' ? suggestRuleBlockedReason() : null;
                    // docs request (per-BRDP suggestion round): ANY pending
                    // or resolved entry for this BRDP blocks ALL THREE
                    // buttons, not just the matching kind -- Discard (or
                    // Accept) first to regenerate, even the same kind.
                    const pendingBlocked = !!selectedSuggestion;
                    const prepare = onlySelectedPendingEmbedding ? () => embedSelectedBrdpFirst(selected.id) : null;
                    return (
                      <button
                        key={kind}
                        onClick={() =>
                          kind === 'rule'
                            ? suggestions.startRuleSuggestion({ prepare })
                            : suggestions.requestSuggestion(kind, prepare)
                        }
                        disabled={
                          pendingBlocked ||
                          !aiProvider ||
                          suggestDisabledByEmbeddings ||
                          catalogDisabled ||
                          definitionEmptyForProposal ||
                          !!ruleBlockedReason
                        }
                        title={
                          pendingBlocked
                            ? t('records.assistant.pendingSuggestionBlocksNew')
                            : catalogDisabled
                              ? t('records.assistant.suggestDefinitionCatalogDisabled')
                              : definitionEmptyForProposal
                                ? t('records.assistant.suggestProposalNeedsDefinition')
                                : ruleBlockedReason || undefined
                        }
                      >
                        {selectedSuggestion?.loading && selectedSuggestion.kind === kind
                          ? '…'
                          : t(`records.assistant.suggest${kind.charAt(0).toUpperCase()}${kind.slice(1)}`)}
                      </button>
                    );
                  })}
                </div>
                {/* Suggest Rule part 2: S1000D rules can be limited to some
                    schemas -- this link always opens the selector by hand
                    (the app also opens it on its own when the BRDP text
                    calls for it). Same availability as Suggest Rule. */}
                {supportsSchemaContext(project.standard) &&
                  !selectedSuggestion &&
                  aiProvider &&
                  !suggestDisabledByEmbeddings &&
                  !suggestRuleBlockedReason() && (
                    <button
                      type="button"
                      className={styles.linkButton}
                      title={t('records.assistant.limitToSchemasTitle')}
                      onClick={() =>
                        suggestions.startRuleSuggestion({
                          prepare: onlySelectedPendingEmbedding ? () => embedSelectedBrdpFirst(selected.id) : null,
                          manual: true,
                        })
                      }
                    >
                      {t('records.assistant.limitToSchemas')}
                    </button>
                  )}

                {selectedSuggestion?.kind === 'rule' && selectedSuggestion.selector && (
                  <RuleSchemaSelector
                    key={selected.id}
                    selector={selectedSuggestion.selector}
                    onGenerate={suggestions.generateRuleWithSchemas}
                    onCancel={() => suggestions.removeSuggestionEntry(selected.id)}
                  />
                )}

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

                {selectedSuggestion?.kind === 'rule' && !selectedSuggestion.loading && !selectedSuggestion.selector && (
                  <RuleSuggestionPanel
                    entry={selectedSuggestion}
                    standard={project.standard}
                    vocabulary={vocabulary}
                    canEdit={canEdit}
                    brdp={selected}
                    aiProvider={aiProvider}
                    onAccept={suggestions.acceptSuggestion}
                    onDiscard={suggestions.discardSuggestion}
                    onToggleReference={(id) => suggestions.toggleReferenceExpanded(selected.id, id)}
                    onPastedRuleChange={(value) => suggestions.setPastedRule(selected.id, value)}
                    onAcceptPasted={suggestions.acceptPastedRule}
                    onEnsurePastedCoverage={(rule) => suggestions.ensurePastedCoverage(selected.id, rule)}
                    onTestResult={(ruleXml, record) => suggestions.recordSuggestionTest(selected.id, ruleXml, record)}
                    onSuggestCorrectedRule={(failed) => suggestions.suggestCorrectedRule(failed)}
                    correctedRuleBlockedReason={suggestDisabledByEmbeddings ? t('records.ruleTest.review.blockedByEmbeddings') : null}
                  />
                )}

                {selectedSuggestion?.error && selectedSuggestion.kind !== 'rule' && (
                  <div className={styles.suggestionBox}>
                    <span className={styles.muted}>
                      ⚠ {t('records.assistant.errorPrefix')}: {selectedSuggestion.error}
                    </span>
                    <div className={styles.suggestionActions}>
                      <button onClick={suggestions.discardSuggestion}>{t('records.assistant.discard')}</button>
                    </div>
                  </div>
                )}

                {selectedSuggestion?.text && selectedSuggestion.kind !== 'rule' && (
                  <div className={styles.suggestionBox}>
                    <div className={styles.suggestionText}>
                      {selectedSuggestion.text}
                    </div>
                    <div className={styles.suggestionActions}>
                      <button
                        onClick={suggestions.acceptSuggestion}
                        disabled={!canEdit}
                        title={!canEdit ? t('records.assistant.acceptDisabledTitle') : undefined}
                      >
                        {t('records.assistant.accept')}
                      </button>
                      <button onClick={suggestions.discardSuggestion}>{t('records.assistant.discard')}</button>
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
                                      onToggle={() => suggestions.toggleReferenceExpanded(selected.id, c.id)}
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
                                      onToggle={() => suggestions.toggleReferenceExpanded(selected.id, c.id)}
                                    />
                                  ))}
                                </ul>
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    )}

                    {/* docs request (Suggest Proposal corpus round): same
                        app-generated-references principle as Definition
                        above, now across THREE groups instead of two --
                        Same BRDP in other projects / Similar decisions /
                        This project -- each row expands to show BOTH
                        Definition and Proposal (showProposal), since the
                        "Same BRDP" prompt block cites only Proposal but the
                        docs request still wants both visible on expand. */}
                    {selectedSuggestion.kind === 'proposal' && (
                      <div className={styles.suggestionReferences}>
                        {selectedSuggestion.sameBrdp.length === 0 &&
                        selectedSuggestion.similar.length === 0 &&
                        selectedSuggestion.thisProject.length === 0 ? (
                          <p className={styles.hint}>{t('records.assistant.proposalNoReferences')}</p>
                        ) : (
                          <>
                            {selectedSuggestion.sameBrdp.length > 0 && (
                              // docs request (Suggest Proposal round, "Same
                              // BRDP destacado"): this group is the most
                              // decision-relevant of the three (an exact
                              // identifier match, not a similarity guess),
                              // but read as just another bullet list --
                              // given more visual weight here (red, same
                              // #dc2626 as Refused, in a bordered box).
                              <div className={styles.referencesGroupHighlighted}>
                                <h4 className={`${styles.referencesGroupTitle} ${styles.referencesGroupTitleDanger}`}>
                                  {t('records.assistant.proposalSameBrdpGroup')}
                                </h4>
                                <ul className={styles.referencesList}>
                                  {selectedSuggestion.sameBrdp.map((c) => (
                                    <ReferenceRow
                                      key={`same-brdp-${c.id}`}
                                      candidate={c}
                                      showScore={false}
                                      showProposal
                                      danger
                                      expanded={selectedSuggestion.expandedReferenceIds.has(c.id)}
                                      onToggle={() => suggestions.toggleReferenceExpanded(selected.id, c.id)}
                                    />
                                  ))}
                                </ul>
                              </div>
                            )}
                            {selectedSuggestion.similar.length > 0 && (
                              <div>
                                <h4 className={styles.referencesGroupTitle}>
                                  {t('records.assistant.proposalSimilarGroup')}
                                </h4>
                                <ul className={styles.referencesList}>
                                  {selectedSuggestion.similar.map((c) => (
                                    <ReferenceRow
                                      key={`similar-${c.id}`}
                                      candidate={c}
                                      showScore
                                      showProposal
                                      expanded={selectedSuggestion.expandedReferenceIds.has(c.id)}
                                      onToggle={() => suggestions.toggleReferenceExpanded(selected.id, c.id)}
                                    />
                                  ))}
                                </ul>
                              </div>
                            )}
                            {selectedSuggestion.thisProject.length > 0 && (
                              <div>
                                <h4 className={styles.referencesGroupTitle}>
                                  {t('records.assistant.proposalThisProjectGroup')}
                                </h4>
                                <ul className={styles.referencesList}>
                                  {selectedSuggestion.thisProject.map((c) => (
                                    <ReferenceRow
                                      key={`this-project-${c.id}`}
                                      candidate={c}
                                      showScore
                                      showProposal
                                      expanded={selectedSuggestion.expandedReferenceIds.has(c.id)}
                                      onToggle={() => suggestions.toggleReferenceExpanded(selected.id, c.id)}
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
                <h3 className={styles.assistantTitle}>
                  <button
                    type="button"
                    className={styles.historyToggle}
                    aria-expanded={historyOpen}
                    onClick={toggleHistory}
                    data-testid="history-toggle"
                  >
                    <span className={styles.historyToggleArrow} aria-hidden="true">
                      {historyOpen ? '▾' : '▸'}
                    </span>
                    {t('records.history.titleCount', { count: history.length })}
                    {latestHistoryAt && (
                      <span className={styles.historyLatest} data-testid="history-latest">
                        {t('records.history.latest', { date: new Date(latestHistoryAt).toLocaleString() })}
                      </span>
                    )}
                  </button>
                </h3>
                {!historyOpen ? null : history.length === 0 ? (
                  <p className={styles.muted}>{t('records.history.empty')}</p>
                ) : (
                  <ul className={styles.historyList}>
                    {history.map((h) => {
                      const long = isLongHistoryEntry(h);
                      const expanded = long && expandedHistoryIds.has(h.id);
                      return (
                      <li key={h.id} className={styles.historyItem} data-testid="history-item">
                        <div className={styles.historyField}>
                          {t(`records.history.fields.${h.field_name}`, { defaultValue: h.field_name })}
                        </div>
                        <div
                          className={`${styles.historyChange} ${expanded ? styles.historyChangeExpanded : ''} ${
                            expanded && h.field_name === 'rule' ? styles.historyChangeCode : ''
                          }`}
                        >
                          <span className={styles.historyOld} title={expanded ? undefined : historyValueTitle(t, h.field_name, h.old_value)}>
                            {expanded ? fullHistoryValue(t, h.field_name, h.old_value) : formatHistoryValue(t, h.field_name, h.old_value)}
                          </span>
                          <span className={styles.historyArrow}>→</span>
                          <span
                            className={`${styles.historyNew} ${historyReviewTag(h) ? `${styles.historyResultTag} ${styles.ruleTestToneWarn}` : ''}`}
                            title={expanded ? undefined : historyValueTitle(t, h.field_name, h.new_value)}
                            data-testid={historyReviewTag(h) ? 'history-rule-test-review' : undefined}
                          >
                            {expanded ? fullHistoryValue(t, h.field_name, h.new_value) : formatHistoryValue(t, h.field_name, h.new_value)}
                          </span>
                        </div>
                        {expanded && h.field_name === 'rule_test' && <HistoryEditedExamples value={h.new_value} />}
                        {long && (
                          <button
                            type="button"
                            className={styles.linkButton}
                            aria-expanded={expanded}
                            onClick={() => toggleHistoryEntry(h.id)}
                            data-testid="history-show-more"
                          >
                            {t(expanded ? 'records.history.showLess' : 'records.history.showMore')}
                          </button>
                        )}
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
                      );
                    })}
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
