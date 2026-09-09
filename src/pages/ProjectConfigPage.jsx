import { useEffect, useState } from 'react';
import { useOutletContext, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { authFetchJson } from '../services/apiClient';
import styles from './ProjectConfigPage.module.css';

const FIELDS = [
  { key: 'modelIdentCode', label: 'Model Ident Code', hint: 'CAGE code' },
  { key: 'systemDiffCode', label: 'System Diff Code' },
  { key: 'issueNumber', label: 'Issue Number' },
  { key: 'languageIsoCode', label: 'Language ISO Code' },
  { key: 'countryIsoCode', label: 'Country ISO Code' },
  { key: 'securityClassification', label: 'Security Classification' },
];

export default function ProjectConfigPage() {
  const { t } = useTranslation();
  const { projectId } = useParams();
  const { project, refreshProject } = useOutletContext();
  const [values, setValues] = useState(project.project_config || {});
  const [isSaving, setIsSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // canEdit is purely cosmetic (disables the form) -- the backend's
  // require_project_role('editor') on PUT is the real gate regardless of
  // what this renders. project.my_role is computed server-side per
  // request, never trusted from anywhere else.
  const canEdit = project.my_role === 'admin' || project.my_role === 'editor';

  useEffect(() => {
    setValues(project.project_config || {});
  }, [project]);

  const handleChange = (key, value) => {
    setValues((v) => ({ ...v, [key]: value }));
    setSaved(false);
  };

  const handleSave = async (e) => {
    e.preventDefault();
    setIsSaving(true);
    try {
      await authFetchJson(`/api/projects/${projectId}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_config: values }),
      });
      setSaved(true);
      refreshProject();
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>{t('nav.config')}</h1>
      <p className={styles.subtitle}>
        {project.name} · {project.standard}
      </p>

      <form className={styles.card} onSubmit={handleSave}>
        <div className={styles.grid}>
          {FIELDS.map((f) => (
            <div key={f.key} className={styles.field}>
              <label className={styles.label} htmlFor={`cfg-${f.key}`}>
                {f.label}
              </label>
              <input
                id={`cfg-${f.key}`}
                className={styles.input}
                value={values[f.key] || ''}
                onChange={(e) => handleChange(f.key, e.target.value)}
                disabled={!canEdit}
              />
              {f.hint && <span className={styles.hint}>{f.hint}</span>}
            </div>
          ))}
        </div>
        {canEdit && (
          <button type="submit" className={styles.saveBtn} disabled={isSaving}>
            {isSaving ? '…' : 'Save Configuration'}
          </button>
        )}
        {saved && <span className={styles.savedIndicator}>Saved</span>}
        {!canEdit && <p className={styles.readOnlyNote}>Read-only -- your role on this project doesn't allow editing.</p>}
      </form>
    </div>
  );
}
