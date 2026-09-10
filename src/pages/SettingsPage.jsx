import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuthContext } from '../context/AuthContext';
import { useProjectContext } from '../context/ProjectContext';
import { authFetchJson } from '../services/apiClient';
import Button from '../components/Button';
import styles from './SettingsPage.module.css';

function ProfileSection({ user, onUserUpdated }) {
  const { t } = useTranslation();
  const [displayName, setDisplayName] = useState(user.display_name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    setDisplayName(user.display_name);
  }, [user.display_name]);

  const handleSave = async (e) => {
    e.preventDefault();
    setError(null);
    // Not the native `required` attribute -- its browser tooltip follows
    // the browser/OS locale, not this app's language selector (confirmed
    // bug, see LoginPage.jsx for the reproduction).
    if (!displayName.trim()) {
      setError(t('validation.required'));
      return;
    }
    setSaving(true);
    try {
      const updated = await authFetchJson('/api/auth/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_name: displayName }),
      });
      // Same success pattern as User Management's Create user: no separate
      // "Saved" message -- the field simply reflects the now-current value
      // (onUserUpdated feeds the fresh User back down from AuthContext,
      // exactly like Create user's table refresh shows the new row).
      onUserUpdated(updated);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.section}>
      <h3 className={styles.sectionTitle}>{t('settings.profile.title')}</h3>
      <div className={styles.formGroup}>
        <label className={styles.label}>{t('settings.profile.email')}</label>
        <input className={styles.input} value={user.email} disabled />
      </div>
      <form onSubmit={handleSave}>
        <div className={styles.formGroup}>
          <label className={styles.label}>{t('settings.profile.displayName')}</label>
          <input
            className={styles.input}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </div>
        <div className={styles.formGroup}>
          <label className={styles.label}>{t('settings.profile.globalRole')}</label>
          <input className={styles.input} value={user.global_role} disabled />
        </div>
        {error && <p className={styles.statusInvalid}>{error}</p>}
        {/* Disabled only while the request is in flight -- same rule as
            Create user's disabled={creating}. Previously also disabled
            whenever displayName === user.display_name, which meant the
            button stayed disabled right after a successful save (the
            local value and the freshly-saved user.display_name are equal
            at that point), a real bug, not cosmetic: it looked broken
            until the next edit. */}
        <Button type="submit" disabled={saving}>
          {saving ? t('settings.profile.saving') : t('settings.profile.save')}
        </Button>
      </form>
    </div>
  );
}

