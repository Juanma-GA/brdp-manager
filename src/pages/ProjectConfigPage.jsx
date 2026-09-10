import { useEffect, useState } from 'react';
import { useOutletContext, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { authFetchJson } from '../services/apiClient';
import styles from './ProjectConfigPage.module.css';

const FIELDS = [
  { key: 'modelIdentCode', labelKey: 'modelIdentCode', hintKey: 'modelIdentCodeHint' },
  { key: 'systemDiffCode', labelKey: 'systemDiffCode' },
  { key: 'issueNumber', labelKey: 'issueNumber' },
  { key: 'languageIsoCode', labelKey: 'languageIsoCode' },
  { key: 'countryIsoCode', labelKey: 'countryIsoCode' },
  { key: 'securityClassification', labelKey: 'securityClassification' },
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
  // what this renders. project.effective_role is computed server-side
  // (admin already resolved to 'editor' there, docs/v2 §4.3), so this
  // never needs its own admin special case.
  const canEdit = project.effective_role === 'editor';

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
                {t(`config.fields.${f.labelKey}`)}
              </label>
              <input
                id={`cfg-${f.key}`}
                className={styles.input}
                value={values[f.key] || ''}
                onChange={(e) => handleChange(f.key, e.target.value)}
                disabled={!canEdit}
              />
              {f.hintKey && <span className={styles.hint}>{t(`config.fields.${f.hintKey}`)}</span>}
            </div>
          ))}
        </div>
        {canEdit && (
          <button type="submit" className={styles.saveBtn} disabled={isSaving}>
            {isSaving ? '…' : t('config.save')}
          </button>
        )}
        {saved && <span className={styles.savedIndicator}>{t('config.saved')}</span>}
        {!canEdit && <p className={styles.readOnlyNote}>{t('config.readOnly')}</p>}
      </form>
    </div>
  );
}
