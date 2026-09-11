import { useEffect, useState } from 'react';
import { useOutletContext, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import { authFetchJson } from '../services/apiClient';
import { sendMessage } from '../api/llmAPI';
import { checkWellFormed } from '../api/generateBREX.js';
import { STANDARD_TO_RULE_FORMAT } from '../constants/ruleFormats';
import styles from './RecordsPage.module.css';

const VALIDATION_OPTIONS = ['Pending', 'Validated', 'Refused'];
const SUGGEST_KINDS = ['definition', 'proposal', 'rule'];
const RULE_STATES = ['todo', 'draft', 'verified'];
// v1's BRDPTable/useTableLogic used 25 rows/page (see src/hooks/useTableLogic.js)
// -- this docs request specifically asks for 15 here, same prev/next pattern.
const TABLE_PAGE_SIZE = 15;

// The engine's inclusion gate hardcodes the literal DB values
// "pending_review"/"approved" in 4 generator files (never touch those) --
// this UI only ever relabels them as Draft/Verified. "todo" is not a DB
// value at all, it is the absence of a rule_approvals row.
function ruleStateOf(approval) {
  if (approval === null) return 'todo';
  return approval.status === 'approved' ? 'verified' : 'draft';
}

// rule_status/proposal_status history values are internal keys ("draft",
// "Validated"...) -- translate them through the same i18n tables the live
// fields already use, so the audit trail reads in the same language as
// everything else. Free-text fields (identifier/title/definition/
// proposal) are shown as-is; an empty value reads as an em dash.
const HISTORY_TRANSLATED_FIELDS = {
  rule_status: 'records.rule.states',
  proposal_status: 'records.validationOptions',
};

function formatHistoryValue(t, fieldName, value) {
  const prefix = HISTORY_TRANSLATED_FIELDS[fieldName];
  if (prefix) return t(`${prefix}.${value}`, { defaultValue: value });
  return value || '—';
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

  const [brdps, setBrdps] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [tableSearchQuery, setTableSearchQuery] = useState('');
  const [tablePage, setTablePage] = useState(1);
  const [approvalsRefreshToken, setApprovalsRefreshToken] = useState(0);

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
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  // null, or { kind, text, sourceBrdpIds, format? } for a real suggestion,
  // or { kind, insufficientPrecedent: true, count } when /similar (§3
  // point 3) reports fewer than its minimum candidates -- shown as an
  // explicit notice instead of ever calling the LLM with weak/no few-shot.
  const [suggestion, setSuggestion] = useState(null);
  const [busy, setBusy] = useState(false);

  // Rule Status stepper state for the SELECTED BRDP -- the manual editor
  // and Edit/Verify/Revoke actions live here in the detail panel (v1's
  // large plain-text editor), not in the table cell above.
  const [ruleApproval, setRuleApproval] = useState(undefined); // undefined = loading, null = none
  const [ruleEditing, setRuleEditing] = useState(false);
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

  const refresh = () =>
    authFetchJson(`/api/projects/${projectId}/brdps`).then((data) => {
      setBrdps(data);
      setIsLoading(false);
    });

  useEffect(() => {
    refresh();
    authFetchJson('/api/config/ai-provider').then(setAiProvider).catch(() => setAiProvider(null));
    setTablePage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const selected = brdps.find((b) => b.id === selectedId) || null;

  const handleTableSearchChange = (value) => {
    setTableSearchQuery(value);
    setTablePage(1);
  };

  const filteredBrdps = brdps.filter((b) => {
    const q = tableSearchQuery.trim().toLowerCase();
    if (!q) return true;
    return b.identifier.toLowerCase().includes(q) || (b.title || '').toLowerCase().includes(q);
  });
  const tableTotalPages = Math.max(1, Math.ceil(filteredBrdps.length / TABLE_PAGE_SIZE));
  const pagedBrdps = filteredBrdps.slice(
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

  useEffect(() => {
    setRuleEditing(false);
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
    refresh();
  };

  const askGeneric = async () => {
    if (!question.trim() || !aiProvider) return;
    setBusy(true);
    setAnswer('');
    try {
      const context = selected ? `\n\nBRDP context:\nID: ${selected.identifier}\nDefinition: ${selected.definition}` : '';
      const res = await sendMessage(
        [{ role: 'user', content: question + context }],
        null,
        aiProvider.model,
        aiProvider.provider,
        'You are an S1000D/DITA BRDP expert assistant.'
      );
      setAnswer(res.content);
    } catch (err) {
      setAnswer(`Error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

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
    setBusy(true);
    setSuggestion(null);
    try {
      const similar = await authFetchJson(
        `/api/projects/${projectId}/brdps/${selected.id}/similar?kind=${kind}`
      );
      if (!similar.sufficient_precedent) {
        setSuggestion({ kind, insufficientPrecedent: true, count: similar.candidates.length });
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
      setSuggestion({
        kind,
        text: res.content,
        sourceBrdpIds: similar.candidates.map((c) => c.id),
        format: similar.format,
      });
    } catch (err) {
      setSuggestion({ kind, text: `Error: ${err.message}`, sourceBrdpIds: [] });
    } finally {
      setBusy(false);
    }
  };

  const logSuggestionFeedback = (outcome) =>
    authFetchJson('/api/suggestion-feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        brdp_id: selected.id,
        kind: suggestion.kind,
        suggested_text: suggestion.text,
        source_brdp_ids: suggestion.sourceBrdpIds,
        outcome,
      }),
    });

  const acceptSuggestion = async () => {
    if (!selected || !suggestion?.text) return;
    if (suggestion.kind === 'rule') {
      await authFetchJson(`/api/projects/${projectId}/brdps/${selected.id}/approvals/${suggestion.format}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rule_xml: suggestion.text, source: 'llm', status: 'pending_review' }),
      });
      setApprovalsRefreshToken((n) => n + 1);
    } else {
      await handleUpdate(selected.id, { [suggestion.kind]: suggestion.text });
    }
    await logSuggestionFeedback('accepted');
    setSuggestion(null);
  };

  const discardSuggestion = async () => {
    if (suggestion?.text) await logSuggestionFeedback('discarded');
    setSuggestion(null);
  };

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>{t('nav.records')}</h1>
      <p className={styles.subtitle}>
        {t('records.subtitle', { name: project.name, standard: project.standard, count: brdps.length })}
      </p>

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
                    <th>{t('records.table.id')}</th>
                    <th>{t('records.table.title')}</th>
                    <th>{t('records.table.validation')}</th>
                    <th>{t('records.table.ruleStatus')}</th>
                    {canEdit && <th></th>}
                  </tr>
                </thead>
                <tbody>
                  {pagedBrdps.map((b) => (
                    <tr
                      key={b.id}
                      className={selectedId === b.id ? styles.selectedRow : ''}
                      onClick={() => setSelectedId(b.id)}
                    >
                      <td className={styles.mono}>{b.identifier}</td>
                      <td className={styles.titleCell} title={b.title || undefined}>
                        {b.title || <span className={styles.muted}>—</span>}
                      </td>
                      <td>
                        <span className={styles[`badge_${b.validation}`] || ''}>
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
                  {canEdit && (
                    <div className={styles.suggestionActions}>
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
                    </div>
                  )}
                </div>
              )}

              <div className={styles.assistant}>
                <h3 className={styles.assistantTitle}>{t('records.assistant.title')}</h3>
                {!aiProvider && <p className={styles.muted}>{t('records.assistant.noProvider')}</p>}

                <label className={styles.fieldLabel}>{t('records.assistant.askLabel')}</label>
                <textarea
                  className={styles.textarea}
                  rows={2}
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  placeholder={t('records.assistant.askPlaceholder')}
                />
                <button onClick={askGeneric} disabled={busy || !question.trim() || !aiProvider}>
                  {busy ? '…' : t('records.assistant.ask')}
                </button>
                {answer && <div className={styles.answerBox}>{answer}</div>}

                <hr className={styles.hr} />

                <div className={styles.suggestionActions}>
                  {SUGGEST_KINDS.map((kind) => (
                    <button key={kind} onClick={() => requestSuggestion(kind)} disabled={busy || !aiProvider}>
                      {busy && suggestion?.kind === kind
                        ? '…'
                        : t(`records.assistant.suggest${kind.charAt(0).toUpperCase()}${kind.slice(1)}`)}
                    </button>
                  ))}
                </div>

                {suggestion?.insufficientPrecedent && (
                  <div className={styles.suggestionBox}>
                    <span className={styles.muted}>
                      ⚠ {t('records.assistant.insufficientPrecedent', { count: suggestion.count })}
                    </span>
                  </div>
                )}

                {suggestion?.text && (
                  <div className={styles.suggestionBox}>
                    <div className={styles.mono}>{suggestion.text}</div>
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