function UserManagementSection({ currentUserId }) {
  const { t } = useTranslation();
  const { projects } = useProjectContext();
  const [users, setUsers] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  const [newUser, setNewUser] = useState({ email: '', password: '', display_name: '', global_role: 'user' });
  const [creating, setCreating] = useState(false);

  const [roleDraft, setRoleDraft] = useState({}); // userId -> { project_id, role }

  const [editingUserId, setEditingUserId] = useState(null);
  const [editDraft, setEditDraft] = useState({ email: '', display_name: '' });
  const [savingEdit, setSavingEdit] = useState(false);

  const adminCount = users.filter((u) => u.global_role === 'admin').length;

  const refresh = () =>
    authFetchJson('/api/users')
      .then((data) => {
        setUsers(data);
        setIsLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setIsLoading(false);
      });

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCreate = async (e) => {
    e.preventDefault();
    setError(null);
    // Not the native `required` attribute -- its browser tooltip follows
    // the browser/OS locale, not this app's language selector (confirmed
    // bug, see LoginPage.jsx for the reproduction).
    if (!newUser.email.trim() || !newUser.password.trim() || !newUser.display_name.trim()) {
      setError(t('validation.required'));
      return;
    }
    setCreating(true);
    try {
      await authFetchJson('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newUser),
      });
      setNewUser({ email: '', password: '', display_name: '', global_role: 'user' });
      refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  const handleAssignRole = async (userId) => {
    const draft = roleDraft[userId];
    if (!draft?.project_id || !draft?.role) return;
    await authFetchJson(`/api/users/${userId}/project-roles`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: draft.project_id, role: draft.role }),
    });
    refresh();
  };

  const handleRemoveRole = async (userId, projectId) => {
    await authFetchJson(`/api/users/${userId}/project-roles/${projectId}`, { method: 'DELETE' });
    refresh();
  };

  const startEdit = (u) => {
    setEditingUserId(u.id);
    setEditDraft({ email: u.email, display_name: u.display_name });
    setError(null);
  };

  const cancelEdit = () => {
    setEditingUserId(null);
  };

  const handleSaveEdit = async (userId) => {
    setError(null);
    // Not the native `required` attribute -- its browser tooltip follows
    // the browser/OS locale, not this app's language selector (confirmed
    // bug, see LoginPage.jsx for the reproduction).
    if (!editDraft.email.trim() || !editDraft.display_name.trim()) {
      setError(t('validation.required'));
      return;
    }
    setSavingEdit(true);
    try {
      await authFetchJson(`/api/users/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editDraft),
      });
      setEditingUserId(null);
      refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingEdit(false);
    }
  };

  const handleDelete = async (u) => {
    if (!window.confirm(t('settings.userManagement.deleteConfirm', { name: u.display_name }))) return;
    try {
      await authFetchJson(`/api/users/${u.id}`, { method: 'DELETE' });
      refresh();
    } catch (err) {
      setError(err.message);
    }
  };

  const projectName = (id) => projects.find((p) => p.id === id)?.name || id;

  return (
    <div className={styles.section}>
      <h3 className={styles.sectionTitle}>{t('settings.userManagement.title')}</h3>
      {error && <p className={styles.statusInvalid}>{error}</p>}

      <form className={styles.formRow} onSubmit={handleCreate} style={{ marginBottom: 12, flexWrap: 'wrap' }}>
        <div className={styles.formGroup}>
          <label className={styles.label}>{t('settings.userManagement.email')}</label>
          <input
            className={styles.input}
            type="email"
            value={newUser.email}
            onChange={(e) => setNewUser((u) => ({ ...u, email: e.target.value }))}
          />
        </div>
        <div className={styles.formGroup}>
          <label className={styles.label}>{t('settings.userManagement.password')}</label>
          <input
            className={styles.input}
            type="password"
            value={newUser.password}
            onChange={(e) => setNewUser((u) => ({ ...u, password: e.target.value }))}
          />
        </div>
        <div className={styles.formGroup}>
          <label className={styles.label}>{t('settings.userManagement.displayName')}</label>
          <input
            className={styles.input}
            value={newUser.display_name}
            onChange={(e) => setNewUser((u) => ({ ...u, display_name: e.target.value }))}
          />
        </div>
        <div className={styles.formGroup}>
          <label className={styles.label}>{t('settings.userManagement.globalRole')}</label>
          <select
            className={styles.select}
            value={newUser.global_role}
            onChange={(e) => setNewUser((u) => ({ ...u, global_role: e.target.value }))}
          >
            <option value="user">user</option>
            <option value="admin">admin</option>
          </select>
        </div>
        <Button type="submit" disabled={creating}>
          {creating ? t('settings.userManagement.creating') : t('settings.userManagement.createUser')}
        </Button>
      </form>

      {isLoading ? (
        <p>…</p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>{t('settings.userManagement.table.email')}</th>
              <th>{t('settings.userManagement.table.name')}</th>
              <th>{t('settings.userManagement.table.globalRole')}</th>
              <th>{t('settings.userManagement.table.projectRoles')}</th>
              <th>{t('settings.userManagement.table.assign')}</th>
              <th>{t('settings.userManagement.table.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const isEditing = editingUserId === u.id;
              const isSelf = u.id === currentUserId;
              const isLastAdmin = u.global_role === 'admin' && adminCount <= 1;
              return (
              <tr key={u.id}>
                <td>
                  {isEditing ? (
                    <input
                      className={styles.input}
                      type="email"
                      value={editDraft.email}
                      onChange={(e) => setEditDraft((d) => ({ ...d, email: e.target.value }))}
                    />
                  ) : (
                    u.email
                  )}
                </td>
                <td>
                  {isEditing ? (
                    <input
                      className={styles.input}
                      value={editDraft.display_name}
                      onChange={(e) => setEditDraft((d) => ({ ...d, display_name: e.target.value }))}
                    />
                  ) : (
                    u.display_name
                  )}
                </td>
                <td>{u.global_role}</td>
                <td>
                  {u.project_roles.length === 0 ? (
                    <span className={styles.fieldDescription}>—</span>
                  ) : (
                    u.project_roles.map((r) => (
                      <div key={r.project_id} className={styles.roleTag}>
                        {projectName(r.project_id)}: {r.role}{' '}
                        <button
                          type="button"
                          onClick={() => handleRemoveRole(u.id, r.project_id)}
                          aria-label={t('settings.userManagement.removeAria')}
                        >
                          ✕
                        </button>
                      </div>
                    ))
                  )}
                </td>
                <td>
                  <select
                    className={styles.select}
                    value={roleDraft[u.id]?.project_id || ''}
                    onChange={(e) =>
                      setRoleDraft((d) => ({ ...d, [u.id]: { ...d[u.id], project_id: e.target.value } }))
                    }
                  >
                    <option value="">{t('settings.userManagement.projectPlaceholder')}</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <select
                    className={styles.select}
                    value={roleDraft[u.id]?.role || ''}
                    onChange={(e) => setRoleDraft((d) => ({ ...d, [u.id]: { ...d[u.id], role: e.target.value } }))}
                  >
                    <option value="">{t('settings.userManagement.rolePlaceholder')}</option>
                    <option value="viewer">viewer</option>
                    <option value="editor">editor</option>
                  </select>
                  <button type="button" className={styles.button} onClick={() => handleAssignRole(u.id)}>
                    {t('settings.userManagement.assignButton')}
                  </button>
                </td>
                <td>
                  {isEditing ? (
                    <div className={styles.actionsCell}>
                      <button
                        type="button"
                        className={styles.button}
                        onClick={() => handleSaveEdit(u.id)}
                        disabled={savingEdit}
                      >
                        {savingEdit ? t('settings.userManagement.saving') : t('settings.userManagement.save')}
                      </button>
                      <button type="button" onClick={cancelEdit} disabled={savingEdit}>
                        {t('settings.userManagement.cancel')}
                      </button>
                    </div>
                  ) : (
                    <div className={styles.actionsCell}>
                      <button type="button" onClick={() => startEdit(u)}>
                        {t('settings.userManagement.edit')}
                      </button>
                      <button
                        type="button"
                        className={styles.dangerLink}
                        onClick={() => handleDelete(u)}
                        disabled={isSelf || isLastAdmin}
                        title={
                          isSelf
                            ? t('settings.userManagement.deleteDisabledSelf')
                            : isLastAdmin
                            ? t('settings.userManagement.deleteDisabledLastAdmin')
                            : undefined
                        }
                      >
                        {t('settings.userManagement.delete')}
                      </button>
                    </div>
                  )}
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function SettingsPage() {
  const { t } = useTranslation();
  const { user, updateUser } = useAuthContext();

  if (!user) return null;

  return (
    <div className={styles.container}>
      <h2 className={styles.title}>{t('nav.settings')}</h2>
      <div className={styles.sectionsContainer}>
        <ProfileSection user={user} onUserUpdated={updateUser} />
        {user.global_role === 'admin' && <UserManagementSection currentUserId={user.id} />}
      </div>
    </div>
  );
}
