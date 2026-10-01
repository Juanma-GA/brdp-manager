// AI Extract (1/2): "Import from BREX / Schematron" in Project
// Configuration, next to the Excel import.
//
//   1. The file goes to POST …/ai-extract/parse; reading and classifying run
//      in a background job on the server (progress polled here).
//   2. The texts the file cannot give are written by the AI in batches
//      (src/utils/ruleExtractDraft.js); each batch is saved on the server
//      right away, so leaving the page and coming back resumes it.
//   3. The review table: checkbox, classification (changeable), ID, Title,
//      Definition, Proposal (editable, saved on blur), the rule (collapsed;
//      for "Already exists (changes)" the diff with the stored one; for a
//      big candidate the count and its first 20 rules), warnings. Paged.
//   4. Nothing is written to the project's BRDPs until "Import selected".
// Everything lives on the server (rule_extract_jobs / _candidates); nothing
// in browser storage (HR1).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { authFetch, authFetchJson } from '../../services/apiClient';
import { sendMessage } from '../../api/llmAPI.js';
import { EXTRACT_MAX_TOKENS, SUGGEST_TEMPERATURE } from '../../prompts/shared.js';
import { candidatesToDraft, draftCandidates } from '../../utils/ruleExtractDraft.js';
import { aiFieldsOf } from '../../prompts/extractFromRulesPrompt.js';
import { diffRuleLines, normalizeRuleXml } from '../../utils/brdpCompare.js';
import {
  checkAgainstVocabulary,
  extractContextCandidates,
  formatSchemaIssue,
  loadSchemaVocabulary,
  nameIssues,
} from '../../validation/schemaValidation.js';
import Button from '../Button';
import pageStyles from '../../pages/ProjectConfigPage.module.css';
import styles from './RuleExtractSection.module.css';

export const EXTRACT_PAGE_SIZE = 25;
const POLL_MS = 1000;
const DRAFT_CLASSES = new Set(['new_ext', 'catalog', 'other_spec', 'default_rule']);
const WRITES_TITLE = new Set(['new_ext', 'other_spec', 'default_rule']);
const CLASS_FILTERS = ['all', 'new_ext', 'catalog', 'other_spec', 'default_rule', 'changed', 'same', 'empty', 'warnings'];
// Where each text comes from (rule_extract_jobs.set_texts): the file, the
// catalog, the AI, a hand edit, or the project for an existing BRDP.
const SOURCE_TAGS = new Set(['file', 'catalog', 'ai', 'manual', 'project']);

async function detailOf(res) {
  try {
    const body = await res.json();
    return typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail);
  } catch {
    return res.statusText;
  }
}

function classLabel(t, c, classification = c.classification) {
  if (classification === 'other_spec' || classification === 'default_rule') {
    return t(`config.ruleExtract.classes.${classification}`, { spec: c.specification || '' });
  }
  return t(`config.ruleExtract.classes.${classification}`);
}

function warningText(t, w) {
  const p = w.params || {};
  switch (w.code) {
    case 'empty_context':
      return t('config.ruleExtract.warnings.empty_context');
    case 'boolean_path':
      return t('config.ruleExtract.warnings.boolean_path', {
        paths: (p.paths || []).map((x) => (x.length > 120 ? `${x.slice(0, 120)}…` : x)).join(' · '),
      });
    case 'other_version_urls':
      return t('config.ruleExtract.warnings.other_version_urls', { versions: (p.versions || []).join(', '), project: p.project });
    case 'not_brdp_identifier':
      return t('config.ruleExtract.warnings.not_brdp_identifier', { identifier: p.identifier });
    case 'no_rule_to_import':
      return t('config.ruleExtract.warnings.no_rule_to_import');
    case 'not_in_catalog':
      return t('config.ruleExtract.warnings.not_in_catalog', { identifier: p.identifier, standard: p.standard });
    case 'similar_to':
      return t('config.ruleExtract.warnings.similar_to', { identifier: p.identifier, similarity: p.similarity });
    case 'external_entities':
      return t('config.ruleExtract.warnings.external_entities', { names: (p.names || []).join(', ') || p.dtd });
    case 'query_binding':
      return t('config.ruleExtract.warnings.query_binding', { found: p.found, expected: p.expected });
    case 'issue_not_stated':
      return t('config.ruleExtract.warnings.issue_not_stated', { assumed: p.assumed });
    case 'schematron_globals':
      return t('config.ruleExtract.warnings.schematron_globals', { element: p.element, count: p.count });
    case 'default_rule':
      return t('config.ruleExtract.warnings.default_rule', { specification: p.specification });
    case 'similarity_unavailable':
      return t('config.ruleExtract.warnings.similarity_unavailable', { reason: p.reason });
    default:
      return w.message || w.code;
  }
}

