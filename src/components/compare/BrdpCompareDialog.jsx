// "Comparar dos BRDP lado a lado": choose the other BRDP (the same one in
// another project the user can see, or another BRDP of this project), then
// see both in columns with every difference highlighted -- computed by code
// (src/utils/brdpCompare.js), never by the LLM. An editor can bring the
// other BRDP's Proposal (the normal edit path) or Rule (the Paste rule gate:
// format, XPath and names against this project's standard; saved as Draft
// with a "copied from" History event). "Explain the differences" hands the
// loaded BRDP to Ask's comparison mode.
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { authFetchJson } from '../../services/apiClient';
import { errorMessage } from '../../services/apiErrors';
import { compareDetails, diffRuleLines, diffText, foldEqualRows, lastTestOfDetail, ruleStateOfDetail } from '../../utils/brdpCompare.js';
import { validateRuleXml } from '../../hooks/useSuggestions';
import { RuleValidationWarnings } from '../assistant/RuleSuggestionPanel';
import recordsStyles from '../../pages/RecordsPage.module.css';
import styles from './BrdpCompareDialog.module.css';
import CatalogEditionTag from '../CatalogEditionTag';

const detailUrl = (projectId, brdpId, otherId) => `/api/projects/${projectId}/brdps/${brdpId}/compare-detail/${otherId}`;

function DiffSegments({ segments, side }) {
  return segments.map((s, i) =>
    s.changed ? (
      <mark key={i} className={side === 'left' ? styles.removed : styles.added} data-testid={side === 'left' ? 'diff-removed' : 'diff-added'}>
        {s.text}
      </mark>
    ) : (
      <span key={i}>{s.text}</span>
    )
  );
}

function TextRow({ label, left, right, testId }) {
  const d = diffText(left, right);
  return (
    <tr data-testid={testId} data-equal={d.equal ? 'true' : 'false'}>
      <th scope="row" className={styles.rowLabel}>{label}</th>
      <td className={styles.textCell}>{left ? <DiffSegments segments={d.left} side="left" /> : <span className={styles.empty}>—</span>}</td>
      <td className={styles.textCell}>{right ? <DiffSegments segments={d.right} side="right" /> : <span className={styles.empty}>—</span>}</td>
    </tr>
  );
}

function ValueRow({ label, left, right, testId }) {
  const equal = left === right;
  return (
    <tr data-testid={testId} data-equal={equal ? 'true' : 'false'}>
      <th scope="row" className={styles.rowLabel}>{label}</th>
      <td className={equal ? undefined : styles.changedCell}>{left}</td>
      <td className={equal ? undefined : styles.changedCell}>{right}</td>
    </tr>
  );
}

function RuleLines({ rows }) {
  const { t } = useTranslation();
  const [openFolds, setOpenFolds] = useState(new Set());
  const items = foldEqualRows(rows);
  const out = [];
  items.forEach((row, i) => {
    if (row.kind === 'fold' && !openFolds.has(i)) {
      out.push(
        <div key={`f${i}`} className={styles.foldRow}>
          <button type="button" className={recordsStyles.linkButton} onClick={() => setOpenFolds((prev) => new Set(prev).add(i))} data-testid="compare-show-equal-lines">
            {t('records.compare.showEqualLines', { count: row.rows.length })}
          </button>
        </div>
      );
      return;
    }
    const expanded = row.kind === 'fold' ? row.rows : [row];
    expanded.forEach((r, j) => {
      const leftClass = r.kind === 'removed' || r.kind === 'changed' ? styles.lineRemoved : r.kind === 'added' ? styles.lineBlank : '';
      const rightClass = r.kind === 'added' || r.kind === 'changed' ? styles.lineAdded : r.kind === 'removed' ? styles.lineBlank : '';
      out.push(
        <div key={`${i}-${j}`} className={styles.lineRow} data-kind={r.kind} data-testid="compare-rule-line">
          <pre className={`${styles.line} ${leftClass}`}>{r.left ?? ''}</pre>
          <pre className={`${styles.line} ${rightClass}`}>{r.right ?? ''}</pre>
        </div>
      );
    });
  });
  return <div className={styles.lines}>{out}</div>;
}

