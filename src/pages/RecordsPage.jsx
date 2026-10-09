import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { numberDuplicateRuleIds, splitMultiPathRules } from '../utils/ruleSplit.js';
import RulePathWarnings from '../components/assistant/RulePathWarnings.jsx';
import { useOutletContext, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import { Trash2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { authFetchJson } from '../services/apiClient';
import { useAuthContext } from '../context/AuthContext';
import { errorMessage, isRetryable } from '../services/apiErrors';
import ErrorNotice from '../components/ErrorNotice';
import {
  SAVED_TEXT_FIELDS,
  blurAction,
  canRetry,
  discardBrdp,
  discardField,
  displayedValue,
  editField,
  failedEntries,
  fieldKey,
  hasUnsaved,
  recallUnsaved,
  reconcileWithSaved,
  rememberUnsaved,
  removeRow,
  restoreRow,
  saveFailed,
  saveSucceeded,
  startSave,
} from '../utils/unsavedFields.js';
import { checkWellFormed } from '../api/generateBREX.js';
import { STANDARD_TO_RULE_FORMAT } from '../constants/ruleFormats';
import { RULE_STATES, ruleStateOf } from '../utils/ruleState';
import SortableHeader from '../components/SortableHeader';
import { ProposalStatusSummary, RuleStatusSummary, VerifiedTestBreakdown } from '../components/StatusCountsSummary';
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
import RuleXmlView from '../components/assistant/RuleXmlView.jsx';
import RuleTestPanel, { canTestRule, formatTestDate, TestRuleButton } from '../components/assistant/RuleTestPanel';
import { RuleTestIndicator, VerifyWarningDialog } from '../components/assistant/RuleTestIndicator';
import SavedRuleTestPanel from '../components/assistant/SavedRuleTestPanel';
import { savedPassedTest } from '../utils/ruleTestSaved.js';
import { registerRuleTest } from '../api/ruleTests';
import { parseRuleTestHistoryValue, verifyWarning } from '../utils/ruleTestStatus.js';
import { formatRuleTestReason } from '../utils/ruleTestReasons.js';
import RuleStatusCell from '../components/RuleStatusCell';
import SchemaIssueLines from '../components/assistant/SchemaIssueLines';
import { useNameFixHints } from '../hooks/useNameFixHints.js';
import { cachedRuleCorrection, useCorrectionContext, useRuleCorrections } from '../hooks/useRuleCorrections.js';
import RuleCorrectionBlock from '../components/assistant/RuleCorrectionBlock.jsx';
import { correctionRecord, formatRuleDefect, formatRuleFix } from '../validation/ruleCorrection.js';
import { ruleXmlHash } from '../utils/ruleHash.js';
import SchemaNavCard from '../components/assistant/SchemaNavCard';
import BrdpCompareDialog from '../components/compare/BrdpCompareDialog';
import CatalogEditionTag from '../components/CatalogEditionTag';
import SchemaSearch from '../components/assistant/SchemaSearch';
import { useSchemaNavigation } from '../hooks/useSchemaNavigation';
import { fetchSchemaAttribute, fetchSchemaCards } from '../api/schemaFacts.js';
import { parseMoreMarker, schemaLinkTarget } from '../utils/schemaNavigation.js';
import { AnswerMoreNames, SchemaNameLink } from '../components/assistant/SchemaAnswerLinks';
import { NAME_HINT_TEST_IDS, checkRuleFormat, checkRuleNames, invalidRuleXPaths, nameIssues, ruleFormatIssues, xpathIssues } from '../validation/schemaValidation.js';
import styles from './RecordsPage.module.css';

// The data-testids the verification scripts read on the Ask answer's
// name warnings.
const ANSWER_ISSUE_TEST_IDS = {
  names_not_found: 'ask-answer-unknown-names',
  wrong_type_as_element: 'ask-answer-wrong-type',
  wrong_type_as_attribute: 'ask-answer-wrong-type',
};

const VALIDATION_OPTIONS = ['Pending', 'Validated', 'Refused'];
// The label of each text field saved on its own (AACF 1, Part 1).
const FIELD_LABEL_KEYS = {
  title: 'records.fieldTitle',
  definition: 'records.fieldDefinition',
  proposal: 'records.fieldProposal',
  comments: 'records.fieldRefusalReason',
};
const SUGGEST_KINDS = ['title', 'definition', 'proposal', 'rule'];

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
// 15 rows per page (docs request), prev/next pagination.
const TABLE_PAGE_SIZE = 15;

// Split between the table and the detail panel (C1, Part 3). The divider is
// also the gap between the two (it replaces the layout's 16px gap).
const DETAIL_PANEL_DEFAULT_WIDTH = 460;
const DETAIL_PANEL_MIN_WIDTH = 360;
// The largest width the server stores (backend Settings.ui_detail_width_max;
// keep in sync). Only rules out absurd values: wider than the window is
// clipped when shown anyway.
const DETAIL_PANEL_MAX_SAVED_WIDTH = 4000;
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

// AI Extract: the "extracted_from" event's value is JSON ({ file,
// origin_identifier, in_force?, catalog_edition?, catalog_standard? }); it
// reads as "<file> (source ID <id>)",
// or "validated and verified on import from <file> …" when it was imported
// as already in force. From a free text ({ source: "text", quote, file: ""
// for a pasted text}): "<file or Pasted text> (…): “quote”".
function formatExtractedFromValue(t, value) {
  if (!value) return '—';
  try {
    const parsed = JSON.parse(value);
    if (parsed.source === 'text') {
      const file = parsed.file || t('records.history.extractedFromPastedText');
      return parsed.origin_identifier
        ? t('records.history.extractedFromTextValue', { file, origin: parsed.origin_identifier, quote: parsed.quote })
        : t('records.history.extractedFromTextValueNoId', { file, quote: parsed.quote });
    }
    const key = parsed.in_force ? 'extractedFromValueInForce' : 'extractedFromValue';
    const text = parsed.origin_identifier
      ? t(`records.history.${key}`, { file: parsed.file, origin: parsed.origin_identifier })
      : t(`records.history.${key}NoId`, { file: parsed.file });
    // Taken from another edition's catalog: "…; S1000D 4.1 catalog, not in S1000D 4.2".
    return parsed.catalog_edition
      ? `${text}; ${t('records.history.extractedFromCatalogEdition', { edition: parsed.catalog_edition, standard: parsed.catalog_standard })}`
      : text;
  } catch {
    return value;
  }
}

// Excel import: the texts came from another S1000D edition's catalog
// ({ catalog_edition, catalog_standard }) -- "S1000D 4.1 catalog, not in
// S1000D 4.2", the same text AI Extract's event ends with.
function formatCatalogEditionValue(t, value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return t('records.history.extractedFromCatalogEdition', { edition: parsed.catalog_edition, standard: parsed.catalog_standard });
  } catch {
    return value || '—';
  }
}

// Corrección propuesta: the "rule_corrected" event's value is JSON
// ({ fixes: [{ code, params, fix }], remaining }) -- each defect fixed and
// how, then what was left, in the viewer's language.
function formatRuleCorrectedValue(t, value) {
  if (!value) return '—';
  try {
    const parsed = JSON.parse(value);
    const fixed = (parsed.fixes || []).map((d) => `${formatRuleDefect(d, t)} → ${formatRuleFix(d.fix, t)}`).join(' ');
    const left = (parsed.remaining || []).map((d) => formatRuleDefect(d, t)).join(' ');
    return left ? `${fixed} ${t('records.ruleCorrection.remainingHeading')} ${left}` : fixed;
  } catch {
    return value;
  }
}

function extractedQuoteLength(value) {
  try {
    return (JSON.parse(value || '{}').quote || '').length;
  } catch {
    return 0;
  }
}

// The full value on hover: the raw text, except a rule test (its codes
// would read as JSON), which shows its translated text.
function historyValueTitle(t, fieldName, value) {
  if (!value) return undefined;
  if (fieldName === 'rule_copied') return formatRuleCopiedValue(value);
  if (fieldName === 'rule_corrected') return formatRuleCorrectedValue(t, value);
  if (fieldName === 'extracted_from') return formatExtractedFromValue(t, value);
  if (fieldName === 'catalog_edition') return formatCatalogEditionValue(t, value);
  // AACF 3, Part 3: a status value reads in the interface language in its
  // tooltip too, never as the stored token ("verified", "draft").
  const prefix = HISTORY_TRANSLATED_FIELDS[fieldName];
  if (prefix) return t(`${prefix}.${value}`, { defaultValue: value });
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
  // An extraction from free text carries its quote: long when the quote is.
  if (entry.field_name === 'extracted_from') return extractedQuoteLength(entry.new_value) > HISTORY_MAX_CHARS - 60;
  if (entry.field_name === 'rule_corrected') return formatRuleCorrectedValue(i18n.t.bind(i18n), entry.new_value).length > HISTORY_MAX_CHARS;
  if (HISTORY_TRANSLATED_FIELDS[entry.field_name] || entry.field_name === 'rule_copied' || entry.field_name === 'catalog_edition') return false;
  return [entry.old_value, entry.new_value].some((v) => historyText(entry.field_name, v).length > HISTORY_MAX_CHARS);
}

function historyText(fieldName, value) {
  if (!value) return '';
  return fieldName === 'rule' ? value.replace(/\s+/g, ' ').trim() : value;
}

// The whole value of an expanded entry: the text as it was saved (a rule
// keeps its line breaks and indentation).
function fullHistoryValue(t, fieldName, value) {
  if (fieldName === 'extracted_from') return formatExtractedFromValue(t, value);
  if (fieldName === 'rule_corrected') return formatRuleCorrectedValue(t, value);
  if (fieldName === 'rule_test' || fieldName === 'rule_copied' || fieldName === 'extracted_from' || fieldName === 'catalog_edition' || HISTORY_TRANSLATED_FIELDS[fieldName]) return formatHistoryValue(t, fieldName, value);
  return value || '—';
}

// A rule test recorded as "review" (the examples passed but the rule does
// not seem to implement the Proposal) reads as an amber label in History,
// like the indicator.
function historyReviewTag(entry) {
  return entry.field_name === 'rule_test' && parseRuleTestHistoryValue(entry.new_value)?.result === 'review';
}

function formatHistoryValue(t, fieldName, value) {
  if (fieldName === 'rule_test') return formatRuleTestHistoryValue(t, value);
  if (fieldName === 'rule_corrected') {
    const text = formatRuleCorrectedValue(t, value);
    return text.length > HISTORY_MAX_CHARS ? `${text.slice(0, HISTORY_MAX_CHARS)}…` : text;
  }
  if (fieldName === 'rule_copied') return formatRuleCopiedValue(value);
  if (fieldName === 'catalog_edition') return formatCatalogEditionValue(t, value);
  if (fieldName === 'extracted_from') {
    const text = formatExtractedFromValue(t, value);
    return text.length > HISTORY_MAX_CHARS ? `${text.slice(0, HISTORY_MAX_CHARS)}…` : text;
  }
  const prefix = HISTORY_TRANSLATED_FIELDS[fieldName];
  if (prefix) return t(`${prefix}.${value}`, { defaultValue: value });
  if (!value) return '—';
  const text = historyText(fieldName, value);
  return text.length > HISTORY_MAX_CHARS ? `${text.slice(0, HISTORY_MAX_CHARS)}…` : text;
}

// Corrección propuesta, Part 2: how many saved rules have a proposed
// correction and how many a defect without a fix -- each a filter of the
// list (one BRDP at a time is accepted or discarded in its ficha; there is
// no "accept all"). While the rules are being checked, the progress.
function CorrectionCounts({ corrections, active, onSelect }) {
  const { t } = useTranslation();
  if (corrections.status === 'error') {
    return (
      <ErrorNotice
        testId="records-notice-corrections"
        message={t('records.ruleCorrection.list.failed', { reason: errorMessage(corrections.error, t) })}
        onRetry={corrections.retry}
      />
    );
  }
  if (corrections.status !== 'done') {
    if (corrections.status !== 'checking' || corrections.progress.total === 0) return null;
    return (
      <div className={styles.correctionCounts} data-testid="correction-progress">
        <span className={styles.hint}>{t('records.ruleCorrection.list.checking', corrections.progress)}</span>
      </div>
    );
  }
  const { proposed, unfixable } = corrections.counts;
  const item = (kind, count, label) => (
    <button
      type="button"
      className={styles.linkButton}
      data-testid={`correction-count-${kind}`}
      data-count={count}
      aria-pressed={active === kind}
      disabled={count === 0 && active !== kind}
      onClick={() => onSelect(active === kind ? '' : kind)}
      title={t('records.ruleCorrection.list.title')}
    >
      {active === kind ? <strong>{label}</strong> : label}
    </button>
  );
  return (
    <div className={styles.correctionCounts} data-testid="correction-counts">
      {item('proposed', proposed, t('records.ruleCorrection.list.proposed', { count: proposed }))}
      {item('unfixable', unfixable, t('records.ruleCorrection.list.unfixable', { count: unfixable }))}
      {active && (
        <button type="button" className={styles.linkButton} onClick={() => onSelect('')} data-testid="correction-filter-clear">
          {t('records.ruleCorrection.list.clearFilter')}
        </button>
      )}
    </div>
  );
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
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  // AACF 1, Part 1: what was typed and not saved yet (utils/unsavedFields.js)
  // -- `brdps` keeps only what the server saved, so the table and the rest
  // of the page never show a text the server did not accept. Remembered in
  // memory per project, so an expired session (the login page replaces this
  // one, then comes back) does not lose it; the browser's own "leave the
  // page?" protects a reload or a closed tab.
  const [unsaved, setUnsaved] = useState(() => recallUnsaved(projectId));
  const unsavedRef = useRef(unsaved);
  unsavedRef.current = unsaved;
  const unsavedOwnerRef = useRef(projectId);
  useEffect(() => {
    rememberUnsaved(unsavedOwnerRef.current, unsaved);
  }, [unsaved]);
  useEffect(() => {
    if (unsavedOwnerRef.current === projectId) return;
    unsavedOwnerRef.current = projectId;
    setUnsaved(recallUnsaved(projectId));
  }, [projectId]);
  useEffect(() => {
    if (!hasUnsaved(unsaved)) return undefined;
    const warn = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [unsaved]);
  // Entries remembered from before (the page came back after a session
  // expired) are checked against the BRDPs once they load.
  const reconcileUnsavedRef = useRef(unsaved.size > 0);

  // AACF 1, Part 1: the failures shown with ErrorNotice that are not a
  // field's -- key -> { message, retry }. "status:<id>" and "rule:<id>"
  // show under their control; the rest at the top of the page.
  const [notices, setNotices] = useState(() => new Map());
  const showNotice = (key, notice) =>
    setNotices((m) => {
      const next = new Map(m);
      next.set(key, notice);
      return next;
    });
  const clearNotice = (key) =>
    setNotices((m) => {
      if (!m.has(key)) return m;
      const next = new Map(m);
      next.delete(key);
      return next;
    });
  const fieldLabel = (field) => t(FIELD_LABEL_KEYS[field]);
  const [tableSearchQuery, setTableSearchQuery] = useState('');
  const [tablePage, setTablePage] = useState(1);
  // '' = "All" -- omitted from the GET /brdps query entirely (no filter),
  // matching Proposal Status's real "validation" values / Rule Status's
  // RULE_STATES keys exactly, so no separate translation layer is needed
  // between the <select>'s value and the API's own query param vocabulary.
  const [proposalStatusFilter, setProposalStatusFilter] = useState('');
  const [ruleStatusFilter, setRuleStatusFilter] = useState('');
  // AACF 2, Part 2: one category of the verified rules' test breakdown in
  // the header ('' = none); applied by the server (test_category), with
  // the same function as each rule's indicator.
  const [testCategoryFilter, setTestCategoryFilter] = useState('');
  // The project's REAL totals (GET /brdps/stats) for the header summary --
  // deliberately independent of proposalStatusFilter/ruleStatusFilter
  // above (see brdps.py's get_brdp_stats docstring): the header always
  // shows the whole project's counts, never "count of the currently
  // filtered view". Zeroed by default so a brand-new project's header
  // never shows undefined/NaN before the first real fetch resolves.
  const [stats, setStats] = useState({
    proposal_status_counts: { pending: 0, validated: 0, refused: 0 },
    rule_status_counts: { to_do: 0, draft: 0, verified: 0 },
    verified_test_counts: null,
  });
  // AACF 1, Part 2: totals that could not be refreshed are not shown as if
  // they were current.
  const [statsFailed, setStatsFailed] = useState(false);
  // null = unsorted (API order). Sorting is applied to the FULL filtered
  // dataset before pagination (docs request), not just the visible page.
  const [sortField, setSortField] = useState(null);
  const [sortDir, setSortDir] = useState('asc');
  const [approvalsRefreshToken, setApprovalsRefreshToken] = useState(0);
  // Every BRDP's rule-approval status for the project's rule format, in
  // one call -- needed to sort the Rule Status column across the full
  // dataset; the table's per-row RuleStatusCell keeps fetching its own
  // status independently for display, this is only for sorting.
  // undefined while loading, null when the load failed (the column then
  // shows no status -- never an invented one, AACF 1 Part 2), else a map
  // brdp_id -> { status }. It feeds the column's dots too (one request for
  // the whole table instead of one per row).
  const [ruleApprovalsById, setRuleApprovalsById] = useState(undefined);
  const [approvalsReloadToken, setApprovalsReloadToken] = useState(0);

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
  // Its load failed: said, with Retry (instead of "…" for ever).
  const [ruleApprovalLoadError, setRuleApprovalLoadError] = useState(null);
  const [ruleApprovalReloadToken, setRuleApprovalReloadToken] = useState(0);
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
  // Mejoras B, Part 4.2-4.3: what "Split into N rules" / "Number the ids" did.
  const [ruleEditorNote, setRuleEditorNote] = useState(null);
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
  // "Historial desplegable": the section starts collapsed on every page
  // load and keeps its state while another BRDP is selected within the
  // page (AACF 3: nothing is stored in the browser, HR1); long entries
  // open one by one with "Show more".
  const [historyOpen, setHistoryOpen] = useState(false);
  const toggleHistory = () => setHistoryOpen((open) => !open);
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
  const [historyLoadError, setHistoryLoadError] = useState(null);
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
  // A list that could not be loaded is said (with Retry), never an empty
  // table that looks like a project without BRDPs (AACF 1, Part 1: the
  // refresh after a save that worked fails apart from the save).
  const refresh = () => {
    const params = new URLSearchParams();
    if (proposalStatusFilter) params.set('proposal_status', proposalStatusFilter);
    if (ruleStatusFilter) params.set('rule_status', ruleStatusFilter);
    if (testCategoryFilter) params.set('test_category', testCategoryFilter);
    const qs = params.toString();
    return authFetchJson(`/api/projects/${projectId}/brdps${qs ? `?${qs}` : ''}`)
      .then((data) => {
        setBrdps(data);
        setIsLoading(false);
        clearNotice('refresh');
        if (reconcileUnsavedRef.current) {
          reconcileUnsavedRef.current = false;
          setUnsaved((current) => reconcileWithSaved(current, data, t('records.unsaved.notConfirmed')));
          const first = [...unsavedRef.current.values()][0];
          if (first && !selectedIdRef.current) setSelectedId(first.brdpId);
        }
      })
      .catch((err) => {
        setIsLoading(false);
        showNotice('refresh', { message: t('records.loadErrors.list', { reason: errorMessage(err, t) }), retry: refresh });
      });
  };

  // Always the project's REAL, unfiltered totals (GET .../stats never takes
  // proposalStatusFilter/ruleStatusFilter) -- the header summary must never
  // read as "count of the currently filtered view". Totals that could not
  // be refreshed are hidden and said (AACF 1, Part 2), never kept as if
  // they were current.
  const refreshStats = () =>
    authFetchJson(`/api/projects/${projectId}/brdps/stats`)
      .then((data) => {
        setStats(data);
        setStatsFailed(false);
        clearNotice('stats');
      })
      .catch((err) => {
        setStatsFailed(true);
        showNotice('stats', { message: t('records.loadErrors.stats', { reason: errorMessage(err, t) }), retry: refreshStats });
      });

  useEffect(() => {
    setProposalStatusFilter('');
    setRuleStatusFilter('');
    setTestCategoryFilter('');
    authFetchJson('/api/config/ai-provider').then(setAiProvider).catch(() => setAiProvider(null));
  }, [projectId]);

  useEffect(() => {
    refresh();
    refreshStats();
    setTablePage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, proposalStatusFilter, ruleStatusFilter, testCategoryFilter]);

  // Rule Status counts in the header can change from a rule-approval
  // action (Verify/Revoke/manual save/accepted suggestion) alone, with no
  // BRDP field PUT and therefore no other refresh() call site touching it
  // -- approvalsRefreshToken is already the shared signal those actions
  // bump today (see RuleStatusCell/the detail panel's own fetch above).
  useEffect(() => {
    refreshStats();
    // A rule that changes category (a test recorded, the rule edited,
    // Verify/Revoke) leaves or joins the filtered table at once; with the
    // last one gone the table is empty and the filter stays, easy to remove.
    if (testCategoryFilter) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approvalsRefreshToken]);

  const selected = brdps.find((b) => b.id === selectedId) || null;
  const { vocabulary, vocabResult, recomputeVocabResult, vocabularyLoadError, retryVocabularyLoad } = useVocabularyCheck(
    project.standard,
    selected
  );
  // Corrección propuesta: every saved rule checked by code, in slices (see
  // src/hooks/useRuleCorrections.js), and the list filtered by the result.
  const correctionContext = useCorrectionContext({
    standard: project.standard,
    vocabulary,
    vocabularyLoadError,
    schemaLocation: schemaLocationOf(project.project_config, project.standard),
  });
  const ruleCorrections = useRuleCorrections({ projectId, format: ruleFormat, correction: correctionContext, refreshToken: approvalsRefreshToken });
  const [correctionFilter, setCorrectionFilter] = useState('');
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
    if (correctionFilter && ruleCorrections.byBrdpId.get(b.id)?.status !== correctionFilter) return false;
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
          // Without the rule statuses (loading, or their load failed) there
          // is nothing to sort by: the order stays as it is.
          cmp = ruleApprovalsById
            ? compareByFlowOrder(
                RULE_STATES,
                ruleStateOf(ruleApprovalsById[a.id] ?? null),
                ruleStateOf(ruleApprovalsById[b.id] ?? null)
              )
            : 0;
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

  // Every BRDP's rule status in one request: the Rule Status column's dots
  // and its sort -- refetched whenever an Edit/Verify/Revoke action bumps
  // approvalsRefreshToken. A standard without a rule format (S1000D 5.0/6.0)
  // gets an empty map (the column shows "—"). A failed load leaves the
  // column without a status and says so, with Retry -- never "To Do" for
  // every row (AACF 1, Part 2).
  useEffect(() => {
    if (!ruleFormat) {
      setRuleApprovalsById({});
      return undefined;
    }
    let cancelled = false;
    authFetchJson(`/api/projects/${projectId}/approvals/${ruleFormat}`)
      .then((rows) => {
        if (cancelled) return;
        const byId = {};
        for (const row of rows) byId[row.brdp_id] = { status: row.status };
        setRuleApprovalsById(byId);
        clearNotice('approvals');
      })
      .catch((err) => {
        if (cancelled) return;
        setRuleApprovalsById(null);
        showNotice('approvals', {
          message: t('records.loadErrors.approvals', { reason: errorMessage(err, t) }),
          retry: () => setApprovalsReloadToken((n) => n + 1),
        });
      });
    return () => {
      cancelled = true;
    };
    // showNotice/clearNotice/t are stable for this purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, ruleFormat, approvalsRefreshToken, approvalsReloadToken]);

  // T3: another BRDP starts without the previous one's warning or error
  // (not on an approvals refresh -- that one follows the very recording
  // whose error must stay visible).
  useEffect(() => {
    setRuleTestRecordError(null);
    setCorrectionError(null);
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
    setRuleApprovalLoadError(null);
    authFetchJson(`/api/projects/${projectId}/brdps/${selected.id}/approvals/${ruleFormat}`)
      .then((data) => {
        if (!cancelled) setRuleApproval(data);
      })
      .catch((err) => {
        if (!cancelled) setRuleApprovalLoadError(t('records.loadErrors.rule', { reason: errorMessage(err, t) }));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, ruleFormat, approvalsRefreshToken, ruleApprovalReloadToken]);

  // Prompt-refactor round: the vocabulary check (its own "recompute on
  // BRDP selection" effect included), the Ask panel (its own "reset on
  // BRDP selection" effect included) and Suggest are each a dedicated hook
  // now -- see src/hooks/{useVocabularyCheck,useAskAssistant,
  // useSuggestions}.js. Same behavior as before the refactor, split by
  // concern instead of one giant effect.
  // (useVocabularyCheck is called right after `selected` is known, above:
  // the check of the project's rules needs the vocabulary before the list
  // is filtered.)
  // "Sugerencias para erratas": near names / other standards after the
  // red "not found" line of the selected BRDP.
  const vocabNameHints = useNameFixHints(vocabResult && vocabResult.brdpId === selected?.id ? vocabResult : null, project.standard, vocabulary);

  // AACF 1, Part 1. Everything that follows a save runs only once it
  // succeeded: history, the list (filters may move the row), the totals,
  // the embeddings gate and -- for the selected BRDP -- the vocabulary
  // notice, recomputed against the text the server saved.
  const afterSave = (saved) => {
    setHistoryRefreshToken((n) => n + 1);
    refresh();
    refreshStats();
    invalidatePendingEmbeddings(projectId);
    if (saved.id === selectedIdRef.current) recomputeVocabResult(saved);
  };

  // The saved BRDP from the server, merged into the list -- only the fields
  // this save sent (another save or an optimistic change of the same row may
  // be on its way).
  const mergeSaved = (saved, fields) =>
    setBrdps((list) =>
      list.map((b) => (b.id === saved.id ? { ...b, ...Object.fromEntries(fields.map((f) => [f, saved[f]])), updated_at: saved.updated_at } : b))
    );

  // Only the answer to the latest send of a field may change its state.
  const sendSeqRef = useRef(new Map());
  // The sends of one field reach the server one after another: leaving the
  // field (blur) and a "Did you mean" chip clicked right after sent two PUTs
  // at once, the server could apply the chip's first and the typed text
  // last, and the saved field went back to the uncorrected text.
  const sendChainRef = useRef(new Map());

  // Saves one text field. On success the entry goes and the saved value is
  // what the page shows; on failure the typed text stays in the field,
  // marked "Not saved" with the reason (ErrorNotice), and nothing that
  // follows a save runs. Returns { ok, message }.
  const saveTextField = async (brdpId, field, value) => {
    const key = fieldKey(brdpId, field);
    const seq = (sendSeqRef.current.get(key) || 0) + 1;
    sendSeqRef.current.set(key, seq);
    setUnsaved((current) => startSave(current, brdpId, field, value));
    const previous = sendChainRef.current.get(key) || Promise.resolve();
    const send = previous.then(() =>
      authFetchJson(`/api/projects/${projectId}/brdps/${brdpId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: value }),
      })
    );
    sendChainRef.current.set(key, send.catch(() => {}));
    try {
      const saved = await send;
      if (sendSeqRef.current.get(key) !== seq) return { ok: true };
      setUnsaved((current) => saveSucceeded(current, brdpId, field, value));
      mergeSaved(saved, [field]);
      afterSave(saved);
      return { ok: true };
    } catch (err) {
      const message = errorMessage(err, t);
      if (sendSeqRef.current.get(key) === seq) {
        setUnsaved((current) => saveFailed(current, brdpId, field, value, { message, retryable: isRetryable(err) }));
      }
      return { ok: false, message };
    }
  };

  // Leaving a text field saves it (or drops an entry that is the saved
  // text again).
  const commitField = (brdp, field) => {
    if (!canEdit || !brdp) return;
    const action = blurAction(unsavedRef.current, brdp, field);
    if (action === 'discard') setUnsaved((current) => discardField(current, brdp.id, field));
    else if (action === 'save') saveTextField(brdp.id, field, unsavedRef.current.get(fieldKey(brdp.id, field)).value);
  };

  const typeField = (brdpId, field, value) => setUnsaved((current) => editField(current, brdpId, field, value));

  const retryField = (entry) => saveTextField(entry.brdpId, entry.field, entry.value);
  const discardFieldChange = (entry) => setUnsaved((current) => discardField(current, entry.brdpId, entry.field));

  // Proposal Status, optimistic (HR20): the new value shows at once; if the
  // server refuses it, the previous one comes back with the reason.
  const statusSeqRef = useRef(new Map());
  const changeValidation = async (brdpId, value) => {
    const before = brdps.find((b) => b.id === brdpId);
    if (!before || before.validation === value) return { ok: true };
    const previous = before.validation;
    const seq = (statusSeqRef.current.get(brdpId) || 0) + 1;
    statusSeqRef.current.set(brdpId, seq);
    clearNotice(`status:${brdpId}`);
    setBrdps((list) => list.map((b) => (b.id === brdpId ? { ...b, validation: value } : b)));
    try {
      const saved = await authFetchJson(`/api/projects/${projectId}/brdps/${brdpId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ validation: value }),
      });
      if (statusSeqRef.current.get(brdpId) !== seq) return { ok: true };
      mergeSaved(saved, ['validation']);
      afterSave(saved);
      return { ok: true };
    } catch (err) {
      const message = errorMessage(err, t);
      if (statusSeqRef.current.get(brdpId) === seq) {
        setBrdps((list) => list.map((b) => (b.id === brdpId && b.validation === value ? { ...b, validation: previous } : b)));
        showNotice(`status:${brdpId}`, {
          message: t('records.actionErrors.status', { value: t(`records.validationOptions.${value}`), reason: message }),
          retry: () => changeValidation(brdpId, value),
        });
      }
      return { ok: false, message };
    }
  };

  // The one entry point for a change coming from outside the fields
  // (accepting a suggestion, Compare's "use this Proposal", "Did you mean",
  // reverting a History entry): a text goes into its field and is saved the
  // same way -- on failure it stays there as "Not saved" -- and Proposal
  // Status goes the optimistic way. Throws with the reason when something
  // did not save (the caller may show it too).
  const handleUpdate = async (brdpId, patch) => {
    const failures = [];
    for (const [field, value] of Object.entries(patch)) {
      let result;
      if (field === 'validation') result = await changeValidation(brdpId, value);
      else if (SAVED_TEXT_FIELDS.includes(field)) {
        typeField(brdpId, field, value);
        result = await saveTextField(brdpId, field, value);
      } else continue;
      if (!result.ok) failures.push(result.message);
    }
    if (failures.length) throw new Error(failures.join(' '));
  };

  // Leaving a BRDP whose change did not save asks first (and, if the user
  // leaves, that change is dropped). Returns whether it is fine to leave.
  const confirmLeaveSelected = () => {
    if (!selectedId) return true;
    const failed = failedEntries(unsavedRef.current, selectedId);
    if (failed.length === 0) return true;
    const identifier = brdps.find((b) => b.id === selectedId)?.identifier ?? '';
    const fields = failed.map((e) => fieldLabel(e.field)).join(', ');
    if (!window.confirm(t('records.unsaved.leaveConfirm', { identifier, fields }))) return false;
    setUnsaved((current) => discardBrdp(current, selectedId, { onlyFailed: true }));
    return true;
  };

  const selectBrdp = (brdpId) => {
    if (brdpId === selectedId) return;
    if (!confirmLeaveSelected()) return;
    setSelectedId(brdpId);
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
    // Only a change of the answer shown closes the card: listing the card's
    // own state (open, close) would close it the moment it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    schemaLocation: schemaLocationOf(project.project_config, project.standard),
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
    setHistoryLoadError(null);
    authFetchJson(`/api/projects/${projectId}/brdps/${selected.id}/history`)
      .then((data) => {
        if (!cancelled) setHistory(data);
      })
      .catch((err) => {
        if (cancelled) return;
        setHistory([]);
        setHistoryLoadError(t('records.loadErrors.history', { reason: errorMessage(err, t) }));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, historyRefreshToken]);

  const openRuleEditor = () => {
    setRuleDraftText(ruleApproval?.rule_xml || '');
    setRuleEditorNote(null);
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
  // Mejoras G, Part 2.4 a: an XPath that does not parse -- with the missing
  // or extra parenthesis, bracket or quote (Mejoras F) -- while typing.
  const ruleDraftXPathIssues = ruleEditing && ruleDraftText.trim() && checkWellFormed(ruleDraftText).valid ? xpathIssues(invalidRuleXPaths(ruleDraftText)) : [];
  const ruleDraftBlocked = ruleEditing && (!ruleDraftText.trim() || (ruleDraftFormat && !ruleDraftFormat.ok));
  const ruleDraftSplit = ruleDraftFormat?.problem?.code === 'rule_format_multiple' ? splitMultiPathRules(ruleDraftText, ruleFormat) : { total: 0 };
  // The names of the draft's XPath against the vocabulary, with the near
  // names / other standards of the ones that do not exist: warning lines
  // only, never block Save and never a one-click fix (the XML is edited by
  // hand) -- the same lines Paste rule shows.
  const ruleDraftNames = ruleEditing && ruleDraftText.trim() && vocabulary ? checkRuleNames(ruleDraftText, vocabulary) : null;
  const ruleDraftNameHints = useNameFixHints(ruleDraftNames, project.standard, vocabulary);

  // Verify and Revoke, optimistic (HR20): the client knows the result
  // beforehand -- Verified, or Draft -- so it shows at once; the server only
  // adds the approval time, which the page does not show. If the server
  // refuses, the previous state comes back with the reason, under the rule.
  const changeRuleState = async (action, nextStatus) => {
    const brdpId = selected.id;
    const previous = ruleApproval;
    clearNotice(`rule:${brdpId}`);
    setRuleApproval((current) => (current ? { ...current, status: nextStatus } : current));
    setRuleApprovalsById((m) => (m ? { ...m, [brdpId]: { status: nextStatus } } : m));
    setRuleBusy(true);
    try {
      await authFetchJson(`/api/projects/${projectId}/brdps/${brdpId}/approvals/${ruleFormat}/${action}`, { method: 'POST' });
      setApprovalsRefreshToken((n) => n + 1);
      setHistoryRefreshToken((n) => n + 1);
    } catch (err) {
      if (selectedIdRef.current === brdpId) setRuleApproval(previous);
      setRuleApprovalsById((m) => (m ? { ...m, [brdpId]: { status: previous?.status } } : m));
      showNotice(`rule:${brdpId}`, {
        message: t(action === 'approve' ? 'records.actionErrors.verify' : 'records.actionErrors.revoke', { reason: errorMessage(err, t) }),
        retry: selectedIdRef.current === brdpId ? () => changeRuleState(action, nextStatus) : null,
      });
    } finally {
      setRuleBusy(false);
    }
  };

  const doVerifyRule = () => {
    setVerifyDialog(null);
    return changeRuleState('approve', 'approved');
  };

  // Test de reglas T3, Part 3: moving a rule to Verified warns -- never
  // blocks (user decision) -- when its recorded test is missing, outdated,
  // failed, inconclusive or could not run. This is the only path in the
  // application that moves a rule to Verified (the Excel import is left as
  // it is, docs request).
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

  const revokeRule = () => changeRuleState('revoke', 'pending_review');

  // Corrección propuesta, Part 1: what code finds wrong with the selected
  // BRDP's SAVED rule (the same cached check the project list uses), with
  // the project-level defect of an id shared with another BRDP.
  const [correctionBusy, setCorrectionBusy] = useState(false);
  const [correctionError, setCorrectionError] = useState(null);
  const selectedRuleXml = ruleApproval?.rule_xml || '';
  // The block's key: the rule's hash, never its text (a long text as a key
  // made React duplicate the block on re-renders).
  const selectedRuleHash = useMemo(() => (selectedRuleXml ? ruleXmlHash(selectedRuleXml) : ''), [selectedRuleXml]);
  const selectedCorrection = useMemo(() => {
    if (!selectedId || !ruleFormat || !selectedRuleXml.trim() || !correctionContext.ready) return null;
    const result = cachedRuleCorrection(selectedRuleXml, ruleFormat, correctionContext.ctx);
    const listed = ruleCorrections.byBrdpId.get(selectedId);
    const clashes = listed && listed.ruleXml === selectedRuleXml ? listed.clashes : [];
    const dismissedHash = ruleApproval?.correction_dismissed_hash;
    const dismissed = Boolean(dismissedHash) && dismissedHash === selectedRuleHash;
    return { result, clashes, dismissed };
  }, [selectedId, ruleFormat, selectedRuleXml, ruleApproval?.correction_dismissed_hash, selectedRuleHash, correctionContext.ready, correctionContext.ctx, ruleCorrections.byBrdpId]);
  const needsOtherVocabularies = Boolean(selectedCorrection?.result?.needsOtherVocabularies);
  useEffect(() => {
    if (needsOtherVocabularies) correctionContext.requestOtherVocabularies();
    // requestOtherVocabularies only sets a flag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsOtherVocabularies]);

  // Aceptar: saved like any rule edit (Draft; a Verified rule asks first),
  // with what the correction fixed for History. The test of the old text
  // becomes outdated by itself (its hash no longer matches).
  const acceptRuleCorrection = async () => {
    const proposal = selectedCorrection?.result?.proposal;
    if (!proposal || !canEdit || !ruleFormat) return;
    if (ruleStateOf(ruleApproval) === 'verified' && !window.confirm(t('records.ruleCorrection.acceptConfirmVerified'))) return;
    const brdpId = selected.id;
    setCorrectionBusy(true);
    setCorrectionError(null);
    try {
      const saved = await authFetchJson(`/api/projects/${projectId}/brdps/${brdpId}/approvals/${ruleFormat}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rule_xml: proposal.xml, source: 'manual', status: 'pending_review', correction: correctionRecord(proposal) }),
      });
      if (selectedIdRef.current === brdpId) setRuleApproval(saved);
      setRuleApprovalsById((m) => (m ? { ...m, [brdpId]: { status: saved.status } } : m));
      setApprovalsRefreshToken((n) => n + 1);
      setHistoryRefreshToken((n) => n + 1);
    } catch (err) {
      if (selectedIdRef.current === brdpId) setCorrectionError(t('records.ruleCorrection.acceptFailed', { reason: errorMessage(err, t) }));
    } finally {
      setCorrectionBusy(false);
    }
  };

  // Descartar, optimistic (HR20): the block turns into the discreet line at
  // once; if the server refuses, it comes back with the reason.
  const dismissRuleCorrection = async () => {
    if (!canEdit || !ruleFormat || !ruleApproval) return;
    const brdpId = selected.id;
    const previous = ruleApproval;
    const hash = ruleXmlHash(previous.rule_xml);
    setCorrectionError(null);
    setRuleApproval((a) => (a ? { ...a, correction_dismissed_hash: hash } : a));
    try {
      await authFetchJson(`/api/projects/${projectId}/brdps/${brdpId}/approvals/${ruleFormat}/correction-dismissal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rule_hash: hash }),
      });
      setApprovalsRefreshToken((n) => n + 1);
    } catch (err) {
      if (selectedIdRef.current === brdpId) {
        setRuleApproval(previous);
        setCorrectionError(t('records.ruleCorrection.dismissFailed', { reason: errorMessage(err, t) }));
      }
    }
  };

  // "Defecto detectado": the person asks for a new rule with the very
  // Suggest Rule button (its own availability and reasons); never on the
  // application's initiative.
  const goToSuggestRule = () => {
    const button = document.querySelector('[data-testid="suggest-rule"]');
    if (!button) return;
    button.scrollIntoView({ block: 'center' });
    if (button.disabled) button.focus();
    else button.click();
  };

  const openCreatePanel = () => {
    if (!confirmLeaveSelected()) return;
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
    authFetchJson(`/api/projects/${projectId}/brdps/next-ext-identifier`)
      .then((data) => setNewBrdpIdentifier(data.identifier))
      .catch((err) => setCreateError(errorMessage(err, t)));
    loadCreateCatalog();
  };

  // Global reference data (not project-scoped) -- naturally empty for a
  // standard with no imported catalog, which is exactly how the picker
  // section below decides whether to render at all. A failed load is said,
  // with Retry -- never an empty picker that looks like "no catalog"
  // (AACF 1, Part 2).
  const [catalogLoadError, setCatalogLoadError] = useState(null);
  const loadCreateCatalog = () => {
    setCatalogLoadError(null);
    authFetchJson(`/api/brdp-catalog?standard=${encodeURIComponent(project.standard)}`)
      .then(setCatalogEntries)
      .catch((err) => {
        setCatalogEntries([]);
        setCatalogLoadError(t('records.loadErrors.catalog', { reason: errorMessage(err, t) }));
      });
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
      setCreateError(errorMessage(err, t));
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
  // A failed revert shows where the field is ("Not saved" / the status
  // notice): nothing else to do here.
  const revertHistoryEntry = (entry) => {
    const column = REVERTIBLE_HISTORY_FIELDS[entry.field_name];
    if (!column || !selected) return;
    handleUpdate(selected.id, { [column]: entry.old_value }).catch(() => {});
  };

  // Delete (to the Trash), optimistic (HR20): the row goes at once; if the
  // server refuses, it comes back to its place and order -- selected again
  // if it was -- with the reason at the top of the page.
  const handleDelete = async (brdpId, identifier, { confirmed = false } = {}) => {
    if (!confirmed && !window.confirm(t('records.deleteConfirm', { identifier }))) return;
    const { row, index } = removeRow(brdps, brdpId);
    const wasSelected = selectedId === brdpId;
    clearNotice(`delete:${brdpId}`);
    setBrdps((list) => removeRow(list, brdpId).list);
    if (wasSelected) setSelectedId(null);
    try {
      await authFetchJson(`/api/projects/${projectId}/brdps/${brdpId}`, { method: 'DELETE' });
      // Docs request edge case: deleting a BRDP with a pending/loaded
      // suggestion removes it from the map immediately -- if a request was
      // still in flight for it, requestSuggestion's own existence check
      // (the map no longer has this brdpId) discards the response when it
      // eventually lands, instead of resurrecting an entry for a BRDP that
      // no longer exists.
      suggestions.removeSuggestionEntry(brdpId);
      setUnsaved((current) => discardBrdp(current, brdpId));
      refresh();
      refreshStats();
    } catch (err) {
      setBrdps((list) => restoreRow(list, row, index));
      if (wasSelected) setSelectedId((current) => current ?? brdpId);
      showNotice(`delete:${brdpId}`, {
        message: t('records.actionErrors.delete', { identifier, reason: errorMessage(err, t) }),
        retry: () => handleDelete(brdpId, identifier, { confirmed: true }),
      });
    }
  };


  // Editor-only (backend enforces this too -- see embedding_jobs.py's
  // require_project_role('editor')): launches the background job. 409 (a
  // second editor already started one, docs request's own edge case) reads
  // fine as-is from the backend's own detail message via computeEmbeddings
  // .error; the mutation always invalidates the job query on settle
  // either way, so the UI reflects whatever IS actually running.
  const handleComputeEmbeddings = () => computeEmbeddings.mutate();

  // A text field of the selected BRDP that did not save: a red border and,
  // under it, "Not saved: <reason>" with Retry and "Discard change".
  const fieldEntry = (field) => (selected ? unsaved.get(fieldKey(selected.id, field)) : undefined);
  const fieldFailed = (field) => fieldEntry(field)?.status === 'failed';
  const fieldClass = (base, field) => (fieldFailed(field) ? `${base} ${styles.fieldUnsaved}` : base);
  const fieldNotice = (field) => {
    const entry = fieldEntry(field);
    if (entry?.status !== 'failed') return null;
    return (
      <ErrorNotice
        testId={`records-unsaved-${field}`}
        message={t('records.unsaved.notSaved', { reason: entry.error })}
        onRetry={() => retryField(entry)}
        retryDisabledReason={canRetry(entry) ? null : t('records.unsaved.shortenFirst')}
        onDiscard={() => discardFieldChange(entry)}
      />
    );
  };

  // Consolidation C1, Part 3: draggable divider between the table and the
  // detail panel. AACF 3: the width is the person's interface preference
  // on the server (users.ui_preferences.records_detail_width).
  const { user: currentUser, saveUiPreference } = useAuthContext();
  const storedDetailWidth = currentUser?.ui_preferences?.records_detail_width;
  const saveDetailWidth = useCallback(
    (width) =>
      saveUiPreference(
        'records_detail_width',
        width === null ? null : Math.min(Math.max(width, DETAIL_PANEL_MIN_WIDTH), DETAIL_PANEL_MAX_SAVED_WIDTH)
      ),
    [saveUiPreference]
  );
  const split = useResizableSplit({
    storedSize: Number.isInteger(storedDetailWidth) ? storedDetailWidth : null,
    onSave: saveDetailWidth,
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
        {!statsFailed && (
          <div className={styles.headerActions}>
            <ProposalStatusSummary counts={stats.proposal_status_counts} />
            <RuleStatusSummary counts={stats.rule_status_counts} />
            <VerifiedTestBreakdown
              counts={stats.verified_test_counts}
              verified={stats.rule_status_counts.verified}
              active={testCategoryFilter}
              onSelect={setTestCategoryFilter}
            />
            {ruleFormat && (
              <CorrectionCounts corrections={ruleCorrections} active={correctionFilter} onSelect={setCorrectionFilter} />
            )}
          </div>
        )}
      </div>

      {/* AACF 1, Part 1: what failed and is not tied to the selected BRDP --
          the list, the totals, the rule statuses, a deletion, and a change
          of another BRDP that did not save -- all with the same ErrorNotice. */}
      {(() => {
        const pageNotices = [...notices.entries()].filter(([key]) => !key.startsWith('status:') && !key.startsWith('rule:'));
        const otherUnsaved = failedEntries(unsaved).filter((e) => e.brdpId !== selectedId);
        if (pageNotices.length === 0 && otherUnsaved.length === 0) return null;
        return (
          <div className={styles.pageNotices}>
            {pageNotices.map(([key, notice]) => (
              <ErrorNotice
                key={key}
                testId={`records-notice-${key.split(':')[0]}`}
                message={notice.message}
                onRetry={notice.retry || undefined}
                onDismiss={() => clearNotice(key)}
              />
            ))}
            {otherUnsaved.map((entry) => (
              <ErrorNotice
                key={fieldKey(entry.brdpId, entry.field)}
                testId="records-notice-unsaved-other"
                message={t('records.unsaved.otherBrdp', {
                  identifier: brdps.find((b) => b.id === entry.brdpId)?.identifier ?? '',
                  field: fieldLabel(entry.field),
                  reason: entry.error,
                })}
                onRetry={() => retryField(entry)}
                retryDisabledReason={canRetry(entry) ? null : t('records.unsaved.shortenFirst')}
                onDiscard={() => discardFieldChange(entry)}
              />
            ))}
          </div>
        );
      })()}

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
                      onClick={() => selectBrdp(b.id)}
                    >
                      <td className={`${styles.mono} ${styles.idCell}`}>
                        <span className={styles.idText}>{b.identifier}</span>
                        <CatalogEditionTag edition={b.catalog_edition} standard={project.standard} />
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
                        <RuleStatusCell approvals={ruleApprovalsById} brdpId={b.id} format={ruleFormat} />
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
              <RenameSuggestions standard={project.standard} text={newBrdpTitle} vocabulary={vocabulary} onApply={setNewBrdpTitle} />

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
              <RenameSuggestions standard={project.standard} text={newBrdpDefinition} vocabulary={vocabulary} onApply={setNewBrdpDefinition} />

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
              <RenameSuggestions standard={project.standard} text={newBrdpProposal} vocabulary={vocabulary} onApply={setNewBrdpProposal} />
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

              {catalogLoadError && (
                <ErrorNotice testId="records-notice-catalog" message={catalogLoadError} onRetry={loadCreateCatalog} />
              )}
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
                <p className={styles.mono}>
                  {selected.identifier}
                  <CatalogEditionTag edition={selected.catalog_edition} standard={project.standard} />
                </p>
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
                className={fieldClass(styles.input, 'title')}
                value={displayedValue(unsaved, selected, 'title')}
                disabled={!canEdit}
                aria-invalid={fieldFailed('title') ? 'true' : undefined}
                data-testid="records-field-title"
                onFocus={() => triggerNamingTip('title')}
                onChange={(e) => {
                  triggerNamingTip('title');
                  typeField(selected.id, 'title', e.target.value);
                }}
                onBlur={() => commitField(selected, 'title')}
              />
              {fieldNotice('title')}
              {namingTipAnchor === 'title' && (
                <NamingTip
                  standard={project.standard}
                  onGotIt={dismissNamingTipForSession}
                />
              )}
              {canEdit && (
                <RenameSuggestions
                  standard={project.standard}
                  text={displayedValue(unsaved, selected, 'title')}
                  vocabulary={vocabulary}
                  onApply={(newText) => handleUpdate(selected.id, { title: newText }).catch(() => {})}
                />
              )}
              <label className={styles.fieldLabel}>{t('records.fieldDefinition')}</label>
              <textarea
                className={fieldClass(styles.textarea, 'definition')}
                value={displayedValue(unsaved, selected, 'definition')}
                disabled={!canEdit}
                aria-invalid={fieldFailed('definition') ? 'true' : undefined}
                data-testid="records-field-definition"
                onFocus={() => triggerNamingTip('definition')}
                onChange={(e) => {
                  triggerNamingTip('definition');
                  typeField(selected.id, 'definition', e.target.value);
                }}
                onBlur={() => commitField(selected, 'definition')}
              />
              {fieldNotice('definition')}
              {namingTipAnchor === 'definition' && (
                <NamingTip
                  standard={project.standard}
                  onGotIt={dismissNamingTipForSession}
                />
              )}
              {canEdit && (
                <RenameSuggestions
                  standard={project.standard}
                  text={displayedValue(unsaved, selected, 'definition')}
                  vocabulary={vocabulary}
                  onApply={(newText) => handleUpdate(selected.id, { definition: newText }).catch(() => {})}
                />
              )}
              <label className={styles.fieldLabel}>{t('records.fieldProposal')}</label>
              <textarea
                className={fieldClass(styles.textarea, 'proposal')}
                value={displayedValue(unsaved, selected, 'proposal')}
                disabled={!canEdit}
                aria-invalid={fieldFailed('proposal') ? 'true' : undefined}
                data-testid="records-field-proposal"
                onFocus={() => triggerNamingTip('proposal')}
                onChange={(e) => {
                  triggerNamingTip('proposal');
                  typeField(selected.id, 'proposal', e.target.value);
                }}
                onBlur={() => commitField(selected, 'proposal')}
              />
              {fieldNotice('proposal')}
              {namingTipAnchor === 'proposal' && (
                <NamingTip
                  standard={project.standard}
                  onGotIt={dismissNamingTipForSession}
                />
              )}
              {canEdit && (
                <RenameSuggestions
                  standard={project.standard}
                  text={displayedValue(unsaved, selected, 'proposal')}
                  vocabulary={vocabulary}
                  onApply={(newText) => handleUpdate(selected.id, { proposal: newText }).catch(() => {})}
                />
              )}
              <p className={styles.hint}>{t('records.vocabHint')}</p>

              <label className={styles.fieldLabel}>{t('records.fieldValidation')}</label>
              <select
                className={styles.select}
                value={selected.validation}
                disabled={!canEdit}
                data-testid="records-field-validation"
                onChange={(e) => changeValidation(selected.id, e.target.value)}
              >
                {VALIDATION_OPTIONS.map((v) => (
                  <option key={v} value={v}>
                    {t(`records.validationOptions.${v}`)}
                  </option>
                ))}
              </select>
              {notices.get(`status:${selected.id}`) && (
                <ErrorNotice
                  testId="records-notice-status"
                  message={notices.get(`status:${selected.id}`).message}
                  onRetry={notices.get(`status:${selected.id}`).retry}
                  onDismiss={() => clearNotice(`status:${selected.id}`)}
                />
              )}

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
                    className={fieldClass(styles.textarea, 'comments')}
                    value={displayedValue(unsaved, selected, 'comments')}
                    disabled={!canEdit}
                    aria-invalid={fieldFailed('comments') ? 'true' : undefined}
                    data-testid="records-field-comments"
                    onChange={(e) => typeField(selected.id, 'comments', e.target.value)}
                    onBlur={() => commitField(selected, 'comments')}
                  />
                  {fieldNotice('comments')}
                </>
              )}

              <label className={styles.fieldLabel}>{t('records.fieldRuleStatus')}</label>
              {!ruleFormat ? (
                <p className={styles.muted} title={t('records.rule.unsupportedStandard')}>
                  —
                </p>
              ) : ruleApproval === undefined ? (
                ruleApprovalLoadError ? (
                  <ErrorNotice
                    testId="records-notice-rule-load"
                    message={ruleApprovalLoadError}
                    onRetry={() => setRuleApprovalReloadToken((n) => n + 1)}
                  />
                ) : (
                  <p className={styles.muted}>…</p>
                )
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
                  <SchemaIssueLines issues={ruleDraftXPathIssues} testIds={{ invalid_xpath: 'rule-editor-xpath-error' }} />
                  {/* Mejoras B, Part 4.2-4.3: the fix next to the warning, never
                      applied on its own -- the person clicks it. */}
                  {ruleDraftFormat?.problem?.code === 'rule_format_multiple' && ruleDraftSplit.total > 0 && (
                    <button
                      type="button"
                      className={styles.linkButton}
                      data-testid="rule-editor-split"
                      onClick={() => {
                        setRuleDraftText(ruleDraftSplit.xml);
                        setRuleEditorNote(t('records.assistant.ruleSplit', { count: ruleDraftSplit.total, path: ruleFormat === 'BREX-3.0.1' ? 'objpath' : 'objectPath' }));
                      }}
                    >
                      {t('records.assistant.splitRulesButton', { count: ruleDraftSplit.total })}
                    </button>
                  )}
                  {ruleDraftFormat?.problem?.code === 'rule_format_duplicate_ids' && (
                    <button
                      type="button"
                      className={styles.linkButton}
                      data-testid="rule-editor-number-ids"
                      onClick={() => {
                        const numbered = numberDuplicateRuleIds(ruleDraftText, ruleFormat);
                        setRuleDraftText(numbered.xml);
                        setRuleEditorNote(numbered.renamed.map((r) => t('records.assistant.ruleIdsNumbered', { id: r.id, ids: r.to.join(', ') })).join(' '));
                      }}
                    >
                      {t('records.assistant.numberIdsButton')}
                    </button>
                  )}
                  {ruleDraftFormat?.ok && (
                    <RulePathWarnings
                      ruleXml={ruleDraftText}
                      format={ruleFormat}
                      standard={project.standard}
                      schemaLocation={schemaLocationOf(project.project_config, project.standard)}
                      onApplyFix={setRuleDraftText}
                      testId="rule-editor-path-warning"
                    />
                  )}
                  {ruleEditorNote && (
                    <p className={styles.hint} data-testid="rule-editor-note">
                      {ruleEditorNote}
                    </p>
                  )}
                  <SchemaIssueLines
                    issues={nameIssues(ruleDraftNames, 'rule', { standard: project.standard, hints: ruleDraftNameHints })}
                    testIds={NAME_HINT_TEST_IDS}
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
                  {notices.get(`rule:${selected.id}`) && (
                    <ErrorNotice
                      testId="records-notice-rule"
                      message={notices.get(`rule:${selected.id}`).message}
                      onRetry={notices.get(`rule:${selected.id}`).retry || undefined}
                      onDismiss={() => clearNotice(`rule:${selected.id}`)}
                    />
                  )}
                  <RuleCorrectionBlock
                    key={`${selected.id}:${selectedRuleHash}`}
                    entry={selectedCorrection}
                    ruleXml={selectedRuleXml}
                    format={ruleFormat}
                    canEdit={canEdit}
                    busy={correctionBusy}
                    error={correctionError}
                    onAccept={acceptRuleCorrection}
                    onDismiss={dismissRuleCorrection}
                    onSuggestRule={goToSuggestRule}
                  />
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
                      schemaLocation={schemaLocationOf(project.project_config, project.standard)}
                      vocabulary={vocabulary}
                      onClose={() => setSavedTestOpenFor(null)}
                      rerun={
                        ruleStateOf(ruleApproval) === 'draft'
                          ? {
                              ruleXml: ruleApproval.rule_xml,
                              proposal: selected.proposal,
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
                      schemaLocation={schemaLocationOf(project.project_config, project.standard)}
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
                    <RuleXmlView ruleXml={ruleApproval.rule_xml} format={ruleFormat} className={styles.suggestionCode} testId="rule-preview" />
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
                {vocabularyLoadError && (
                  <ErrorNotice
                    testId="records-notice-vocabulary"
                    message={t('records.loadErrors.vocabulary', {
                      standard: project.standard,
                      reason: vocabularyLoadError.status
                        ? t('errors.requestFailed', { status: vocabularyLoadError.status })
                        : t('errors.network'),
                    })}
                    onRetry={retryVocabularyLoad}
                  />
                )}
                {vocabResult && vocabResult.brdpId === selected.id && (
                  <div className={styles.vocabNotice}>
                    {!vocabResult.available && !vocabResult.loadFailed && (
                      <p className={styles.muted}>
                        {t('records.assistant.vocabCheckUnavailable', { standard: project.standard })}
                      </p>
                    )}
                    <SchemaIssueLines
                      issues={nameIssues(vocabResult, 'brdp', { standard: project.standard, hints: vocabNameHints })}
                      testIds={NAME_HINT_TEST_IDS}
                    />
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
                    // Suggest Title has the same gate: the catalog gives the
                    // official Title too.
                    const catalogDisabled =
                      (kind === 'definition' || kind === 'title') && Boolean(suggestions.catalogIdentifierSet?.has(selected.identifier));
                    // Suggest Title rewrites the Title already written (none
                    // -> nothing to rewrite), and only an editor can change it.
                    const titleBlockedReason =
                      kind !== 'title'
                        ? null
                        : !canEdit
                          ? t('records.assistant.suggestTitleViewer')
                          : !selected.title?.trim()
                            ? t('records.assistant.suggestTitleNeedsTitle')
                            : null;
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
                          !!ruleBlockedReason ||
                          !!titleBlockedReason
                        }
                        data-testid={`suggest-${kind}`}
                        title={
                          pendingBlocked
                            ? t('records.assistant.pendingSuggestionBlocksNew')
                            : catalogDisabled
                              ? t(kind === 'title' ? 'records.assistant.suggestTitleCatalogDisabled' : 'records.assistant.suggestDefinitionCatalogDisabled')
                              : titleBlockedReason
                                ? titleBlockedReason
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
                    onRuleTextChange={(value) => suggestions.setSuggestionRuleText(selected.id, value)}
                    onAcceptPasted={suggestions.acceptPastedRule}
                    onEnsurePastedCoverage={(rule) => suggestions.ensurePastedCoverage(selected.id, rule)}
                    onTestResult={(ruleXml, record) => suggestions.recordSuggestionTest(selected.id, ruleXml, record)}
                    onSuggestCorrectedRule={(failed) => suggestions.suggestCorrectedRule(failed)}
                    correctedRuleBlockedReason={suggestDisabledByEmbeddings ? t('records.ruleTest.review.blockedByEmbeddings') : null}
                    ruleIdOwners={ruleCorrections.idOwners}
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

                {selectedSuggestion?.alreadyFollows && (
                  <div className={styles.suggestionBox} data-testid="title-already-follows">
                    <span className={styles.muted}>{t('records.assistant.titleAlreadyFollows')}</span>
                    <div className={styles.suggestionActions}>
                      <button onClick={suggestions.discardSuggestion}>{t('records.assistant.discard')}</button>
                    </div>
                  </div>
                )}

                {selectedSuggestion?.text && selectedSuggestion.kind !== 'rule' && (
                  <div className={styles.suggestionBox} data-testid={`suggestion-${selectedSuggestion.kind}`}>
                    <div className={styles.suggestionText}>
                      {selectedSuggestion.text}
                    </div>
                    {selectedSuggestion.nameIssues?.length > 0 && <SchemaIssueLines issues={selectedSuggestion.nameIssues} />}
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
                    {(selectedSuggestion.kind === 'definition' || selectedSuggestion.kind === 'title') && (
                      <div className={styles.suggestionReferences}>
                        {selectedSuggestion.similar.length === 0 && selectedSuggestion.styleReferences.length === 0 ? (
                          <p className={styles.hint}>
                            {t(selectedSuggestion.kind === 'title' ? 'records.assistant.titleNoReferences' : 'records.assistant.definitionNoReferences')}
                          </p>
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
                {!historyOpen ? null : historyLoadError ? (
                  <ErrorNotice
                    testId="records-notice-history"
                    message={historyLoadError}
                    onRetry={() => setHistoryRefreshToken((n) => n + 1)}
                  />
                ) : history.length === 0 ? (
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
