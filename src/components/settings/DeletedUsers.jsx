import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDeletedUsers, usePermanentlyDeleteUser, useRestoreUser } from '../../hooks/useTrash';
import { errorMessage } from '../../services/apiErrors';
import ErrorNotice from '../ErrorNotice';
import styles from '../../pages/SettingsPage.module.css';
import { roleLabel } from '../../utils/roles';

/**
 * Settings > Users > Deleted users (AACF 2, Decisión 13; admin only). A
 * deleted user cannot sign in; Restore brings them back with the project
 * roles they still have (onRestored refreshes the active list), Delete
 * permanently asks for an explicit confirmation. Both optimistic (HR20).
 */
export default function DeletedUsers({ onRestored }) {
  const { t } = useTranslation();
  const { data, isLoading, error: loadError, refetch } = useDeletedUsers();
  const restoreMutation = useRestoreUser();
  const deleteMutation = usePermanentlyDeleteUser();
  const [error, setError] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);

  const restore = async (u) => {
    setError(null);
    try {
      await restoreMutation.mutateAsync(u.id);
      onRestored?.();
    } catch (err) {
      setError(t('settings.userManagement.actionFailed', { reason: errorMessage(err, t) }));
    }
  };

  const confirmDelete = async () => {
    const u = pendingDelete;
    setPendingDelete(null);
    setError(null);
    try {
      await deleteMutation.mutateAsync(u.id);
    } catch (err) {
      setError(t('settings.userManagement.actionFailed', { reason: errorMessage(err, t) }));
    }
  };

  return (
    <div data-testid="deleted-users" style={{ marginTop: 20 }}>
      <h3 className={styles.sectionTitle}>{t('settings.userManagement.deleted.title')}</h3>
      <p className={styles.fieldDescription}>{t('settings.userManagement.deleted.description')}</p>
      {error && <ErrorNotice testId="deleted-users-error" message={error} onDismiss={() => setError(null)} />}
      {loadError && (
        <ErrorNotice
          testId="deleted-users-load-error"
          message={t('settings.userManagement.deleted.loadFailed', { reason: errorMessage(loadError, t) })}
          onRetry={() => refetch()}
        />
      )}
      {isLoading && <p>…</p>}
      {data && data.length === 0 && <p className={styles.fieldDescription}>{t('settings.userManagement.deleted.empty')}</p>}
      {data && data.length > 0 && (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>{t('settings.userManagement.deleted.table.email')}</th>
              <th>{t('settings.userManagement.deleted.table.name')}</th>
              <th>{t('settings.userManagement.deleted.table.globalRole')}</th>
              <th>{t('settings.userManagement.deleted.table.deletedBy')}</th>
              <th>{t('settings.userManagement.deleted.table.deletedAt')}</th>
              <th>{t('settings.userManagement.deleted.table.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {data.map((u) => (
              <tr key={u.id} data-testid="deleted-user-row">
                <td>{u.email}</td>
                <td>{u.display_name}</td>
                <td>{roleLabel(t, u.global_role)}</td>
                <td>{u.deleted_by_email || t('settings.trash.unknownUser')}</td>
                <td>{new Date(u.deleted_at).toLocaleString()}</td>
                <td>
                  <div className={styles.actionsCell}>
                    <button type="button" onClick={() => restore(u)} disabled={restoreMutation.isPending} data-testid="deleted-user-restore">
                      {t('settings.userManagement.deleted.restore')}
                    </button>
                    <button type="button" className={styles.dangerLink} onClick={() => setPendingDelete(u)} data-testid="deleted-user-delete">
                      {t('settings.userManagement.deleted.deletePermanently')}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {pendingDelete && (
        <div className={styles.modalOverlay} onClick={() => setPendingDelete(null)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <h3 className={styles.sectionTitle}>{t('settings.userManagement.deleted.confirmTitle')}</h3>
            <p className={styles.dangerText}>{t('settings.userManagement.deleted.confirmWarning', { email: pendingDelete.email })}</p>
            <p className={styles.dangerText}>{t('settings.userManagement.deleted.confirmIrreversible')}</p>
            <div className={styles.buttonGroup}>
              <button type="button" className={styles.dangerButton} onClick={confirmDelete} data-testid="deleted-user-confirm-delete">
                {t('settings.userManagement.deleted.confirmButton')}
              </button>
              <button type="button" onClick={() => setPendingDelete(null)}>
                {t('settings.userManagement.deleted.cancel')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
