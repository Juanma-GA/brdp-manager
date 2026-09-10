import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuthContext } from '../context/AuthContext';
import { useProjectContext } from '../context/ProjectContext';
import { authFetchJson } from '../services/apiClient';
import styles from './SettingsPage.module.css';

function ProfileSection({ user }) {
  const { t } = useTranslation();
  return (
    <div className={styles.section}>
      <h3 className={styles.sectionTitle}>{t('settings.profile.title')}</h3>
      <div className={styles.formGroup}>
        <label className={styles.label}>{t('settings.profile.email')}</label>
        <input className={styles.input} value={user.email} disabled />
      </div>
      <div className={styles.formGroup}>
        <label className={styles.label}>{t('settings.profile.displayName')}</label>
        <input className={styles.input} value={user.display_name} disabled />
      </div>
      <div className={styles.formGroup}>
        <label className={styles.label}>{t('settings.profile.globalRole')}</label>
        <input className={styles.input} value={user.global_role} disabled />
      </div>
    </div>
  );
}

function AIConfigSection() {
  const { t } = useTranslation();
  const [aiProvider, setAiProvider] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    authFetchJson('/api/config/ai-provider')
      .then(setAiProvider)
      .catch((err) => setError(err.message));
  }, []);

  return (
    <div className={styles.section}>
      <h3 className={styles.sectionTitle}>{t('settings.aiConfig.title')}</h3>
      <p className={styles.fieldDescription}>{t('settings.aiConfig.description')}</p>
      {error && <p className={styles.statusInvalid}>{error}</p>}
      {aiProvider && (
        <>
          <div className={styles.formGroup}>
            <label className={styles.label}>{t('settings.aiConfig.provider')}</label>
            <input className={styles.input} value={aiProvider.provider} disabled />
          </div>
          <div className={styles.formGroup}>
            <label className={styles.label}>{t('settings.aiConfig.model')}</label>
            <input className={styles.input} value={aiProvider.model} disabled />
          </div>
        </>
      )}
    </div>
  );
}

function UserManagementSection() {
  const { t } = useTranslation();
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
      <h3 className={styles.sectionTitle}>{t('settings.userManagement.title')}</h3>
      {error && <p className={styles.statusInvalid}>{error}</p>}

      <form className={styles.formRow} onSubmit={handleCreate} style={{ marginBottom: 12, flexWrap: 'wrap' }}>
        <div className={styles.formGroup}>
          <label className={styles.label}>{t('settings.userManagement.email')}</label>
          <input
            className={styles.input}
            type="email"
            required
            value={newUser.email}
            onChange={(e) => setNewUser((u) => ({ ...u, email: e.target.value }))}
          />
        </div>
        <div className={styles.formGroup}>
          <label className={styles.label}>{t('settings.userManagement.password')}</label>
          <input
            className={styles.input}
            type="password"
            required
            value={newUser.password}
            onChange={(e) => setNewUser((u) => ({ ...u, password: e.target.value }))}
          />
        </div>
        <div className={styles.formGroup}>
          <label className={styles.label}>{t('settings.userManagement.displayName')}</label>
          <input
            className={styles.input}
            required
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
        <button className={styles.button} type="submit" disabled={creating}>
          {creating ? t('settings.userManagement.creating') : t('settings.userManagement.createUser')}
        </button>
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
