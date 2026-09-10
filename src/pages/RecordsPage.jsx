import { useEffect, useState } from 'react';
import { useOutletContext, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { authFetchJson } from '../services/apiClient';
import { sendMessage } from '../api/llmAPI';
import styles from './RecordsPage.module.css';

const VALIDATION_OPTIONS = ['Pending', 'Validated', 'Refused'];
const KIND_LABEL = { definition: 'definition', proposal: 'proposal', rule: 'BREX rule' };

export default function RecordsPage() {
  const { t } = useTranslation();
  const { projectId } = useParams();
  const { project } = useOutletContext();
  // project.effective_role is computed server-side (admin already resolved
  // to 'editor' there, docs/v2 §4.3) -- never re-derive the admin bypass here.
  const canEdit = project.effective_role === 'editor';

  const [brdps, setBrdps] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [newIdentifier, setNewIdentifier] = useState('');

  const [aiProvider, setAiProvider] = useState(null);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  // null, or { kind, text, sourceBrdpIds, format? } for a real suggestion,
  // or { kind, insufficientPrecedent: true, message } when /similar (§3
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
  // exactly the Phase-4 behavior this replaces.
  const requestSuggestion = async (kind) => {
    if (!selected || !aiProvider) return;
    setBusy(true);
    setSuggestion(null);
    try {
      const similar = await authFetchJson(
        `/api/projects/${projectId}/brdps/${selected.id}/similar?kind=${kind}`
      );
      if (!similar.sufficient_precedent) {
        setSuggestion({ kind, insufficientPrecedent: true, message: similar.message });
        return;
      }

      const label = KIND_LABEL[kind];
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
        {project.name} · {project.standard} · {brdps.length} BRDPs
      </p>

      <div className={styles.layout}>
        <div className={styles.tableWrap}>
          {canEdit && (
            <form className={styles.createForm} onSubmit={handleCreate}>
              <input
                value={newIdentifier}
                onChange={(e) => setNewIdentifier(e.target.value)}
                placeholder="New BRDP identifier"
              />
              <button type="submit">Add BRDP</button>
            </form>
          )}

          {isLoading ? (
            <p>…</p>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Title</th>
                  <th>Validation</th>
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
                      <span className={styles[`badge_${b.validation}`] || ''}>{b.validation}</span>
                    </td>
                    {canEdit && (
                      <td onClick={(e) => e.stopPropagation()}>
                        <button onClick={() => handleDelete(b.id)} aria-label={`Delete ${b.identifier}`}>
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
            <p className={styles.muted}>Select a BRDP from the table.</p>
          ) : (
            <>
              <h2 className={styles.detailId}>{selected.identifier}</h2>
              <label className={styles.fieldLabel}>Definition</label>
              <textarea
                className={styles.textarea}
                value={selected.definition}
                disabled={!canEdit}
                onChange={(e) => setBrdps((prev) => prev.map((b) => (b.id === selected.id ? { ...b, definition: e.target.value } : b)))}
                onBlur={(e) => canEdit && handleUpdate(selected.id, { definition: e.target.value })}
              />
              <label className={styles.fieldLabel}>Proposal</label>
              <textarea
                className={styles.textarea}
                value={selected.proposal}
                disabled={!canEdit}
                onChange={(e) => setBrdps((prev) => prev.map((b) => (b.id === selected.id ? { ...b, proposal: e.target.value } : b)))}
                onBlur={(e) => canEdit && handleUpdate(selected.id, { proposal: e.target.value })}
              />
              <label className={styles.fieldLabel}>Validation</label>
              <select
                className={styles.select}
                value={selected.validation}
                disabled={!canEdit}
                onChange={(e) => handleUpdate(selected.id, { validation: e.target.value })}
              >
                {VALIDATION_OPTIONS.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>

              <div className={styles.assistant}>
                <h3 className={styles.assistantTitle}>✨ BRDP Assistant</h3>
                {!aiProvider && <p className={styles.muted}>AI provider not configured on the server.</p>}

                <label className={styles.fieldLabel}>Ask a question</label>
                <textarea
                  className={styles.textarea}
                  rows={2}
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  placeholder="Ask about this BRDP…"
                />
                <button onClick={askGeneric} disabled={busy || !question.trim() || !aiProvider}>
                  {busy ? '…' : 'Ask'}
                </button>
                {answer && <div className={styles.answerBox}>{answer}</div>}

                <hr className={styles.hr} />

                <div className={styles.suggestionActions}>
                  <button onClick={() => requestSuggestion('definition')} disabled={busy || !aiProvider}>
                    {busy && suggestion?.kind === 'definition' ? '…' : 'Suggest Definition'}
                  </button>
                  <button onClick={() => requestSuggestion('proposal')} disabled={busy || !aiProvider}>
                    {busy && suggestion?.kind === 'proposal' ? '…' : 'Suggest Proposal'}
                  </button>
                  <button onClick={() => requestSuggestion('rule')} disabled={busy || !aiProvider}>
                    {busy && suggestion?.kind === 'rule' ? '…' : 'Suggest Rule'}
                  </button>
                </div>

                {suggestion?.insufficientPrecedent && (
                  <div className={styles.suggestionBox}>
                    <span className={styles.muted}>⚠ {suggestion.message}</span>
                  </div>
                )}

                {suggestion?.text && (
                  <div className={styles.suggestionBox}>
                    <div className={styles.mono}>{suggestion.text}</div>
                    <div className={styles.suggestionActions}>
                      <button
                        onClick={acceptSuggestion}
                        disabled={!canEdit}
                        title={!canEdit ? 'Your role on this project cannot accept suggestions' : undefined}
                      >
                        Accept
                      </button>
                      <button onClick={discardSuggestion}>Discard</button>
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