function valuesText(values) {
  return values.length ? values.join(', ') : '—';
}

function StructureItem({ item }) {
  const { t } = useTranslation();
  const part = item.left || item.right;
  const isSch = part && 'context' in part;
  const describe = (p) =>
    isSch
      ? `${p.kind} — context: ${p.context} — test: ${p.test}`
      : p.kind === 'nonContext'
        ? t('records.compare.structNonContext')
        : `${p.path} — ${t('records.compare.structFlag')} ${p.flag ?? '—'}${p.schema ? ` — ${t('records.compare.structSchema')} ${p.schema}` : ''}${p.values.length ? ` — ${t('records.compare.structValues')}: ${valuesText(p.values)}` : ''}`;
  if (item.kind === 'added' || item.kind === 'removed') {
    return (
      <li className={item.kind === 'added' ? styles.structAdded : styles.structRemoved} data-testid="compare-structure-item" data-kind={item.kind}>
        {t(`records.compare.struct_${item.kind}`)}: <code>{part.ruleId}</code> {describe(part)}
      </li>
    );
  }
  const c = item.changes;
  const lines = [];
  if (c.kind) lines.push(`${c.kind[0]} → ${c.kind[1]}`);
  if (c.path) lines.push(`${t('records.compare.structPath')}: ${c.path[0]} → ${c.path[1]}`);
  if (c.context) lines.push(`context: ${c.context[0]} → ${c.context[1]}`);
  if (c.test) lines.push(`test: ${c.test[0]} → ${c.test[1]}`);
  if (c.flag) lines.push(`${t('records.compare.structFlag')}: ${c.flag[0] ?? '—'} → ${c.flag[1] ?? '—'}`);
  if (c.schema) lines.push(`${t('records.compare.structSchema')}: ${c.schema[0] || t('records.compare.allSchemas')} → ${c.schema[1] || t('records.compare.allSchemas')}`);
  const valueTokens = [...(c.valuesAdded || []).map((v) => `+${v}`), ...(c.valuesRemoved || []).map((v) => `−${v}`)];
  return (
    <li className={item.kind === 'same' ? styles.structSame : styles.structChanged} data-testid="compare-structure-item" data-kind={item.kind}>
      <code>{item.left.ruleId === item.right.ruleId ? item.left.ruleId : `${item.left.ruleId} / ${item.right.ruleId}`}</code>{' '}
      {item.kind === 'same' ? t('records.compare.struct_same') : lines.join(' · ')}
      {valueTokens.length > 0 && (
        <span className={styles.valueTokens} data-testid="compare-structure-values">
          {lines.length ? ' · ' : ''}
          {valueTokens.join(', ')}
        </span>
      )}
    </li>
  );
}

function RuleComparison({ facts, left, right }) {
  const { t } = useTranslation();
  const { rule } = facts;
  const s = rule.structure;
  const [view, setView] = useState('structure');
  const rows = useMemo(() => diffRuleLines(rule.leftText, rule.rightText), [rule.leftText, rule.rightText]);
  if (rule.status === 'none') return <p className={styles.empty}>{t('records.compare.noRuleEither')}</p>;
  const hasStructure = s.status === 'compared';
  return (
    <div data-testid="compare-rule">
      {s.status === 'formats_differ' && (
        <p className={recordsStyles.vocabWarning} data-testid="compare-formats-differ">
          ⚠ {t('records.compare.formatsDiffer', { left: s.leftFormat, right: s.rightFormat })}
        </p>
      )}
      {rule.status === 'missing' && (
        <p className={styles.note} data-testid="compare-rule-missing">
          {t(rule.side === 'left' ? 'records.compare.noRuleLeft' : 'records.compare.noRuleRight')}
        </p>
      )}
      {!rule.normalized && <p className={styles.note}>{t('records.compare.notNormalized')}</p>}
      {hasStructure && (
        <div className={styles.viewTabs} role="tablist">
          <button type="button" role="tab" aria-selected={view === 'structure'} className={view === 'structure' ? styles.viewTabActive : styles.viewTab} onClick={() => setView('structure')}>
            {t('records.compare.ruleStructure')}
          </button>
          <button type="button" role="tab" aria-selected={view === 'text'} className={view === 'text' ? styles.viewTabActive : styles.viewTab} onClick={() => setView('text')} data-testid="compare-rule-text-tab">
            {t('records.compare.ruleText')}
          </button>
        </div>
      )}
      {hasStructure && view === 'structure' ? (
        <ul className={styles.structure} data-testid="compare-structure">
          {s.items.map((item, i) => (
            <StructureItem key={i} item={item} />
          ))}
        </ul>
      ) : (
        <>
          <div className={styles.lineRow}>
            <div className={styles.lineHeader}>{left.rule ? left.rule_format : t('records.compare.noRule')}</div>
            <div className={styles.lineHeader}>{right.rule ? right.rule_format : t('records.compare.noRule')}</div>
          </div>
          <RuleLines rows={rows} />
        </>
      )}
    </div>
  );
}

