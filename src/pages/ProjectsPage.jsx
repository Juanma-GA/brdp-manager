import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuthContext } from '../context/AuthContext';
import { useProjectContext } from '../context/ProjectContext';
import { authFetchJson } from '../services/apiClient';
import { errorMessage } from '../services/apiErrors';
import ErrorNotice from '../components/ErrorNotice';
import Button from '../components/Button';
import SortableHeader from '../components/SortableHeader';
import { ProposalStatusSummary, RuleStatusSummary } from '../components/StatusCountsSummary';
import styles from './ProjectsPage.module.css';

// The 7 exact standards the project can be created with (fixed forever
// once created, docs/v2 §2) -- "S1000D 5.0"/"6.0" are listed but
// disabled: no generation engine exists for them yet, same criterion
// CLAUDE.md already documents for v1 ("Lo que NO está implementado
// todavía"), not being built in this round either. There is no longer a
// separate "Schematron 1.0 — S1000D" standard -- Schematron for S1000D is
// now a Generate-page output selector on the S1000D 3.0.1/4.1/4.2
// standards (see GeneratePage.jsx), not its own project standard.
//
// "DITA 1.3" split into "DITA 1.3 Xpath2.0"/"DITA 1.3 Xpath3.0" (migration
// 0013_split_dita_xpath_standards.py) -- unlike the Schematron-for-S1000D
// merge above, each BRDP's Rule here is genuinely different hand-authored
// XPath 2.0 vs 3.0 syntax with no shared deterministic conversion step, so
// two real, separate standards exist rather than one config field, and
// which flavor a project uses is visible right in this table's own
// "Project standard" column without opening it.
const STANDARD_OPTIONS = [
  { value: 'S1000D 3.0.1', comingSoon: false },
  { value: 'S1000D 4.1', comingSoon: false },
  { value: 'S1000D 4.2', comingSoon: false },
  { value: 'S1000D 5.0', comingSoon: true },
  { value: 'S1000D 6.0', comingSoon: true },
  { value: 'DITA 1.3 Xpath2.0', comingSoon: false },
  { value: 'DITA 1.3 Xpath3.0', comingSoon: false },
];

function CreateProjectForm({ onCreated, onCancel }) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [standard, setStandard] = useState(STANDARD_OPTIONS[0].value);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState(null);
  const [nameError, setNameError] = useState(false);
  // Real count read from brdp_catalog, never hardcoded -- 0 means either
  // no catalog exists yet for this standard, or the standard isn't
  // implemented at all (5.0/6.0), and the checkbox simply doesn't render.
  const [catalogCount, setCatalogCount] = useState(0);
  const [seedFromCatalog, setSeedFromCatalog] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSeedFromCatalog(false);
    authFetchJson(`/api/brdp-catalog/count?standard=${encodeURIComponent(standard)}`)
      .then((data) => {
        if (!cancelled) setCatalogCount(data.count);
      })
      .catch(() => {
        if (!cancelled) setCatalogCount(0);
      });
    return () => {
      cancelled = true;
    };
  }, [standard]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    const isEmpty = !name.trim();
    setNameError(isEmpty);
    if (isEmpty) return;
    setCreating(true);
    try {
      await authFetchJson('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, standard, seed_from_catalog: seedFromCatalog }),
      });
      onCreated();
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <form className={styles.inlineForm} onSubmit={handleSubmit}>
      <h3 className={styles.formTitle}>{t('projects.create.title')}</h3>
      {error && <p className={styles.error}>{error}</p>}
      <div className={styles.formGroup}>
        <label className={styles.label}>{t('projects.create.nameLabel')}</label>
        <input
          className={`${styles.input} ${nameError ? styles.inputError : ''}`}
          value={name}
          placeholder={t('projects.create.namePlaceholder')}
          onChange={(e) => {
            setName(e.target.value);
            setNameError(false);
          }}
        />
        {nameError && <p className={styles.fieldError}>{t('validation.required')}</p>}
      </div>
      <div className={styles.formGroup}>
        <label className={styles.label}>{t('projects.create.standardLabel')}</label>
        <select className={styles.select} value={standard} onChange={(e) => setStandard(e.target.value)}>
          {STANDARD_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value} disabled={opt.comingSoon}>
              {opt.value}
              {opt.comingSoon ? ` ${t('projects.create.comingSoon')}` : ''}
            </option>
          ))}
        </select>
        <p className={styles.hint}>{t('projects.create.standardHint')}</p>
      </div>
      {catalogCount > 0 && (
        <div className={styles.formGroup}>
          <label className={styles.checkboxLabel}>
            <input
              type="checkbox"
              checked={seedFromCatalog}
              onChange={(e) => setSeedFromCatalog(e.target.checked)}
            />
            {t('projects.create.seedFromCatalog', { count: catalogCount })}
          </label>
        </div>
      )}
      <div className={styles.formActions}>
        <button type="submit" className={styles.button} disabled={creating}>
          {creating ? t('projects.create.creating') : t('projects.create.submit')}
        </button>
        <button type="button" className={styles.buttonSecondary} onClick={onCancel} disabled={creating}>
          {t('projects.create.cancel')}
        </button>
      </div>
    </form>
  );
}

