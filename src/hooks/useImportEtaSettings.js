import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authFetchJson } from '../services/apiClient';

// Installation-wide, not per-project (docs request) -- one shared cache
// entry regardless of which project's Project Configuration page reads
// it, same dedupe benefit useImportJob.js's shared key gets across
// ProjectConfigPage/Sidebar. No refetchInterval: unlike an in-progress
// job's status, this practically never changes and there is nothing to
// poll for -- a normal mount-time fetch is enough, and the mutation below
// invalidates the cache immediately after a real edit so this session's
// own next read (e.g. an admin who edits it, then opens a project) is
// never stale.
const IMPORT_ETA_SETTINGS_QUERY_KEY = ['app-settings', 'import-eta'];

// Readable by ANY authenticated user (backend: get_current_user, not
// admin-gated) -- an editor about to run an Apply import needs these 4
// numbers for their own ETA, even though only an admin can change them
// (see app/api/routes/app_settings.py's docstring). Used by
// ProjectConfigPage's DataManagementSection for every project/every role
// that can reach the Import subsection.
export function useImportEtaSettings() {
  return useQuery({
    queryKey: IMPORT_ETA_SETTINGS_QUERY_KEY,
    queryFn: () => authFetchJson('/api/settings/import-eta'),
  });
}

// Admin-only in practice (backend 403s anyone else) -- used by
// SettingsPage's Import ETA Settings accordion.
export function useUpdateImportEtaSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (values) =>
      authFetchJson('/api/settings/import-eta', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      }),
    onSuccess: (data) => {
      // Seed the cache directly with the just-saved response instead of
      // only invalidating -- makes the new value visible immediately in
      // this same session without waiting on a refetch round trip
      // (docs request: takes effect live, no reload).
      queryClient.setQueryData(IMPORT_ETA_SETTINGS_QUERY_KEY, data);
    },
  });
}
