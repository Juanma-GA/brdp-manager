import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuthContext } from '../context/AuthContext';
import { useProjectContext } from '../context/ProjectContext';
import { authFetchJson } from '../services/apiClient';
import styles from './ProjectsPage.module.css';

// The 7 exact standards the project can be created with (fixed forever
// once created, docs/v2 §2) -- "BREX — S1000D 5.0"/"6.0" are listed but
// disabled: no generation engine exists for them yet, same criterion
// CLAUDE.md already documents for v1 ("Lo que NO está implementado
// todavía"), not being built in this round either.
const STANDARD_OPTIONS = [
  { value: 'BREX — S1000D 3.0.1', comingSoon: false },
  { value: 'BREX — S1000D 4.1', comingSoon: false },
  { value: 'BREX — S1000D 4.2', comingSoon: false },
  { value: 'BREX — S1000D 5.0', comingSoon: true },
  { value: 'BREX — S1000D 6.0', comingSoon: true },
  { value: 'Schematron 1.0 — S1000D', comingSoon: false },
  { value: 'Schematron 1.0 — DITA', comingSoon: false },
];

function CreateProjectForm({ onCreated, onCancel }) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [standard, setStandard] = useState(STANDARD_OPTIONS[0].value);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState(null);
  const [nameError, setNameError] = useState(false);

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
        body: JSON.stringify({ name, standard }),
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
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    authFetchJson(`/api/projects/${project.id}/brdps`)
      .then((data) => setBrdpCount(data.length))
      .catch(() => setBrdpCount(0));
  }, [project.id]);

  const nameMatches = confirmText === project.name;

  const handleDelete = async () => {
    if (!nameMatches) return;
    setDeleting(true);
    setError(null);
    try {
      await authFetchJson(`/api/projects/${project.id}`, { method: 'DELETE' });
      onDeleted();
    } catch (err) {
      setError(err.message);
      setDeleting(false);
    }
  };

  return (
    <div className={styles.modalOverlay} onClick={onCancel}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <h3 className={styles.formTitle}>{t('projects.delete.title')}</h3>
        <p className={styles.projectName}>{project.name}</p>
        {error && <p className={styles.error}>{error}</p>}
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
            disabled={!nameMatches || deleting}
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

export default function ProjectsPage() {
  const { t } = useTranslation();
  const { user } = useAuthContext();
  const { projects, isLoading, error, refreshProjects } = useProjectContext();
  const navigate = useNavigate();
  const isAdmin = user?.global_role === 'admin';

  const [showCreate, setShowCreate] = useState(false);
  const [renamingId, setRenamingId] = useState(null);
  const [deletingProject, setDeletingProject] = useState(null);

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

      {isLoading && <p>…</p>}
      {error && <p className={styles.error}>{error}</p>}

      {!isLoading && !error && projects.length === 0 && <div className={styles.empty}>{t('projects.empty')}</div>}

      {!isLoading && projects.length > 0 && (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>{t('projects.name')}</th>
              <th>{t('projects.standard')}</th>
              <th>{t('projects.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((p) => (
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
                <td>
                  <div className={styles.actions}>
                    <button onClick={() => navigate(`/projects/${p.id}/config`)}>{t('nav.config')}</button>
                    <button onClick={() => navigate(`/projects/${p.id}/records`)}>{t('nav.records')}</button>
                    <button onClick={() => navigate(`/projects/${p.id}/generate`)}>{t('nav.generate')}</button>
                    {p.effective_role === 'editor' && renamingId !== p.id && (
                      <button onClick={() => setRenamingId(p.id)}>{t('projects.rename.button')}</button>
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