function RenameProjectForm({ project, onRenamed, onCancel }) {
  const { t } = useTranslation();
  const [name, setName] = useState(project.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [nameError, setNameError] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    const isEmpty = !name.trim();
    setNameError(isEmpty);
    if (isEmpty) return;
    setSaving(true);
    try {
      await authFetchJson(`/api/projects/${project.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      onRenamed();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className={styles.renameForm} onSubmit={handleSubmit}>
      {error && <p className={styles.error}>{error}</p>}
      <div className={styles.renameFieldWrap}>
        <input
          className={`${styles.input} ${nameError ? styles.inputError : ''}`}
          value={name}
          autoFocus
          onChange={(e) => {
            setName(e.target.value);
            setNameError(false);
          }}
        />
        {nameError && <p className={styles.fieldError}>{t('validation.required')}</p>}
      </div>
      <button type="submit" className={styles.button} disabled={saving}>
        {saving ? t('projects.rename.saving') : t('projects.rename.save')}
      </button>
      <button type="button" className={styles.buttonSecondary} onClick={onCancel} disabled={saving}>
        {t('projects.rename.cancel')}
      </button>
    </form>
  );
}

function DeleteProjectModal({ project, onDeleted, onCancel }) {
  const { t } = useTranslation();
  const [brdpCount, setBrdpCount] = useState(null);
  // AACF 1, Part 2: a count that could not be loaded is never "0 BRDPs" --
  // the dialog says so, with Retry, and deleting waits for the real count.
  const [countError, setCountError] = useState(null);
  const [countToken, setCountToken] = useState(0);
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setCountError(null);
    authFetchJson(`/api/projects/${project.id}/brdps`)
      .then((data) => !cancelled && setBrdpCount(data.length))
      .catch((err) => !cancelled && setCountError(err));
    return () => {
      cancelled = true;
    };
  }, [project.id, countToken]);

  const nameMatches = confirmText === project.name;
  const countKnown = brdpCount !== null;

  const handleDelete = async () => {
    if (!nameMatches || !countKnown) return;
    setDeleting(true);
    setError(null);
    try {
      await authFetchJson(`/api/projects/${project.id}`, { method: 'DELETE' });
      onDeleted();
    } catch (err) {
      setError(errorMessage(err, t));
      setDeleting(false);
    }
  };

  return (
    <div className={styles.modalOverlay} onClick={onCancel}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <h3 className={styles.formTitle}>{t('projects.delete.title')}</h3>
        <p className={styles.projectName}>{project.name}</p>
        {error && <p className={styles.error}>{error}</p>}
        {countError && <ErrorNotice testId="delete-project-count-error" message={t('projects.delete.countFailed', { reason: errorMessage(countError, t) })} onRetry={() => setCountToken((n) => n + 1)} />}
        {brdpCount !== null && (
          <p className={styles.warningText}>
            {t('projects.delete.warning', { count: brdpCount })}
          </p>
        )}
        <p className={styles.warningText}>{t('projects.delete.irreversible')}</p>
        <div className={styles.formGroup}>
          <label className={styles.label}>{t('projects.delete.confirmLabel', { name: project.name })}</label>
          <input
            className={styles.input}
            value={confirmText}
            placeholder={t('projects.delete.confirmPlaceholder')}
            onChange={(e) => setConfirmText(e.target.value)}
          />
          {confirmText.length > 0 && !nameMatches && (
            <p className={styles.error}>{t('projects.delete.mismatch')}</p>
          )}
        </div>
        <div className={styles.formActions}>
          <button
            type="button"
            className={styles.buttonDanger}
            onClick={handleDelete}
            disabled={!nameMatches || !countKnown || deleting}
            title={!countKnown ? t('projects.delete.waitForCount') : undefined}
          >
            {deleting ? t('projects.delete.deleting') : t('projects.delete.confirmButton')}
          </button>
          <button type="button" className={styles.buttonSecondary} onClick={onCancel} disabled={deleting}>
            {t('projects.delete.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}

// Duplicar un proyecto (admin): a snapshot copy under another name. The
// request can take a while with thousands of BRDPs -- the button stays busy
// with no client timeout; a refusal (name taken, job running) is shown here
// with its reason.
function DuplicateProjectModal({ project, onDuplicated, onCancel }) {
  const { t } = useTranslation();
  const [name, setName] = useState(() => t('projects.duplicate.defaultName', { name: project.name }));
  const [duplicating, setDuplicating] = useState(false);
  const [error, setError] = useState(null);
  const trimmed = name.trim();

  const handleDuplicate = async (e) => {
    e.preventDefault();
    if (!trimmed || duplicating) return;
    setDuplicating(true);
    setError(null);
    try {
      const copy = await authFetchJson(`/api/projects/${project.id}/duplicate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });
      onDuplicated(copy);
    } catch (err) {
      setError(errorMessage(err, t));
      setDuplicating(false);
    }
  };

  return (
    <div className={styles.modalOverlay} onClick={duplicating ? undefined : onCancel}>
      <form className={styles.modal} onClick={(e) => e.stopPropagation()} onSubmit={handleDuplicate} data-testid="duplicate-project-dialog">
        <h3 className={styles.formTitle}>{t('projects.duplicate.title')}</h3>
        <p className={styles.projectName}>{project.name}</p>
        <p className={styles.hint}>{t('projects.duplicate.copied')}</p>
        <p className={styles.hint}>{t('projects.duplicate.notCopied')}</p>
        <div className={styles.formGroup}>
          <label className={styles.label} htmlFor="duplicate-project-name">{t('projects.duplicate.nameLabel')}</label>
          <input
            id="duplicate-project-name"
            className={styles.input}
            value={name}
            disabled={duplicating}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
          />
        </div>
        {error && <ErrorNotice testId="duplicate-project-error" message={error} />}
        <div className={styles.formActions}>
          <Button type="submit" busy={duplicating} busyLabel={t('projects.duplicate.duplicating')} disabled={!trimmed}>
            {t('projects.duplicate.confirmButton')}
          </Button>
          <button type="button" className={styles.buttonSecondary} onClick={onCancel} disabled={duplicating}>
            {t('projects.duplicate.cancel')}
          </button>
        </div>
      </form>
    </div>
  );
}

