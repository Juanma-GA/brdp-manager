import { useEffect, useState } from 'react';
import { useOutletContext, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { authFetchJson } from '../services/apiClient';
import { sendMessage } from '../api/llmAPI';
import styles from './RecordsPage.module.css';

const VALIDATION_OPTIONS = ['Pending', 'Validated', 'Refused'];

export default function RecordsPage() {
  const { t } = useTranslation();
  const { projectId } = useParams();
  const { project } = useOutletContext();
  const canEdit = project.my_role === 'admin' || project.my_role === 'editor';

  const [brdps, setBrdps] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [newIdentifier, setNewIdentifier] = useState('');

  const [aiProvider, setAiProvider] = useState(null);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [suggestion, setSuggestion] = useState('');
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

  // Simplified for Phase 4: a direct LLM call, no few-shot precedent yet --
  // the similarity search over the project's own validated BRDPs
  // (docs/v2 §3) is Phase 5's job. This proves the real proxy round-trip
  // and the real role-gated Accept/Discard flow now; the suggestion
  // quality improves once Phase 5 lands, without changing this UI.
  const suggestDefinition = async () => {
    if (!selected || !aiProvider) return;
    setBusy(true);
    setSuggestion('');
    try {
      const res = await sendMessage(
        [
          {
            role: 'user',
            content: `Suggest a concise BRDP definition for identifier "${selected.identifier}" (current definition: "${selected.definition}"). Return only the suggested definition text.`,
          },
        ],
        null,
        aiProvider.model,
        aiProvider.provider,
        'You are an S1000D/DITA BRDP expert assistant.'
      );
      setSuggestion(res.content);
    } catch (err) {
      setSuggestion(`Error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const acceptSuggestion = async () => {
    if (!selected || !suggestion) return;
    await handleUpdate(selected.id, { definition: suggestion });
    setSuggestion('');
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

                <button onClick={suggestDefinition} disabled={busy || !aiProvider}>
                  {busy ? '…' : 'Suggest Definition'}
                </button>
                {suggestion && (
                  <div className={styles.suggestionBox}>
                    <div>{suggestion}</div>
                    <div className={styles.suggestionActions}>
                      <button
                        onClick={acceptSuggestion}
                        disabled={!canEdit}
                        title={!canEdit ? 'Your role on this project cannot accept suggestions' : undefined}
                      >
                        Accept
                      </button>
                      <button onClick={() => setSuggestion('')}>Discard</button>
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
