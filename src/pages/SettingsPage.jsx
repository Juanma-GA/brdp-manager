import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuthContext } from '../context/AuthContext';
import { useProjectContext } from '../context/ProjectContext';
import { authFetchJson } from '../services/apiClient';
import styles from './SettingsPage.module.css';

function ProfileSection({ user }) {
  return (
    <div className={styles.section}>
      <h3 className={styles.sectionTitle}>Profile</h3>
      <div className={styles.formGroup}>
        <label className={styles.label}>Email</label>
        <input className={styles.input} value={user.email} disabled />
      </div>
      <div className={styles.formGroup}>
        <label className={styles.label}>Display name</label>
        <input className={styles.input} value={user.display_name} disabled />
      </div>
      <div className={styles.formGroup}>
        <label className={styles.label}>Global role</label>
        <input className={styles.input} value={user.global_role} disabled />
      </div>
    </div>
  );
}

function AIConfigSection() {
  const [aiProvider, setAiProvider] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    authFetchJson('/api/config/ai-provider')
      .then(setAiProvider)
      .catch((err) => setError(err.message));
  }, []);

  return (
    <div className={styles.section}>
      <h3 className={styles.sectionTitle}>AI Configuration</h3>
      <p className={styles.fieldDescription}>
        The active AI provider is a server-side decision (.env) -- it cannot be changed from here.
      </p>
      {error && <p className={styles.statusInvalid}>{error}</p>}
      {aiProvider && (
        <>
          <div className={styles.formGroup}>
            <label className={styles.label}>Provider</label>
            <input className={styles.input} value={aiProvider.provider} disabled />
          </div>
          <div className={styles.formGroup}>
            <label className={styles.label}>Model</label>
            <input className={styles.input} value={aiProvider.model} disabled />
          </div>
        </>
      )}
    </div>
  );
}

function UserManagementSection() {
  const { projects } = useProjectContext();
  const [users, setUsers] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  const [newUser, setNewUser] = useState({ email: '', password: '', display_name: '', global_role: 'user' });
  const [creating, setCreating] = useState(false);

  const [roleDraft, setRoleDraft] = useState({}); // userId -> { project_id, role }

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

  const projectName = (id) => projects.find((p) => p.id === id)?.name || id;

  return (
    <div className={styles.section}>
      <h3 className={styles.sectionTitle}>User Management</h3>
      {error && <p className={styles.statusInvalid}>{error}</p>}

      <form className={styles.formRow} onSubmit={handleCreate} style={{ marginBottom: 12, flexWrap: 'wrap' }}>
        <div className={styles.formGroup}>
          <label className={styles.label}>Email</label>
          <input
            className={styles.input}
            type="email"
            required
            value={newUser.email}
            onChange={(e) => setNewUser((u) => ({ ...u, email: e.target.value }))}
          />
        </div>
        <div className={styles.formGroup}>
          <label className={styles.label}>Password</label>
          <input
            className={styles.input}
            type="password"
            required
            value={newUser.password}
            onChange={(e) => setNewUser((u) => ({ ...u, password: e.target.value }))}
          />
        </div>
        <div className={styles.formGroup}>
          <label className={styles.label}>Display name</label>
          <input
            className={styles.input}
            required
            value={newUser.display_name}
            onChange={(e) => setNewUser((u) => ({ ...u, display_name: e.target.value }))}
          />
        </div>
        <div className={styles.formGroup}>
          <label className={styles.label}>Global role</label>
          <select
            className={styles.select}
            value={newUser.global_role}
            onChange={(e) => setNewUser((u) => ({ ...u, global_role: e.target.value }))}
          >
            <option value="user">user</option>
            <option value="admin">admin</option>
          </select>
        </div>
        <button className={styles.button} type="submit" disabled={creating}>
          {creating ? '…' : 'Create user'}
        </button>
      </form>

      {isLoading ? (
        <p>…</p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Email</th>
              <th>Name</th>
              <th>Global role</th>
              <th>Project roles</th>
              <th>Assign</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.email}</td>
                <td>{u.display_name}</td>
                <td>{u.global_role}</td>
                <td>
                  {u.project_roles.length === 0 ? (
                    <span className={styles.fieldDescription}>—</span>
                  ) : (
                    u.project_roles.map((r) => (
                      <div key={r.project_id} className={styles.roleTag}>
                        {projectName(r.project_id)}: {r.role}{' '}
                        <button type="button" onClick={() => handleRemoveRole(u.id, r.project_id)} aria-label="Remove">
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
                    <option value="">Project…</option>
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
                    <option value="">Role…</option>
                    <option value="viewer">viewer</option>
                    <option value="editor">editor</option>
                  </select>
                  <button type="button" className={styles.button} onClick={() => handleAssignRole(u.id)}>
                    Assign
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function SettingsPage() {
  const { t } = useTranslation();
  const { user } = useAuthContext();

  if (!user) return null;

  return (
    <div className={styles.container}>
      <h2 className={styles.title}>{t('nav.settings')}</h2>
      <div className={styles.sectionsContainer}>
        <ProfileSection user={user} />
        <AIConfigSection />
        {user.global_role === 'admin' && <UserManagementSection />}
      </div>
    </div>
  );
}
