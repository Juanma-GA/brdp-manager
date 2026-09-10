import { useEffect, useState } from 'react';
import { useOutletContext, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { authFetchJson } from '../services/apiClient';
import { sendMessage } from '../api/llmAPI';
import { STANDARD_TO_RULE_FORMAT } from '../constants/ruleFormats';
import styles from './RecordsPage.module.css';

const VALIDATION_OPTIONS = ['Pending', 'Validated', 'Refused'];
const SUGGEST_KINDS = ['definition', 'proposal', 'rule'];

// Read-only status + a minimal Approve action -- NOT a rebuild of v1's
// RuleApprovalCell (manual edit/revoke/discard from the table). That
// component is orphaned in this rewrite: it calls v1's global unscoped
// /api/approvals/:brdpId/:format (via src/api/approvals.js) and reads
// v1's BRDPContext, neither of which exist in v2's project-scoped API,
// so its logic isn't valid here and it isn't reused. This is scoped to
// what was asked: make the real per-BRDP approval status (already
// writable via Suggest Rule's Accept) visible again, with just enough
// action (Approve) that a pending_review row isn't a dead end.
function RuleStatusCell({ projectId, brdpId, format, canEdit, refreshToken, onApproved }) {
  const { t } = useTranslation();
  const [approval, setApproval] = useState(undefined); // undefined = loading, null = none
  const [busy, setBusy] = useState(false);

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

  if (!format) return <span className={styles.muted}>{t('records.rule.unsupportedStandard')}</span>;
  if (approval === undefined) return <span className={styles.muted}>…</span>;
  if (approval === null) return <span className={styles.muted}>{t('records.rule.none')}</span>;

  const handleApprove = async (e) => {
    e.stopPropagation();
    setBusy(true);
    try {
      await authFetchJson(`/api/projects/${projectId}/brdps/${brdpId}/approvals/${format}/approve`, {
        method: 'POST',
      });
      onApproved();
    } finally {
      setBusy(false);
    }
  };

  if (approval.status === 'approved') {
    return <span className={styles.badge_approved}>✓ {t('records.rule.approved')}</span>;
  }
  return (
    <span className={styles.badge_pending_review}>
      ⏳ {t('records.rule.pendingReview')}
      {canEdit && (
        <button onClick={handleApprove} disabled={busy} className={styles.inlineApproveBtn}>
          {busy ? t('records.rule.approving') : t('records.rule.approve')}
        </button>
      )}
    </span>
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

  const handleDelete = async (brdpId) => {
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
                  <th>{t('records.table.ruleApproval')}</th>
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
                        canEdit={canEdit}
                        refreshToken={approvalsRefreshToken}
                        onApproved={() => setApprovalsRefreshToken((n) => n + 1)}
                      />
                    </td>
                    {canEdit && (
                      <td onClick={(e) => e.stopPropagation()}>
                        <button onClick={() => handleDelete(b.id)} aria-label={t('records.deleteAria', { identifier: b.identifier })}>
                          🗑
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