function vocabularyLines(t, c, vocabulary, standard) {
  if (!vocabulary) return [];
  const text = `${c.title || ''}\n${c.definition || ''}\n${c.proposal || ''}`;
  const result = checkAgainstVocabulary(extractContextCandidates(text), vocabulary);
  return nameIssues(result, 'brdp', { standard }).map((issue) => formatSchemaIssue(issue, t));
}

function SourceTag({ c, field, t }) {
  const source = c.text_sources?.[field];
  if (!SOURCE_TAGS.has(source) || !c[field]) return null;
  return (
    <div className={styles.sourceTag} data-testid={`rule-extract-source-${field}`} data-source={source}>
      {t(`config.ruleExtract.sources.${source}`)}
    </div>
  );
}

function RuleCell({ c, t }) {
  if (!c.rule_count && !c.noncontext_count) return <span className={styles.muted}>{t('config.ruleExtract.noRule')}</span>;
  const label = [
    ...(c.rule_count ? [t('config.ruleExtract.ruleCount', { count: c.rule_count })] : []),
    ...(c.noncontext_count ? [t('config.ruleExtract.noncontextCount', { count: c.noncontext_count })] : []),
  ].join(' + ');
  return (
    <details className={styles.ruleDetails}>
      <summary data-testid="rule-extract-rule-summary">{label}</summary>
      {c.big ? (
        <div className={styles.rulePreviewList}>
          {c.rule_preview.map((r, i) => (
            <pre key={i} className={styles.rulePre}>{r}</pre>
          ))}
          <p className={styles.muted} data-testid="rule-extract-rule-more">
            {t('config.ruleExtract.moreRules', { count: c.rule_count - c.rule_preview.length })}
          </p>
        </div>
      ) : c.classification === 'changed' && c.existing_rule_xml != null ? (
        <RuleDiff stored={c.existing_rule_xml} incoming={c.rule_xml} t={t} />
      ) : (
        <pre className={styles.rulePre}>{c.rule_xml}</pre>
      )}
    </details>
  );
}

function RuleDiff({ stored, incoming, t }) {
  const rows = useMemo(
    () => diffRuleLines(normalizeRuleXml(stored).text, normalizeRuleXml(incoming).text),
    [stored, incoming]
  );
  return (
    <table className={styles.diff} data-testid="rule-extract-rule-diff">
      <thead>
        <tr>
          <th>{t('config.ruleExtract.diffStored')}</th>
          <th>{t('config.ruleExtract.diffFile')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i} className={styles[`diff_${row.kind}`]}>
            <td><pre>{row.left ?? ''}</pre></td>
            <td><pre>{row.right ?? ''}</pre></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function EditableText({ value, onSave, disabled, testId, rows = 2 }) {
  const [draft, setDraft] = useState(value || '');
  useEffect(() => setDraft(value || ''), [value]);
  return (
    <textarea
      className={styles.textarea}
      rows={rows}
      value={draft}
      disabled={disabled}
      data-testid={testId}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== (value || '')) onSave(draft);
      }}
    />
  );
}

