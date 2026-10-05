import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useProjectContext } from '../../context/ProjectContext';
import { usePermanentlyDeleteProject, useRestoreProject, useTrashedProjects } from '../../hooks/useTrash';
import { errorMessage } from '../../services/apiErrors';
import ErrorNotice from '../ErrorNotice';
import styles from '../../pages/SettingsPage.module.css';

/**
 * Settings > Papelera > Projects (AACF 2, Decisión 13; admin only). A
 * deleted project with name, standard, BRDP count, who deleted it and when.
 * Restore brings it back as it was; when an active project now has its
 * name, the server refuses (project_name_taken) and the row offers to
 * restore it under another name. Delete permanently asks to type the
 * name, as deleting a project always did. Both optimistic (HR20): the row
 * leaves at once and comes back with the reason if the server refuses.
 */
export default function ProjectTrash() {
  const { t } = useTranslation();
  const { refreshProjects } = useProjectContext();
  const { data, isLoading, error: loadError, refetch } = useTrashedProjects();
  const restoreMutation = useRestoreProject();
  const deleteMutation = usePermanentlyDeleteProject();
  const [error, setError] = useState(null);
  // { id, name: taken name, draft } while a restore waits for another name.
  const [renaming, setRenaming] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [confirmText, setConfirmText] = useState('');

  const restore = async (project, name) => {
    setError(null);
    try {
      await restoreMutation.mutateAsync({ projectId: project.id, name });
      setRenaming(null);
      refreshProjects();
    } catch (err) {
      if (err?.code === 'project_name_taken') {
        setRenaming({ id: project.id, name: err.detail?.name || project.name, draft: name || `${project.name} (2)` });
      } else {
        setError(t('settings.trash.projects.restoreFailed', { name: project.name, reason: errorMessage(err, t) }));
      }
    }
  };

  const confirmDelete = async () => {
    const project = pendingDelete;
    setPendingDelete(null);
    setConfirmText('');
    setError(null);
    try {
      await deleteMutation.mutateAsync(project.id);
    } catch (err) {
      setError(t('settings.trash.projects.deleteFailed', { name: project.name, reason: errorMessage(err, t) }));
    }
  };

  return (
    <div data-testid="trash-projects">
      <h3 className={styles.sectionTitle}>{t('settings.trash.projects.title')}</h3>
      <p className={styles.fieldDescription}>{t('settings.trash.projects.description')}</p>
      {error && <ErrorNotice testId="trash-projects-error" message={error} onDismiss={() => setError(null)} />}
      {loadError && (
        <ErrorNotice
          testId="trash-projects-load-error"
          message={t('settings.trash.projects.loadFailed', { reason: errorMessage(loadError, t) })}
          onRetry={() => refetch()}
        />
      )}
      {isLoading && <p>…</p>}
      {data && data.length === 0 && <p className={styles.fieldDescription}>{t('settings.trash.projects.empty')}</p>}
      {data && data.length > 0 && (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>{t('settings.trash.projects.table.name')}</th>
              <th>{t('settings.trash.projects.table.standard')}</th>
              <th>{t('settings.trash.projects.table.brdps')}</th>
              <th>{t('settings.trash.projects.table.deletedBy')}</th>
              <th>{t('settings.trash.projects.table.deletedAt')}</th>
              <th>{t('settings.trash.projects.table.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {data.map((project) => (
              <tr key={project.id} data-testid="trash-project-row">
                <td>{project.name}</td>
                <td>{project.standard}</td>
                <td>{project.brdp_count}</td>
                <td>{project.deleted_by_email || t('settings.trash.unknownUser')}</td>
                <td>{new Date(project.deleted_at).toLocaleString()}</td>
                <td>
                  <div className={styles.actionsCell}>
                    <button type="button" onClick={() => restore(project)} disabled={restoreMutation.isPending} data-testid="trash-project-restore">
                      {t('settings.trash.projects.restore')}
                    </button>
                    <button
                      type="button"
                      className={styles.dangerLink}
                      onClick={() => {
                        setConfirmText('');
                        setPendingDelete(project);
                      }}
                      data-testid="trash-project-delete"
                    >
                      {t('settings.trash.projects.deletePermanently')}
                    </button>
                  </div>
                  {renaming?.id === project.id && (
                    <div data-testid="trash-project-rename" role="group">
                      <p className={styles.statusInvalid}>{t('settings.trash.projects.nameTaken', { name: renaming.name })}</p>
                      <label className={styles.label}>
                        {t('settings.trash.projects.newNameLabel')}
                        <input
                          className={styles.input}
                          value={renaming.draft}
                          onChange={(e) => setRenaming((r) => ({ ...r, draft: e.target.value }))}
                          data-testid="trash-project-new-name"
                        />
                      </label>
                      <button
                        type="button"
                        onClick={() => restore(project, renaming.draft.trim())}
                        disabled={!renaming.draft.trim() || restoreMutation.isPending}
                        data-testid="trash-project-restore-renamed"
                      >
                        {t('settings.trash.projects.restoreWithName')}
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {pendingDelete && (
        <div className={styles.modalOverlay} onClick={() => setPendingDelete(null)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <h3 className={styles.sectionTitle}>{t('settings.trash.projects.confirmTitle')}</h3>
            <p>{pendingDelete.name}</p>
            <p className={styles.dangerText}>{t('settings.trash.projects.confirmWarning', { count: pendingDelete.brdp_count })}</p>
            <p className={styles.dangerText}>{t('settings.trash.projects.confirmIrreversible')}</p>
            <label className={styles.label}>
              {t('settings.trash.projects.confirmLabel', { name: pendingDelete.name })}
              <input
                className={styles.input}
                value={confirmText}
                placeholder={t('settings.trash.projects.confirmPlaceholder')}
                onChange={(e) => setConfirmText(e.target.value)}
              />
            </label>
            {confirmText.length > 0 && confirmText !== pendingDelete.name && (
              <p className={styles.fieldError}>{t('settings.trash.projects.mismatch')}</p>
            )}
            <div className={styles.buttonGroup}>
              <button
                type="button"
                className={styles.dangerButton}
                onClick={confirmDelete}
                disabled={confirmText !== pendingDelete.name || deleteMutation.isPending}
              >
                {deleteMutation.isPending ? t('settings.trash.projects.deleting') : t('settings.trash.projects.confirmButton')}
              </button>
              <button type="button" onClick={() => setPendingDelete(null)}>
                {t('settings.trash.projects.cancel')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
