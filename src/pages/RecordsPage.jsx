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

// The engine's inclusion gate hardcodes the literal DB values
// "pending_review"/"approved" in 4 generator files (never touch those) --
// this UI only ever relabels them as Draft/Verified. "todo" is not a DB
// value at all, it is the absence of a rule_approvals row.
function ruleStateOf(approval) {
  if (approval === null) return 'todo';
  return approval.status === 'approved' ? 'verified' : 'draft';
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
  const [newIdentifier, setNewIdentifier] = useState('');
  const [approvalsRefreshToken, setApprovalsRefreshToken] = useState(0);

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

  const refresh = () =>
    authFetchJson(`/api/projects/${projectId}/brdps`).then((data) => {
      setBrdps(data);
      setIsLoading(false);
    });

  useEffect(() => {
    refresh();
    authFetchJson('/api/config/ai-provider').then(setAiProvider).catch(() => setAiProvider(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const selected = brdps.find((b) => b.id === selectedId) || null;

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

  const openRuleEditor = () => {
    setRuleDraftText(ruleApproval?.rule_xml || '');
    setRuleValidationError(null);
    setRuleEditing(true);
  };

  const cancelRuleEditor = () => {
    setRuleValidationError(null);
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
    setRuleBusy(true);
    try {
      await authFetchJson(`/api/projects/${projectId}/brdps/${selected.id}/approvals/${ruleFormat}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rule_xml: ruleDraftText, source: 'manual', status: 'pending_review' }),
      });
      setRuleEditing(false);
      setApprovalsRefreshToken((n) => n + 1);
    } catch (err) {
      // Defense in depth: the backend enforces the same well-formedness
      // rule independently (never trust only the client), so surface its
      // rejection the same way in the rare case the two checks disagree.
      setRuleValidationError(err.message);
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
    } finally {
      setRuleBusy(false);
    }
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!newIdentifier.trim()) return;
    await authFetchJson(`/api/projects/${projectId}/brdps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: newIdentifier.trim() }),
    });
    setNewIdentifier('');
    refresh();
  };

  const handleUpdate = async (brdpId, patch) => {
    await authFetchJson(`/api/projects/${projectId}/brdps/${brdpId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    refresh();
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
          {canEdit && (
            <form className={styles.createForm} onSubmit={handleCreate}>
              <input
                value={newIdentifier}
                onChange={(e) => setNewIdentifier(e.target.value)}
                placeholder={t('records.addPlaceholder')}
              />
              <button type="submit">{t('records.addButton')}</button>
            </form>
          )}

          {isLoading ? (
            <p>…</p>
          ) : (
            <table className={styles.table}>
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
                {brdps.map((b) => (
                  <tr
                    key={b.id}
                    className={selectedId === b.id ? styles.selectedRow : ''}
                    onClick={() => setSelectedId(b.id)}
                  >
                    <td className={styles.mono}>{b.identifier}</td>
                    <td>{b.title || <span className={styles.muted}>—</span>}</td>
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

        <div className={styles.detailPanel}>
          {!selected ? (
            <p className={styles.muted}>{t('records.selectHint')}</p>
          ) : (
            <>
              <h2 className={styles.detailId}>{selected.identifier}</h2>
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
                    }}
                    placeholder={t('records.rule.editorPlaceholder')}
                    spellCheck={false}
                    aria-invalid={ruleValidationError ? 'true' : undefined}
                  />
                  {ruleValidationError && (
                    <p className={styles.ruleErrorText} role="alert">
                      {t('records.rule.notWellFormed', { error: ruleValidationError })}
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
            </>
          )}
        </div>
      </div>
    </div>
  );
}