export default function RuleExtractSection({ projectId, standard, ruleFormat, canEdit, onDataChanged }) {
  const { t } = useTranslation();
  const [job, setJob] = useState(null);
  const [candidates, setCandidates] = useState(null);
  const [error, setError] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [drafting, setDrafting] = useState(null); // { done, total }
  const [aiProvider, setAiProvider] = useState(undefined);
  const [vocabulary, setVocabulary] = useState(null);
  const [filter, setFilter] = useState('all');
  const [page, setPage] = useState(0);
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState(null);
  const fileRef = useRef(null);
  const stopRef = useRef(false);
  const draftingRef = useRef(false);
  const base = `/api/projects/${projectId}/ai-extract`;

  useEffect(() => {
    authFetchJson('/api/config/ai-provider').then(setAiProvider).catch(() => setAiProvider(null));
    loadSchemaVocabulary(standard).then(setVocabulary).catch(() => setVocabulary(null));
  }, [standard]);

  useEffect(() => {
    stopRef.current = false;
    return () => {
      stopRef.current = true;
    };
  }, []);

  const loadCandidates = useCallback(
    async (jobId) => {
      const data = await authFetchJson(`${base}/jobs/${jobId}/candidates`);
      setCandidates(data.candidates);
      return data.candidates;
    },
    [base]
  );

  // The project's latest extraction, on mount: still running → poll;
  // finished and not imported → its candidates; imported → its summary.
  useEffect(() => {
    let cancelled = false;
    authFetchJson(`${base}/jobs/active`)
      .then(async (j) => {
        if (cancelled || !j) return;
        setJob(j);
        if (j.status === 'completed' && !j.applied_at) await loadCandidates(j.id);
        if (j.applied_at) setApplyResult(j.apply_result);
      })
      .catch((err) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [base, loadCandidates]);

  // Poll a running job.
  useEffect(() => {
    if (!job || job.status !== 'running') return undefined;
    const timer = setInterval(async () => {
      try {
        const j = await authFetchJson(`${base}/jobs/${job.id}`);
        setJob(j);
        if (j.status === 'completed') await loadCandidates(j.id);
      } catch (err) {
        setError(err.message);
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [job, base, loadCandidates]);

  // Edits show at once (HR20) and are saved on the server; if the save
  // fails, the rows go back to what they were and the error is shown.
  const patch = useCallback(
    async (items) => {
      const edits = new Map(items.map((i) => [i.key, i]));
      let before = null;
      setCandidates((list) => {
        before = list;
        return list.map((c) => (edits.has(c.key) ? { ...c, ...edits.get(c.key) } : c));
      });
      try {
        const data = await authFetchJson(`${base}/jobs/${job.id}/candidates`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items }),
        });
        const byKey = new Map(data.candidates.map((c) => [c.key, c]));
        setCandidates((list) => list.map((c) => byKey.get(c.key) || c));
      } catch (err) {
        if (before) {
          const old = new Map(before.map((c) => [c.key, c]));
          setCandidates((list) => list.map((c) => (edits.has(c.key) ? old.get(c.key) || c : c)));
        }
        setError(t('config.ruleExtract.saveFailed', { error: err.message }));
      }
    },
    [base, job, t]
  );

  const ask = useCallback(
    async ({ system, user }) => {
      const res = await sendMessage([{ role: 'user', content: user }], null, aiProvider.model, aiProvider.provider, system, {
        temperature: SUGGEST_TEMPERATURE,
        maxTokens: EXTRACT_MAX_TOKENS,
      });
      return res.content;
    },
    [aiProvider]
  );

  const runDrafting = useCallback(
    async (targets) => {
      if (!targets.length || draftingRef.current || !aiProvider) return;
      draftingRef.current = true;
      let done = 0;
      setDrafting({ done, total: targets.length });
      try {
        await draftCandidates(targets, {
          standard,
          ruleFormat,
          ask,
          shouldStop: () => stopRef.current,
          onBatch: async (results) => {
            await patch(results.map(({ error: _e, ...r }) => r));
            done += results.length;
            setDrafting({ done, total: targets.length });
          },
        });
      } catch (err) {
        setError(err.message);
      } finally {
        draftingRef.current = false;
        setDrafting(null);
      }
    },
    [aiProvider, ask, patch, ruleFormat, standard]
  );

  // Write what is missing as soon as the candidates are there (also when
  // coming back to an extraction left half-written).
  useEffect(() => {
    if (!candidates || !canEdit || !aiProvider || job?.applied_at) return;
    runDrafting(candidatesToDraft(candidates));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidates === null, aiProvider, canEdit]);

  const upload = async (file) => {
    setError(null);
    setApplyResult(null);
    setCandidates(null);
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await authFetch(`${base}/parse`, { method: 'POST', body: form });
      if (!res.ok) throw new Error(await detailOf(res));
      const { job_id: jobId } = await res.json();
      setJob(await authFetchJson(`${base}/jobs/${jobId}`));
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const apply = async () => {
    setApplying(true);
    setError(null);
    try {
      const keys = candidates.filter((c) => c.selected).map((c) => c.key);
      const result = await authFetchJson(`${base}/jobs/${job.id}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys }),
      });
      setApplyResult(result);
      setJob((j) => ({ ...j, applied_at: new Date().toISOString(), apply_result: result }));
      onDataChanged?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setApplying(false);
    }
  };

  const visible = useMemo(() => {
    if (!candidates) return [];
    if (filter === 'all') return candidates;
    if (filter === 'warnings') return candidates.filter((c) => c.warnings.length || c.rule_problem || c.draft_status === 'failed');
    return candidates.filter((c) => c.classification === filter);
  }, [candidates, filter]);
  const pages = Math.max(1, Math.ceil(visible.length / EXTRACT_PAGE_SIZE));
  const pageRows = visible.slice(page * EXTRACT_PAGE_SIZE, (page + 1) * EXTRACT_PAGE_SIZE);
  useEffect(() => setPage(0), [filter]);

  const counts = useMemo(() => {
    const out = {};
    for (const c of candidates || []) out[c.classification] = (out[c.classification] || 0) + 1;
    return out;
  }, [candidates]);
  const selectedCount = (candidates || []).filter((c) => c.selected).length;

  if (!canEdit) return null;

  const running = job?.status === 'running';
  return (
    <div className={pageStyles.card} data-testid="rule-extract-section">
      <h2 className={pageStyles.sectionHeading}>{t('config.ruleExtract.title')}</h2>
      <p className={pageStyles.hint}>{t(ruleFormat === 'SCH-DITA' ? 'config.ruleExtract.introSchematron' : 'config.ruleExtract.introBrex', { standard })}</p>

      {!running && (
        <label className={pageStyles.fileInputLabel}>
          {t('config.ruleExtract.chooseFile')}
          <input
            ref={fileRef}
            type="file"
            accept=".xml,.sch"
            hidden
            data-testid="rule-extract-file"
            disabled={uploading || !!drafting || applying}
            onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
          />
        </label>
      )}

      {(uploading || running) && (
        <p className={pageStyles.hint} data-testid="rule-extract-progress">
          <span className={pageStyles.spinner} aria-hidden="true" />
          {running
            ? t(`config.ruleExtract.phase.${job.phase}`, { processed: job.processed_items, total: job.total_items })
            : t('config.ruleExtract.uploading')}
        </p>
      )}
      {running && job.total_items > 0 && (
        <progress className={styles.progress} max={job.total_items} value={job.processed_items} />
      )}

      {error && (
        <ul className={pageStyles.errorList} data-testid="rule-extract-error">
          <li>{error}</li>
        </ul>
      )}
      {job?.status === 'failed' && (
        <ul className={pageStyles.errorList} data-testid="rule-extract-error">
          <li>{t('config.ruleExtract.failed', { error: job.error })}</li>
        </ul>
      )}

      {job?.warnings?.length > 0 && !applyResult && (
        <ul className={pageStyles.warningList} data-testid="rule-extract-file-warnings">
          {job.warnings.map((w, i) => (
            <li key={i}>{warningText(t, w)}</li>
          ))}
        </ul>
      )}

      {applyResult && (
        <div data-testid="rule-extract-result">
          <h3 className={pageStyles.subsectionHeading}>{t('config.ruleExtract.resultTitle', { file: job?.filename })}</h3>
          <ul className={pageStyles.summaryList}>
            <li>{t('config.ruleExtract.resultCreated', { count: applyResult.created })}</li>
            <li>{t('config.ruleExtract.resultUpdated', { count: applyResult.updated })}</li>
            <li>{t('config.ruleExtract.resultOmitted', { count: applyResult.omitted })}</li>
            <li>{t('config.ruleExtract.resultInvalidRule', { count: applyResult.invalid_rule })}</li>
          </ul>
          {applyResult.omitted_detail?.filter((o) => o.reason !== 'same' && o.reason !== 'no content').length > 0 && (
            <ul className={pageStyles.warningList}>
              {applyResult.omitted_detail
                .filter((o) => o.reason !== 'same' && o.reason !== 'no content')
                .map((o) => (
                  <li key={o.key}>{`${o.origin_identifier || o.key}: ${o.reason}`}</li>
                ))}
            </ul>
          )}
        </div>
      )}

      {candidates && !applyResult && (
        <div data-testid="rule-extract-review">
          <p className={pageStyles.hint} data-testid="rule-extract-counts">
            {t('config.ruleExtract.counts', { count: candidates.length, file: job.filename })}{' '}
            {Object.entries(counts)
              .map(([k, n]) => `${classLabel(t, { specification: '' }, k).replace(/\s*\(\)$/, '')}: ${n}`)
              .join(' · ')}
            {job.finished_at && (
              <span data-testid="rule-extract-elapsed">
                {' '}
                {t('config.ruleExtract.elapsed', { seconds: ((new Date(job.finished_at) - new Date(job.started_at)) / 1000).toFixed(1) })}
              </span>
            )}
          </p>
          {drafting && (
            <div data-testid="rule-extract-drafting">
              <p className={pageStyles.hint}>
                <span className={pageStyles.spinner} aria-hidden="true" />
                {t('config.ruleExtract.drafting', { done: drafting.done, total: drafting.total })}
              </p>
              <progress className={styles.progress} max={drafting.total} value={drafting.done} />
            </div>
          )}
          {aiProvider === null && <p className={pageStyles.hint}>{t('config.ruleExtract.noAi')}</p>}

          <div className={styles.toolbar}>
            <label>
              {t('config.ruleExtract.filter')}{' '}
              <select value={filter} onChange={(e) => setFilter(e.target.value)} data-testid="rule-extract-filter">
                {CLASS_FILTERS.map((f) => (
                  <option key={f} value={f}>
                    {f === 'all' || f === 'warnings'
                      ? t(`config.ruleExtract.filters.${f}`)
                      : classLabel(t, { specification: '' }, f).replace(/\s*\(\)$/, '')}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className={pageStyles.secondaryButton} onClick={() => patch(visible.map((c) => ({ key: c.key, selected: true })))}>
              {t('config.ruleExtract.selectAll')}
            </button>
            <button type="button" className={pageStyles.secondaryButton} onClick={() => patch(visible.map((c) => ({ key: c.key, selected: false })))}>
              {t('config.ruleExtract.selectNone')}
            </button>
          </div>

          <div className={styles.tableWrap}>
            <table className={styles.table} data-testid="rule-extract-table">
              <thead>
                <tr>
                  <th className={styles.colCheck} />
                  <th className={styles.colClass}>{t('config.ruleExtract.colClass')}</th>
                  <th className={styles.colId}>{t('config.ruleExtract.colId')}</th>
                  <th>{t('config.ruleExtract.colTitle')}</th>
                  <th>{t('config.ruleExtract.colDefinition')}</th>
                  <th>{t('config.ruleExtract.colProposal')}</th>
                  <th className={styles.colRule}>{t('config.ruleExtract.colRule')}</th>
                  <th className={styles.colWarnings}>{t('config.ruleExtract.colWarnings')}</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((c) => {
                  const editTexts = DRAFT_CLASSES.has(c.classification);
                  const editTitle = WRITES_TITLE.has(c.classification);
                  const editDefinition = editTexts && c.text_sources?.definition !== 'catalog';
                  const lines = [
                    ...(c.rule_problem ? [t('config.ruleExtract.invalidRule', { reason: c.rule_problem.message })] : []),
                    ...c.warnings.map((w) => warningText(t, w)),
                    ...(c.draft_status === 'failed' ? [t('config.ruleExtract.draftFailed')] : []),
                    ...vocabularyLines(t, c, vocabulary, standard),
                  ];
                  const needsDraft = editTexts && aiFieldsOf(c).length > 0 && (c.draft_status === 'pending' || c.draft_status === 'failed');
                  return (
                    <tr key={c.key} data-testid="rule-extract-row" data-key={c.key} data-origin={c.origin_identifier || ''}>
                      <td>
                        <input
                          type="checkbox"
                          checked={!!c.selected}
                          data-testid="rule-extract-select"
                          onChange={async (e) => {
                            const selected = e.target.checked;
                            await patch([{ key: c.key, selected }]);
                            // A default-BREX rule is only written once checked.
                            if (selected && c.classification === 'default_rule' && candidatesToDraft([{ ...c, selected }]).length) {
                              runDrafting([{ ...c, selected }]);
                            }
                          }}
                        />
                      </td>
                      <td>
                        <select
                          value={c.classification}
                          data-testid="rule-extract-class"
                          onChange={(e) => patch([{ key: c.key, classification: e.target.value }])}
                        >
                          {c.options.map((o) => (
                            <option key={o} value={o}>
                              {classLabel(t, c, o)}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className={styles.mono}>
                        <div data-testid="rule-extract-identifier">
                          {c.classification === 'new_ext' ? c.identifier || t('config.ruleExtract.extOnImport') : c.identifier}
                        </div>
                        {c.origin_identifier && c.origin_identifier !== c.identifier && (
                          <div className={styles.muted}>{t('config.ruleExtract.origin', { id: c.origin_identifier })}</div>
                        )}
                      </td>
                      <td>
                        {editTitle ? (
                          <EditableText value={c.title} testId="rule-extract-title" onSave={(v) => patch([{ key: c.key, title: v, draft_status: 'manual' }])} />
                        ) : (
                          <span>{c.title}</span>
                        )}
                        <SourceTag c={c} field="title" t={t} />
                      </td>
                      <td>
                        {editDefinition ? (
                          <EditableText value={c.definition} rows={3} testId="rule-extract-definition" onSave={(v) => patch([{ key: c.key, definition: v, draft_status: 'manual' }])} />
                        ) : (
                          <span className={styles.clamp}>{c.definition}</span>
                        )}
                        <SourceTag c={c} field="definition" t={t} />
                      </td>
                      <td>
                        {editTexts ? (
                          <EditableText value={c.proposal} rows={3} testId="rule-extract-proposal" onSave={(v) => patch([{ key: c.key, proposal: v, draft_status: 'manual' }])} />
                        ) : (
                          <span className={styles.clamp}>{c.proposal}</span>
                        )}
                        <SourceTag c={c} field="proposal" t={t} />
                        {needsDraft && aiProvider && !drafting && (
                          <button type="button" className={styles.linkButton} data-testid="rule-extract-draft-one" onClick={() => runDrafting([{ ...c, draft_status: 'pending' }])}>
                            {t('config.ruleExtract.draftOne')}
                          </button>
                        )}
                      </td>
                      <td>
                        <RuleCell c={c} t={t} />
                      </td>
                      <td>
                        {lines.length > 0 && (
                          <ul className={styles.warnings} data-testid="rule-extract-warnings">
                            {lines.map((l, i) => (
                              <li key={i}>{l}</li>
                            ))}
                          </ul>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className={styles.pager}>
            <button type="button" className={pageStyles.secondaryButton} disabled={page === 0} onClick={() => setPage((p) => p - 1)} data-testid="rule-extract-prev">
              ‹
            </button>
            <span data-testid="rule-extract-page">{t('config.ruleExtract.page', { page: page + 1, pages })}</span>
            <button type="button" className={pageStyles.secondaryButton} disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)} data-testid="rule-extract-next">
              ›
            </button>
          </div>

          <Button onClick={apply} busy={applying} busyLabel={t('config.ruleExtract.importing')} disabled={selectedCount === 0 || !!drafting} data-testid="rule-extract-apply">
            {t('config.ruleExtract.importSelected', { count: selectedCount })}
          </Button>
          {drafting && <p className={pageStyles.hint}>{t('config.ruleExtract.waitDrafting')}</p>}
        </div>
      )}
    </div>
  );
}