function summaryParts(t, facts) {
  const parts = [];
  for (const field of ['title', 'definition', 'proposal']) {
    parts.push(t(facts[field] ? 'records.compare.summaryEqual' : 'records.compare.summaryDifferent', { field: t(`records.compare.rows.${field}`) }));
  }
  const { rule } = facts;
  if (rule.status === 'none') parts.push(t('records.compare.summaryNoRule'));
  else if (rule.status === 'missing') parts.push(t('records.compare.summaryRuleOneSide'));
  else if (rule.status === 'equal') parts.push(t('records.compare.summaryRuleEqual'));
  else {
    const s = rule.structure;
    const details = [];
    if (s.status === 'formats_differ') details.push(t('records.compare.summaryFormatsDiffer'));
    if (s.status === 'compared') {
      if (s.valuesAdded.length) details.push(t('records.compare.summaryValuesAdded', { count: s.valuesAdded.length }));
      if (s.valuesRemoved.length) details.push(t('records.compare.summaryValuesRemoved', { count: s.valuesRemoved.length }));
      const added = s.items.filter((i) => i.kind === 'added').length;
      const removed = s.items.filter((i) => i.kind === 'removed').length;
      if (added) details.push(t('records.compare.summaryRulesAdded', { count: added }));
      if (removed) details.push(t('records.compare.summaryRulesRemoved', { count: removed }));
      if (!s.changed) details.push(t('records.compare.summaryTextOnly'));
    }
    parts.push(details.length ? t('records.compare.summaryRuleDifferentWith', { details: details.join(', ') }) : t('records.compare.summaryRuleDifferent'));
  }
  return parts;
}

function testLabel(t, detail) {
  const test = lastTestOfDetail(detail);
  if (!test) return t('records.compare.notTested');
  const result = t(`records.ruleTest.results.${test.result}`, { defaultValue: test.result });
  return test.upToDate ? result : t('records.compare.testOutdated', { result });
}

function CandidateStates({ candidate }) {
  const { t } = useTranslation();
  const test = candidate.last_test_result
    ? t(`records.ruleTest.results.${candidate.last_test_result}`, { defaultValue: candidate.last_test_result })
    : t('records.compare.notTested');
  return (
    <span className={styles.candidateStates}>
      {t(`records.validationOptions.${candidate.validation}`, { defaultValue: candidate.validation })} ·{' '}
      {t('records.compare.candidateRule', { state: t(`records.rule.states.${candidate.rule_state}`) })} · {t('records.compare.candidateTest', { test })}
    </span>
  );
}