export default function ProjectsPage() {
  const { t } = useTranslation();
  const { user } = useAuthContext();
  const { projects, isLoading, error, refreshProjects } = useProjectContext();
  const navigate = useNavigate();
  const isAdmin = user?.global_role === 'admin';

  const [showCreate, setShowCreate] = useState(false);
  const [renamingId, setRenamingId] = useState(null);
  const [deletingProject, setDeletingProject] = useState(null);
  const [duplicatingProject, setDuplicatingProject] = useState(null);
  // The last copy made here: { source, copy } -- the list shows it and this
  // notice links to it.
  const [duplicated, setDuplicated] = useState(null);

  // Same simple (non-nested-functional-updater) toggle pattern as Records/
  // User Management -- avoids the StrictMode double-toggle bug seen earlier.
  const [sortField, setSortField] = useState(null);
  const [sortDir, setSortDir] = useState('asc');
  const toggleSort = (field) => {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  };

  // Both columns are plain alphabetical -- unlike Proposal/Rule Status,
  // standards (BREX 4.2, Schematron DITA, ...) have no natural order
  // between them, so no special-cased comparator is needed here.
  const sortedProjects = !sortField
    ? projects
    : [...projects].sort((a, b) => {
        const cmp =
          sortField === 'name' ? a.name.localeCompare(b.name) : a.standard.localeCompare(b.standard);
        return sortDir === 'asc' ? cmp : -cmp;
      });

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>{t('projects.title')}</h1>
          <p className={styles.subtitle}>{t('projects.subtitle')}</p>
        </div>
        <div className={styles.headerActions}>
          {isAdmin && !showCreate && (
            <button className={styles.button} onClick={() => setShowCreate(true)}>
              {t('projects.create.button')}
            </button>
          )}
        </div>
      </div>

      {showCreate && (
        <CreateProjectForm
          onCreated={() => {
            setShowCreate(false);
            refreshProjects();
          }}
          onCancel={() => setShowCreate(false)}
        />
      )}

      {duplicated && (
        <div className={styles.successNotice} role="status" data-testid="duplicate-project-done">
          <span>{t('projects.duplicate.done', { name: duplicated.source, copy: duplicated.copy.name })}</span>
          <button type="button" className={styles.navAction} onClick={() => navigate(`/projects/${duplicated.copy.id}/records`)}>
            {t('projects.duplicate.open')}
          </button>
          <button type="button" className={styles.buttonSecondary} onClick={() => setDuplicated(null)}>
            {t('projects.duplicate.dismiss')}
          </button>
        </div>
      )}

      {isLoading && <p>…</p>}
      {error && <p className={styles.error}>{error}</p>}

      {!isLoading && !error && projects.length === 0 && <div className={styles.empty}>{t('projects.empty')}</div>}

      {!isLoading && projects.length > 0 && (
        <table className={styles.table}>
          <thead>
            {/* Two-level header (docs request): with 10 project rows,
                repeating "V"/"P"/"R" (and "V"/"D"/"T") on every single row
                was the same 3+3 labels said 10 times over -- they now live
                once, as the leaf sub-header of a colSpan={3} group header,
                and the data rows below show only the (still color-coded)
                numbers. rowSpan={2} on Name/Standard/Actions keeps them
                from being pushed down by the second header row. */}
            <tr>
              <SortableHeader field="name" sortField={sortField} sortDir={sortDir} onSort={toggleSort} rowSpan={2}>
                {t('projects.name')}
              </SortableHeader>
              <SortableHeader field="standard" sortField={sortField} sortDir={sortDir} onSort={toggleSort} rowSpan={2}>
                {t('projects.standard')}
              </SortableHeader>
              <th colSpan={3} className={styles.groupHeader}>{t('projects.proposalStatus')}</th>
              <th colSpan={3} className={styles.groupHeader}>{t('projects.ruleStatus')}</th>
              <th rowSpan={2}>{t('projects.actions')}</th>
            </tr>
            <tr>
              {/* Order matches StatusCountsSummary's own field order
                  (validated/pending/refused, verified/draft/to_do) -- the
                  data cells below are rendered by that same component, so
                  these two orders must never drift apart. `title` on each
                  (docs request) since the same letter means something
                  different per group -- "V" is Validated here but Verified
                  three columns over. */}
              <th scope="col" className={styles.subHeader} title={t('records.validationOptions.Validated')}>V</th>
              <th scope="col" className={styles.subHeader} title={t('records.validationOptions.Pending')}>P</th>
              <th scope="col" className={styles.subHeader} title={t('records.validationOptions.Refused')}>R</th>
              <th scope="col" className={styles.subHeader} title={t('records.rule.states.verified')}>V</th>
              <th scope="col" className={styles.subHeader} title={t('records.rule.states.draft')}>D</th>
              <th scope="col" className={styles.subHeader} title={t('records.rule.states.todo')}>T</th>
            </tr>
          </thead>
          <tbody>
            {sortedProjects.map((p) => (
              <tr key={p.id}>
                <td className={styles.projectName}>
                  {renamingId === p.id ? (
                    <RenameProjectForm
                      project={p}
                      onRenamed={() => {
                        setRenamingId(null);
                        refreshProjects();
                      }}
                      onCancel={() => setRenamingId(null)}
                    />
                  ) : (
                    p.name
                  )}
                </td>
                <td>
                  <span className={styles.badge}>{p.standard}</span>
                </td>
                <ProposalStatusSummary counts={p.proposal_status_counts} variant="numbersOnly" />
                <RuleStatusSummary counts={p.rule_status_counts} variant="numbersOnly" />
                <td>
                  <div className={styles.actions}>
                    <button className={styles.navAction} onClick={() => navigate(`/projects/${p.id}/config`)}>{t('nav.config')}</button>
                    <button className={styles.navAction} onClick={() => navigate(`/projects/${p.id}/records`)}>{t('nav.records')}</button>
                    <button className={styles.navAction} onClick={() => navigate(`/projects/${p.id}/generate`)}>{t('nav.generate')}</button>
                    <button className={styles.navAction} onClick={() => navigate(`/projects/${p.id}/brexdoc`)}>{t('nav.brexdoc')}</button>
                    {p.effective_role === 'editor' && renamingId !== p.id && (
                      <button onClick={() => setRenamingId(p.id)}>{t('projects.rename.button')}</button>
                    )}
                    {isAdmin && (
                      <button onClick={() => setDuplicatingProject(p)} data-testid={`duplicate-project-${p.id}`}>
                        {t('projects.duplicate.button')}
                      </button>
                    )}
                    {isAdmin && (
                      <button className={styles.dangerLink} onClick={() => setDeletingProject(p)}>
                        {t('projects.delete.button')}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {duplicatingProject && (
        <DuplicateProjectModal
          project={duplicatingProject}
          onDuplicated={(copy) => {
            setDuplicated({ source: duplicatingProject.name, copy });
            setDuplicatingProject(null);
            refreshProjects();
          }}
          onCancel={() => setDuplicatingProject(null)}
        />
      )}

      {deletingProject && (
        <DeleteProjectModal
          project={deletingProject}
          onDeleted={() => {
            setDeletingProject(null);
            refreshProjects();
          }}
          onCancel={() => setDeletingProject(null)}
        />
      )}
    </div>
  );
}
