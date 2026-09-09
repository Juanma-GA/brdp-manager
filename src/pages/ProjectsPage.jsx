import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useProjectContext } from '../context/ProjectContext';
import LanguageSwitcher from '../components/LanguageSwitcher';
import styles from './ProjectsPage.module.css';

export default function ProjectsPage() {
  const { t } = useTranslation();
  const { projects, isLoading, error } = useProjectContext();
  const navigate = useNavigate();

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>{t('projects.title')}</h1>
          <p className={styles.subtitle}>{t('projects.subtitle')}</p>
        </div>
        <LanguageSwitcher />
      </div>

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
                <td className={styles.projectName}>{p.name}</td>
                <td>
                  <span className={styles.badge}>{p.standard}</span>
                </td>
                <td>
                  <div className={styles.actions}>
                    <button onClick={() => navigate(`/projects/${p.id}/config`)}>{t('nav.config')}</button>
                    <button onClick={() => navigate(`/projects/${p.id}/records`)}>{t('nav.records')}</button>
                    <button onClick={() => navigate(`/projects/${p.id}/generate`)}>{t('nav.generate')}</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