export default function BrdpCompareDialog({ projectId, project, selected, brdps, canEdit, ruleFormat, vocabulary, handleUpdate, onRuleCopied, onExplain, onClose }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState('same');
  const [candidates, setCandidates] = useState(null);
  const [candidatesError, setCandidatesError] = useState(null);
  const [query, setQuery] = useState('');
  const [chosenId, setChosenId] = useState(null);
  const [left, setLeft] = useState(null);
  const [right, setRight] = useState(null);
  const [detailError, setDetailError] = useState(null);
  const [leftToken, setLeftToken] = useState(0);
  const [confirm, setConfirm] = useState(null); // 'proposal' | 'rule' | null
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    authFetchJson(`/api/projects/${projectId}/brdps/${selected.id}/compare-candidates`)
      .then((body) => {
        if (cancelled) return;
        setCandidates(body);
        if (body.same_brdp.length > 0) setChosenId(body.same_brdp[0].brdp_id);
        // An EXT identifier is never searched in other projects: the other tab opens.
        else if (!body.catalog_identifier) setTab('project');
      })
      .catch((err) => !cancelled && setCandidatesError(errorMessage(err, t)));
    return () => {
      cancelled = true;
    };
  }, [projectId, selected.id]);

  useEffect(() => {
    let cancelled = false;
    authFetchJson(detailUrl(projectId, selected.id, selected.id))
      .then((body) => !cancelled && setLeft(body))
      .catch((err) => !cancelled && setDetailError(errorMessage(err, t)));
    return () => {
      cancelled = true;
    };
  }, [projectId, selected.id, leftToken]);

  useEffect(() => {
    if (!chosenId) return undefined;
    let cancelled = false;
    setRight(null);
    setConfirm(null);
    setActionError(null);
    authFetchJson(detailUrl(projectId, selected.id, chosenId))
      .then((body) => !cancelled && setRight(body))
      .catch((err) => !cancelled && setDetailError(errorMessage(err, t)));
    return () => {
      cancelled = true;
    };
  }, [projectId, selected.id, chosenId]);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const projectMatches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return brdps
      .filter((b) => b.id !== selected.id)
      .filter((b) => !q || b.identifier.toLowerCase().includes(q) || (b.title || '').toLowerCase().includes(q))
      .slice(0, 50);
  }, [brdps, query, selected.id]);

  const facts = left && right ? compareDetails(left, right) : null;
  const ruleValidation = right?.rule && ruleFormat ? validateRuleXml(right.rule.rule_xml, vocabulary, ruleFormat) : null;
  const sameStandard = left && right && left.standard === right.standard;

  const bringProposal = async () => {
    setBusy(true);
    setActionError(null);
    try {
      await handleUpdate(selected.id, { proposal: right.proposal });
      setConfirm(null);
      setLeftToken((n) => n + 1);
    } catch (err) {
      setActionError(errorMessage(err, t));
    } finally {
      setBusy(false);
    }
  };

  const bringRule = async () => {
    if (!ruleValidation?.acceptable) return;
    setBusy(true);
    setActionError(null);
    try {
      await authFetchJson(`/api/projects/${projectId}/brdps/${selected.id}/approvals/${ruleFormat}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rule_xml: right.rule.rule_xml, source: 'copied', status: 'pending_review', copied_from_brdp_id: right.brdp_id }),
      });
      setConfirm(null);
      setLeftToken((n) => n + 1);
      onRuleCopied();
    } catch (err) {
      setActionError(errorMessage(err, t));
    } finally {
      setBusy(false);
    }
  };

  const explain = () => {
    onExplain({
      source: right.project_id === projectId ? 'records' : 'other_project',
      projectName: right.project_name,
      standard: right.standard,
      identifier: right.identifier,
      title: right.title,
      definition: right.definition,
      proposal: right.proposal,
      validation: right.validation,
      ruleState: ruleStateOfDetail(right),
      ruleXml: right.rule?.rule_xml ?? null,
    });
  };

  const header = (detail, testId) => (
    <div className={styles.columnHeader} data-testid={testId}>
      <strong>
        {detail.identifier}
        <CatalogEditionTag edition={detail.catalog_edition} standard={detail.standard} />
      </strong>
      <span>{t('records.compare.columnHeader', { project: detail.project_name, standard: detail.standard })}</span>
    </div>
  );

  const ruleBlockedReason = !right?.rule
    ? null
    : !ruleFormat
      ? t('records.compare.ruleNoFormat', { standard: project.standard })
      : ruleValidation && !ruleValidation.acceptable
        ? t('records.compare.ruleBlocked')
        : null;

  return (
    <div className={recordsStyles.modalOverlay} onClick={onClose}>
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="brdp-compare-title" data-testid="brdp-compare-dialog" onClick={(e) => e.stopPropagation()}>
        <div className={styles.titleBar}>
          <h3 id="brdp-compare-title" className={styles.title}>
            {t('records.compare.title', { identifier: selected.identifier })}
            <CatalogEditionTag edition={selected.catalog_edition} standard={project.standard} />
          </h3>
          <button type="button" onClick={onClose} data-testid="compare-close">
            {t('records.compare.close')}
          </button>
        </div>

        <div className={styles.tabs} role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'same'} className={tab === 'same' ? styles.tabActive : styles.tab} onClick={() => setTab('same')} data-testid="compare-tab-same">
            {t('records.compare.tabSame')}
          </button>
          <button type="button" role="tab" aria-selected={tab === 'project'} className={tab === 'project' ? styles.tabActive : styles.tab} onClick={() => setTab('project')} data-testid="compare-tab-project">
            {t('records.compare.tabProject')}
          </button>
        </div>

        <div className={styles.picker} data-testid="compare-picker">
          {tab === 'same' ? (
            candidatesError ? (
              <p className={recordsStyles.vocabWarning}>⚠ {t('records.compare.candidatesError', { error: candidatesError })}</p>
            ) : !candidates ? (
              <p className={styles.note}>{t('records.compare.loadingCandidates')}</p>
            ) : !candidates.catalog_identifier ? (
              <p className={styles.note} data-testid="compare-ext-note">{t('records.compare.extNotSearched')}</p>
            ) : candidates.same_brdp.length === 0 ? (
              <p className={styles.note} data-testid="compare-no-same">{t('records.compare.noSameBrdp')}</p>
            ) : (
              <ul className={styles.candidateList}>
                {candidates.same_brdp.map((c) => (
                  <li key={c.brdp_id}>
                    <button type="button" className={chosenId === c.brdp_id ? styles.candidateActive : styles.candidate} aria-pressed={chosenId === c.brdp_id} onClick={() => setChosenId(c.brdp_id)} data-testid="compare-candidate">
                      <span className={styles.candidateProject}>
                        {c.project_name}
                        <CatalogEditionTag edition={c.catalog_edition} standard={c.standard} />
                      </span>
                      <span className={c.standard === candidates.standard ? styles.candidateStandard : styles.candidateStandardOther}>{c.standard}</span>
                      <CandidateStates candidate={c} />
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : (
            <>
              <input className={recordsStyles.input} value={query} placeholder={t('records.compare.searchPlaceholder')} onChange={(e) => setQuery(e.target.value)} data-testid="compare-project-search" autoFocus />
              {projectMatches.length === 0 ? (
                <p className={styles.note}>{t('records.compare.noMatches')}</p>
              ) : (
                <ul className={styles.candidateList}>
                  {projectMatches.map((b) => (
                    <li key={b.id}>
                      <button type="button" className={chosenId === b.id ? styles.candidateActive : styles.candidate} aria-pressed={chosenId === b.id} onClick={() => setChosenId(b.id)} data-testid="compare-project-candidate">
                        <span className={styles.candidateProject}>
                          {b.identifier}
                          <CatalogEditionTag edition={b.catalog_edition} standard={project.standard} />
                        </span>
                        <span className={styles.candidateTitle}>{b.title}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>

        {detailError && <p className={recordsStyles.vocabWarning}>⚠ {t('records.compare.detailError', { error: detailError })}</p>}
        {!chosenId ? (
          <p className={styles.note}>{t('records.compare.chooseHint')}</p>
        ) : !facts ? (
          <p className={styles.note}>{t('records.compare.loadingDetail')}</p>
        ) : (
          <div className={styles.comparison} data-testid="compare-view">
            {!sameStandard && (
              <p className={recordsStyles.vocabWarning} data-testid="compare-standard-differs">
                ⚠ {t('records.compare.standardDiffers', { left: left.standard, right: right.standard })}
              </p>
            )}
            <p className={styles.summary} data-testid="compare-summary">
              {summaryParts(t, facts).join(' · ')}
            </p>
            <div className={styles.actions}>
              <button type="button" onClick={explain} title={t('records.compare.explainTitle')} data-testid="compare-explain">
                {t('records.compare.explain')}
              </button>
              {canEdit && (
                <>
                  <button type="button" disabled={busy || facts.proposal} onClick={() => setConfirm('proposal')} title={facts.proposal ? t('records.compare.sameProposal') : undefined} data-testid="compare-use-proposal">
                    {t('records.compare.useProposal')}
                  </button>
                  {right.rule && (
                    <button type="button" disabled={busy || ruleIsEqual(facts)} onClick={() => setConfirm('rule')} title={ruleIsEqual(facts) ? t('records.compare.sameRule') : undefined} data-testid="compare-use-rule">
                      {t('records.compare.useRule')}
                    </button>
                  )}
                </>
              )}
            </div>
            {confirm === 'proposal' && (
              <div className={styles.confirm} data-testid="compare-confirm">
                <p>{t('records.compare.confirmProposal')}</p>
                <div className={recordsStyles.suggestionActions}>
                  <button type="button" onClick={bringProposal} disabled={busy} data-testid="compare-confirm-yes">
                    {t('records.compare.confirmReplace')}
                  </button>
                  <button type="button" onClick={() => setConfirm(null)} disabled={busy}>
                    {t('records.compare.cancel')}
                  </button>
                </div>
              </div>
            )}
            {confirm === 'rule' && (
              <div className={styles.confirm} data-testid="compare-confirm">
                {ruleValidation && <RuleValidationWarnings validation={ruleValidation} standard={project.standard} />}
                {ruleBlockedReason ? (
                  <p className={recordsStyles.vocabWarning} data-testid="compare-rule-blocked">
                    ⚠ {ruleBlockedReason}
                  </p>
                ) : (
                  <>
                    <p>{t('records.compare.confirmRule')}</p>
                    {!sameStandard && (
                      <p className={recordsStyles.vocabWarning} data-testid="compare-rule-standard-warning">
                        ⚠ {t('records.compare.confirmRuleStandard', { standard: right.standard, current: project.standard })}
                      </p>
                    )}
                    {ruleStateOfDetail(left) === 'verified' && <p className={styles.note}>{t('records.compare.confirmRuleVerified')}</p>}
                  </>
                )}
                <div className={recordsStyles.suggestionActions}>
                  {!ruleBlockedReason && (
                    <button type="button" onClick={bringRule} disabled={busy} data-testid="compare-confirm-yes">
                      {t('records.compare.confirmReplace')}
                    </button>
                  )}
                  <button type="button" onClick={() => setConfirm(null)} disabled={busy}>
                    {t('records.compare.cancel')}
                  </button>
                </div>
              </div>
            )}
            {actionError && <p className={recordsStyles.vocabWarning}>⚠ {t('records.compare.actionError', { error: actionError })}</p>}

            <table className={styles.table}>
              <colgroup>
                <col className={styles.labelCol} />
                <col />
                <col />
              </colgroup>
              <thead>
                <tr>
                  <th />
                  <th>{header(left, 'compare-left-header')}</th>
                  <th>{header(right, 'compare-right-header')}</th>
                </tr>
              </thead>
              <tbody>
                <TextRow label={t('records.compare.rows.title')} left={left.title} right={right.title} testId="compare-row-title" />
                <TextRow label={t('records.compare.rows.definition')} left={left.definition} right={right.definition} testId="compare-row-definition" />
                <TextRow label={t('records.compare.rows.proposal')} left={left.proposal} right={right.proposal} testId="compare-row-proposal" />
                <ValueRow
                  label={t('records.compare.rows.validation')}
                  left={t(`records.validationOptions.${left.validation}`, { defaultValue: left.validation })}
                  right={t(`records.validationOptions.${right.validation}`, { defaultValue: right.validation })}
                  testId="compare-row-validation"
                />
                <tr data-testid="compare-row-rule" data-status={facts.rule.status}>
                  <th scope="row" className={styles.rowLabel}>
                    {t('records.compare.rows.rule')}
                  </th>
                  <td colSpan={2}>
                    <RuleComparison facts={facts} left={left} right={right} />
                  </td>
                </tr>
                <ValueRow
                  label={t('records.compare.rows.ruleState')}
                  left={t(`records.rule.states.${ruleStateOfDetail(left)}`)}
                  right={t(`records.rule.states.${ruleStateOfDetail(right)}`)}
                  testId="compare-row-rule-state"
                />
                <ValueRow label={t('records.compare.rows.lastTest')} left={testLabel(t, left)} right={testLabel(t, right)} testId="compare-row-last-test" />
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function ruleIsEqual(facts) {
  return facts.rule.status === 'equal';
}
