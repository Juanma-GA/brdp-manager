import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight } from 'lucide-react';
import { useAuthContext } from '../context/AuthContext';
import { useProjectContext } from '../context/ProjectContext';
import { authFetchJson } from '../services/apiClient';
import {
  useBulkPermanentlyDeleteBrdps,
  usePermanentlyDeleteBrdp,
  useRestoreBrdp,
  useTrash,
} from '../hooks/useTrash';
import Button from '../components/Button';
import ChangePasswordForm from '../components/ChangePasswordForm';
import SortableHeader from '../components/SortableHeader';
import TemporaryPasswordModal from '../components/TemporaryPasswordModal';
import styles from './SettingsPage.module.css';

function ProfileSection({ user, onUserUpdated }) {
  const { t } = useTranslation();
  const [displayName, setDisplayName] = useState(user.display_name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  // Separate from `error` (API failures, shown once near the button) --
  // this is the "field is empty" case, which must stay pinned to the
  // exact input, the same way the native `required` tooltip it replaced
  // pointed at that field specifically.
  const [nameError, setNameError] = useState(false);

  useEffect(() => {
    setDisplayName(user.display_name);
  }, [user.display_name]);

  const handleSave = async (e) => {
    e.preventDefault();
    setError(null);
    const isEmpty = !displayName.trim();
    setNameError(isEmpty);
    if (isEmpty) return;
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
    // Collapsed by default, no exception by role (docs request) -- one
    // row inside SettingsPage's single panel (.sectionsContainer), not
    // its own floating card. .sectionBody carries the row's content
    // padding so it only renders (and only costs layout height) while
    // this row is actually open.
    <details className={styles.section}>
      <summary className={styles.accordionSummary}>
        <ChevronRight size={16} className={styles.chevron} aria-hidden="true" />
        {t('settings.profile.title')}
      </summary>
      <div className={styles.sectionBody}>
        <div className={styles.formGroup}>
          <label className={styles.label}>{t('settings.profile.email')}</label>
          <input className={styles.input} value={user.email} disabled />
        </div>
        <form onSubmit={handleSave}>
          <div className={styles.formGroup}>
            <label className={styles.label}>{t('settings.profile.displayName')}</label>
            <input
              className={`${styles.input} ${nameError ? styles.inputError : ''}`}
              value={displayName}
              onChange={(e) => {
                setDisplayName(e.target.value);
                setNameError(false);
              }}
            />
            {nameError && <p className={styles.fieldError}>{t('validation.required')}</p>}
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
        <ChangePasswordForm withDivider />
      </div>
    </details>
  );
}

function UserManagementSection({ currentUserId }) {
  const { t } = useTranslation();
  const { projects } = useProjectContext();
  const [users, setUsers] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  const [newUser, setNewUser] = useState({ email: '', display_name: '', global_role: 'user' });
  const [creating, setCreating] = useState(false);
  const [createErrors, setCreateErrors] = useState({});

  const [roleDraft, setRoleDraft] = useState({}); // userId -> { project_id, role }

  const [editingUserId, setEditingUserId] = useState(null);
  const [editDraft, setEditDraft] = useState({ email: '', display_name: '' });
  const [editErrors, setEditErrors] = useState({});
  const [savingEdit, setSavingEdit] = useState(false);

  const [resettingUserId, setResettingUserId] = useState(null);
  // { email, temporaryPassword } while the modal is open, null otherwise --
  // shared by both Create user and Reset password (docs request: same
  // "shown exactly once" UI for both).
  const [temporaryPasswordInfo, setTemporaryPasswordInfo] = useState(null);

  // Same sortable-header pattern as BRDP Records (docs request), reused
  // via the shared SortableHeader component rather than re-implemented.
  const [sortField, setSortField] = useState(null);
  const [sortDir, setSortDir] = useState('asc');

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
    const errors = {
      email: !newUser.email.trim(),
      display_name: !newUser.display_name.trim(),
    };
    setCreateErrors(errors);
    if (errors.email || errors.display_name) return;
    setCreating(true);
    try {
      // No password in the request body at all -- the backend always
      // generates a real random temporary one (docs request: unified with
      // Reset password below, never a value the admin types in).
      const created = await authFetchJson('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newUser),
      });
      setNewUser({ email: '', display_name: '', global_role: 'user' });
      setCreateErrors({});
      setTemporaryPasswordInfo({ email: created.email, temporaryPassword: created.temporary_password });
      refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  const handleResetPassword = async (u) => {
    if (!window.confirm(t('settings.userManagement.resetPasswordConfirm', { name: u.display_name }))) return;
    setResettingUserId(u.id);
    setError(null);
    try {
      const result = await authFetchJson(`/api/users/${u.id}/reset-password`, { method: 'POST' });
      setTemporaryPasswordInfo({ email: u.email, temporaryPassword: result.temporary_password });
      refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setResettingUserId(null);
    }
  };

  // Click toggles asc/desc on the same column, switching column starts
  // fresh at ascending -- same rule as Records' toggleSort.
  const toggleSort = (field) => {
    if (sortField === field) {
      setSortDir((dir) => (dir === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('asc');
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
    setEditErrors({});
    setError(null);
  };

  const cancelEdit = () => {
    setEditingUserId(null);
    setEditErrors({});
  };

  const handleSaveEdit = async (userId) => {
    setError(null);
    const errors = { email: !editDraft.email.trim(), display_name: !editDraft.display_name.trim() };
    setEditErrors(errors);
    if (errors.email || errors.display_name) return;
    setSavingEdit(true);
    try {
      await authFetchJson(`/api/users/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editDraft),
      });
      setEditingUserId(null);
      setEditErrors({});
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

  // Project roles sorts by COUNT, not alphabetically (docs request) --
  // ties are broken by each user's alphabetically-first assigned project
  // name, since "who has more projects" doesn't otherwise say anything
  // about ordering among users with the same count.
  const sortedUsers = !sortField
    ? users
    : [...users].sort((a, b) => {
        let cmp;
        if (sortField === 'email') cmp = a.email.localeCompare(b.email);
        else if (sortField === 'name') cmp = a.display_name.localeCompare(b.display_name);
        else if (sortField === 'globalRole') cmp = a.global_role.localeCompare(b.global_role);
        else if (sortField === 'projectRoles') {
          cmp = a.project_roles.length - b.project_roles.length;
          if (cmp === 0) {
            const firstA = [...a.project_roles].map((r) => projectName(r.project_id)).sort()[0] || '';
            const firstB = [...b.project_roles].map((r) => projectName(r.project_id)).sort()[0] || '';
            cmp = firstA.localeCompare(firstB);
          }
        } else cmp = 0;
        return sortDir === 'asc' ? cmp : -cmp;
      });

  return (
    <details className={styles.section}>
      <summary className={styles.accordionSummary}>
        <ChevronRight size={16} className={styles.chevron} aria-hidden="true" />
        {t('settings.userManagement.title')}
      </summary>
      <div className={styles.sectionBody}>
      {error && <p className={styles.statusInvalid}>{error}</p>}

      <form className={styles.formRow} onSubmit={handleCreate} style={{ marginBottom: 12, flexWrap: 'wrap' }}>
        <div className={styles.formGroup}>
          <label className={styles.label}>{t('settings.userManagement.email')}</label>
          <input
            className={`${styles.input} ${createErrors.email ? styles.inputError : ''}`}
            type="email"
            value={newUser.email}
            onChange={(e) => {
              setNewUser((u) => ({ ...u, email: e.target.value }));
              setCreateErrors((errs) => ({ ...errs, email: false }));
            }}
          />
          {createErrors.email && <p className={styles.fieldError}>{t('validation.required')}</p>}
        </div>
        <div className={styles.formGroup}>
          <label className={styles.label}>{t('settings.userManagement.displayName')}</label>
          <input
            className={`${styles.input} ${createErrors.display_name ? styles.inputError : ''}`}
            value={newUser.display_name}
            onChange={(e) => {
              setNewUser((u) => ({ ...u, display_name: e.target.value }));
              setCreateErrors((errs) => ({ ...errs, display_name: false }));
            }}
          />
          {createErrors.display_name && <p className={styles.fieldError}>{t('validation.required')}</p>}
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
              <SortableHeader field="email" sortField={sortField} sortDir={sortDir} onSort={toggleSort}>
                {t('settings.userManagement.table.email')}
              </SortableHeader>
              <SortableHeader field="name" sortField={sortField} sortDir={sortDir} onSort={toggleSort}>
                {t('settings.userManagement.table.name')}
              </SortableHeader>
              <SortableHeader field="globalRole" sortField={sortField} sortDir={sortDir} onSort={toggleSort}>
                {t('settings.userManagement.table.globalRole')}
              </SortableHeader>
              <SortableHeader field="projectRoles" sortField={sortField} sortDir={sortDir} onSort={toggleSort}>
                {t('settings.userManagement.table.projectRoles')}
              </SortableHeader>
              <th>{t('settings.userManagement.table.assign')}</th>
              <th>{t('settings.userManagement.table.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {sortedUsers.map((u) => {
              const isEditing = editingUserId === u.id;
              const isSelf = u.id === currentUserId;
              const isLastAdmin = u.global_role === 'admin' && adminCount <= 1;
              return (
              <tr key={u.id}>
                <td>
                  {isEditing ? (
                    <>
                      <input
                        className={`${styles.input} ${editErrors.email ? styles.inputError : ''}`}
                        type="email"
                        value={editDraft.email}
                        onChange={(e) => {
                          setEditDraft((d) => ({ ...d, email: e.target.value }));
                          setEditErrors((errs) => ({ ...errs, email: false }));
                        }}
                      />
                      {editErrors.email && <p className={styles.fieldError}>{t('validation.required')}</p>}
                    </>
                  ) : (
                    u.email
                  )}
                </td>
                <td>
                  {isEditing ? (
                    <>
                      <input
                        className={`${styles.input} ${editErrors.display_name ? styles.inputError : ''}`}
                        value={editDraft.display_name}
                        onChange={(e) => {
                          setEditDraft((d) => ({ ...d, display_name: e.target.value }));
                          setEditErrors((errs) => ({ ...errs, display_name: false }));
                        }}
                      />
                      {editErrors.display_name && <p className={styles.fieldError}>{t('validation.required')}</p>}
                    </>
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
                        onClick={() => handleResetPassword(u)}
                        disabled={resettingUserId === u.id}
                      >
                        {resettingUserId === u.id
                          ? t('settings.userManagement.resettingPassword')
                          : t('settings.userManagement.resetPassword')}
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
      {temporaryPasswordInfo && (
        <TemporaryPasswordModal
          email={temporaryPasswordInfo.email}
          temporaryPassword={temporaryPasswordInfo.temporaryPassword}
          onClose={() => setTemporaryPasswordInfo(null)}
        />
      )}
      </div>
    </details>
  );
}

// Settings > Papelera -- admin-only, cross-project (docs request: lists
// every project's trash, not just whichever project happens to be
// selected elsewhere in the app -- this page has no project context of
// its own). Same collapsed-by-default <details>/<summary> as Import
// Settings above.
function TrashSection() {
  const { t } = useTranslation();
  const { data, isLoading, isError } = useTrash();
  const restoreMutation = useRestoreBrdp();
  const deleteMutation = usePermanentlyDeleteBrdp();
  const bulkDeleteMutation = useBulkPermanentlyDeleteBrdps();
  const [error, setError] = useState(null);
  // Restore stays per-row (docs request: not requested in bulk). Delete
  // permanently can be either -- `pendingDelete` is either
  // { kind: 'single', entry } or { kind: 'bulk', ids }, both routed
  // through the SAME confirmation modal below (docs request: "el mismo
  // modal... adaptando el texto"), never two separate modals.
  const [pendingDelete, setPendingDelete] = useState(null);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const headerCheckboxRef = useRef(null);
  // The row index a plain (non-Shift) click last landed on -- deliberately
  // NOT part of selectedIds/React state (it's an interaction anchor, not
  // selection data, and doesn't need to trigger a re-render on its own).
  // Standard Gmail/Finder/Explorer semantics: Shift-click fills the range
  // between this and the row just clicked, inclusive of both ends.
  const lastClickedIndexRef = useRef(null);

  // Prunes selectedIds whenever the trash list itself changes (a restore,
  // a delete, or another admin's own action landing via the next poll/
  // refetch) -- without this, a row that just left the Papelera would
  // stay "selected" in memory, and an empty Papelera after a full bulk
  // delete would otherwise still show a stale, non-empty selection
  // (docs request's own edge case: "sin residuos de checkboxes
  // seleccionados").
  useEffect(() => {
    if (!data) return;
    const liveIds = new Set(data.map((e) => e.id));
    setSelectedIds((prev) => {
      const next = new Set([...prev].filter((id) => liveIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
    // The list just changed (a restore, a delete, another admin's own
    // action) -- row indices may no longer mean what they meant a moment
    // ago, so the Shift-click anchor is reset rather than remapped (docs
    // request's own edge case: this must never point at a row that no
    // longer exists). The next click, Shift or not, simply starts a fresh
    // anchor -- safe, and matches how a real spreadsheet/file browser
    // behaves after its own list changes underneath a pending selection.
    lastClickedIndexRef.current = null;
  }, [data]);

  const allSelected = !!data && data.length > 0 && selectedIds.size === data.length;
  const someSelected = selectedIds.size > 0 && !allSelected;

  // <input type="checkbox">'s indeterminate visual state has no HTML
  // attribute -- it's DOM-property-only, so it has to be set imperatively
  // via a ref rather than through JSX props (docs request: "el checkbox
  // de cabecera debe reflejar el estado 'parcial' (indeterminate)").
  useEffect(() => {
    if (headerCheckboxRef.current) headerCheckboxRef.current.indeterminate = someSelected;
  }, [someSelected]);

  const toggleSelectAll = () => {
    if (!data) return;
    setSelectedIds(allSelected ? new Set() : new Set(data.map((e) => e.id)));
  };

  const toggleRow = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // A plain click toggles just this row (existing behavior) and becomes
  // the new anchor. A Shift-click with a real prior anchor selects (adds
  // -- never removes) every row between the anchor and this one,
  // inclusive, regardless of which direction the anchor is in. Shift
  // held with NO prior anchor (nothing clicked yet this "session") falls
  // through to a plain toggle instead of doing nothing or throwing (docs
  // request's own edge case).
  //
  // Uses onClick, not onChange: onChange alone can't see the Shift
  // modifier reliably (it's a plain "change" event, not a MouseEvent).
  // Deliberately does NOT call event.preventDefault() -- confirmed by
  // hand (a real, reproducible bug, not a hypothetical) that doing so
  // breaks this exact controlled checkbox: React's own checked-state
  // reconciliation for a checkbox input relies on the browser's native
  // toggle actually happening on click, so preventing it left every row
  // rendering checked=false forever regardless of what selectedIds said,
  // even though the state itself (and the "Delete N permanently" count)
  // was updating correctly underneath. Letting the native toggle happen
  // is harmless here: selectedIds (add-only for a Shift range, and the
  // authoritative source either way) overrides it on the very next
  // render, same as any other controlled input.
  const handleRowCheckboxClick = (index, id, event) => {
    if (event.shiftKey && lastClickedIndexRef.current !== null && data) {
      const start = Math.min(lastClickedIndexRef.current, index);
      const end = Math.max(lastClickedIndexRef.current, index);
      const rangeIds = data.slice(start, end + 1).map((e) => e.id);
      setSelectedIds((prev) => new Set([...prev, ...rangeIds]));
    } else {
      toggleRow(id);
    }
    lastClickedIndexRef.current = index;
  };

  const handleRestore = async (entry) => {
    setError(null);
    try {
      await restoreMutation.mutateAsync(entry.id);
    } catch (err) {
      // Most notably the identifier-reuse 409 (docs request's own edge
      // case) -- the backend's detail message already names the
      // conflicting identifier, shown here as-is.
      setError(err.message);
    }
  };

  const handleConfirmDelete = async () => {
    setError(null);
    try {
      if (pendingDelete.kind === 'bulk') {
        const result = await bulkDeleteMutation.mutateAsync(pendingDelete.ids);
        // A real race (docs request: "una de las filas seleccionadas fue
        // restaurada por otro admin justo antes de confirmar") -- the
        // backend still deletes everything it validly can and reports
        // the rest, rather than aborting the whole batch over one stale
        // id. Surfaced, not swallowed.
        if (result.not_found.length > 0) {
          setError(t('settings.trash.bulkPartial', { count: result.not_found.length }));
        }
        setSelectedIds(new Set());
      } else {
        await deleteMutation.mutateAsync(pendingDelete.entry.id);
      }
      setPendingDelete(null);
    } catch (err) {
      setError(err.message);
    }
  };

  const busy = deleteMutation.isPending || bulkDeleteMutation.isPending;

  return (
    <details className={styles.section}>
      <summary className={styles.accordionSummary}>
        <ChevronRight size={16} className={styles.chevron} aria-hidden="true" />
        {t('settings.trash.title')}
      </summary>
      <div className={styles.sectionBody}>
        <p className={styles.fieldDescription}>{t('settings.trash.description')}</p>
        {error && <p className={styles.statusInvalid}>{error}</p>}
        {isLoading && <p>…</p>}
        {isError && <p className={styles.statusInvalid}>{t('settings.trash.loadError')}</p>}
        {data && data.length === 0 && <p className={styles.fieldDescription}>{t('settings.trash.empty')}</p>}
        {data && data.length > 0 && (
          <>
            <div className={styles.buttonGroup} style={{ marginTop: 0, marginBottom: 10 }}>
              <button
                type="button"
                className={styles.dangerLink}
                onClick={() => setPendingDelete({ kind: 'bulk', ids: [...selectedIds] })}
                disabled={selectedIds.size === 0}
              >
                {t('settings.trash.deleteSelected', { count: selectedIds.size })}
              </button>
            </div>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>
                    <input
                      ref={headerCheckboxRef}
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleSelectAll}
                      aria-label={t('settings.trash.selectAll')}
                    />
                  </th>
                  <th>{t('settings.trash.table.identifier')}</th>
                  <th>{t('settings.trash.table.title')}</th>
                  <th>{t('settings.trash.table.project')}</th>
                  <th>{t('settings.trash.table.deletedBy')}</th>
                  <th>{t('settings.trash.table.deletedAt')}</th>
                  <th>{t('settings.trash.table.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {data.map((entry, index) => (
                  <tr key={entry.id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selectedIds.has(entry.id)}
                        onClick={(e) => handleRowCheckboxClick(index, entry.id, e)}
                        onChange={() => {}} // selection logic lives in onClick above (needs the Shift modifier); this silences React's "controlled checkbox needs onChange" warning
                        aria-label={t('settings.trash.selectRow', { identifier: entry.identifier })}
                      />
                    </td>
                    <td>{entry.identifier}</td>
                    <td>{entry.title || '—'}</td>
                    <td>{entry.project_name}</td>
                    <td>{entry.deleted_by_email || t('settings.trash.unknownUser')}</td>
                    <td>{new Date(entry.deleted_at).toLocaleString()}</td>
                    <td>
                      <div className={styles.actionsCell}>
                        <button
                          type="button"
                          onClick={() => handleRestore(entry)}
                          disabled={restoreMutation.isPending}
                        >
                          {t('settings.trash.restore')}
                        </button>
                        <button
                          type="button"
                          className={styles.dangerLink}
                          onClick={() => setPendingDelete({ kind: 'single', entry })}
                        >
                          {t('settings.trash.deletePermanently')}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        {pendingDelete && (
          <div className={styles.modalOverlay} onClick={() => setPendingDelete(null)}>
            <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
              <h3 className={styles.sectionTitle}>{t('settings.trash.confirmTitle')}</h3>
              <p className={styles.dangerText}>
                {pendingDelete.kind === 'bulk'
                  ? t('settings.trash.confirmWarningBulk', { count: pendingDelete.ids.length })
                  : t('settings.trash.confirmWarning', { identifier: pendingDelete.entry.identifier })}
              </p>
              <p className={styles.dangerText}>{t('settings.trash.confirmIrreversible')}</p>
              <div className={styles.buttonGroup}>
                <button type="button" className={styles.dangerButton} onClick={handleConfirmDelete} disabled={busy}>
                  {busy ? t('settings.trash.deleting') : t('settings.trash.confirmDeleteButton')}
                </button>
                <button type="button" onClick={() => setPendingDelete(null)} disabled={busy}>
                  {t('settings.trash.cancel')}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </details>
  );
}

export default function SettingsPage() {
  const { t } = useTranslation();
  const { user, updateUser } = useAuthContext();
  const { projects } = useProjectContext();

  if (!user) return null;

  // Trash is no longer admin-only server-side -- an editor of at least one
  // project can see and act on that project's trashed BRDPs too (the
  // backend itself scopes what they get back to just those projects, so
  // no further filtering happens here beyond deciding whether to render
  // the section at all).
  const canSeeTrash = user.global_role === 'admin' || projects.some((p) => p.effective_role === 'editor');

  return (
    <div className={styles.container}>
      <h2 className={styles.title}>{t('nav.settings')}</h2>
      <div className={styles.sectionsContainer}>
        <ProfileSection user={user} onUserUpdated={updateUser} />
        {user.global_role === 'admin' && <UserManagementSection currentUserId={user.id} />}
        {canSeeTrash && <TrashSection />}
      </div>
    </div>
  );
}
