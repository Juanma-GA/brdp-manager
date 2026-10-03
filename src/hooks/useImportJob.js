import { useQuery, useQueryClient } from '@tanstack/react-query';
import { authFetchJson } from '../services/apiClient';

// 3s -- a real, deliberately not-aggressive interval (docs request: never
// aggressive polling). GET /import/status/active is a single indexed
// query (ix_import_jobs_project_id_status), cheap enough to poll this
// often without meaningfully loading the server, while still feeling
// responsive for a progress bar.
const POLL_INTERVAL_MS = 3000;

export function importJobQueryKey(projectId) {
  return ['import-job', projectId];
}

// Shared by ProjectConfigPage (recovers/renders full progress + result)
// and Sidebar (renders the persistent "Import in progress" badge) --
// both call this same hook with the same projectId, so React Query dedupes
// them into ONE polling query and ONE shared cache entry, never two
// independent intervals hitting the API. This is also what makes the
// query survive navigating away from Project Configuration and back
// (docs request): the cache lives in the QueryClient instance App.jsx
// creates once, not in either component's own state.
//
// Returns the most recent import job for the project regardless of
// status (see get_most_recent_job on the backend) -- null if none ever
// existed. Polling stops on its own once the job is no longer "running"
// (completed/failed/no job), so a finished project doesn't keep getting
// hit every 3s forever.
export function useActiveImportJob(projectId) {
  return useQuery({
    queryKey: importJobQueryKey(projectId),
    queryFn: () => authFetchJson(`/api/projects/${projectId}/brdps/import/status/active`),
    enabled: !!projectId,
    refetchInterval: (query) => (query.state.data?.status === 'running' ? POLL_INTERVAL_MS : false),
  });
}

// Call after POSTing a new Apply job so the UI reflects it immediately
// (the job just created is now the most recent one) instead of waiting up
// to POLL_INTERVAL_MS for the next scheduled poll.
export function useInvalidateImportJob() {
  const queryClient = useQueryClient();
  return (projectId) => queryClient.invalidateQueries({ queryKey: importJobQueryKey(projectId) });
}

function dismissedImportJobQueryKey(projectId) {
  return ['dismissed-import-job', projectId];
}

// Which job.id (if any) the user has explicitly closed via ProjectConfigPage's
// "Close" button on a finished (completed/failed) job's result panel.
// Deliberately stored in this same QueryClient cache instead of component
// state: a plain useState resets every time ProjectConfigPage unmounts
// (navigating to another page and back), silently resurrecting a result
// the user already dismissed -- this survives that exactly as long as the
// job query above already does (same QueryClient instance, created once in
// App.jsx), while a real tab close + reopen still starts a fresh
// QueryClient and correctly re-surfaces the last known result.
//
// `queryFn` here is never really "fetched" -- it only ever supplies the
// starting `null` before any Close has happened; every later value comes
// from useDismissImportJob's setQueryData below.
export function useDismissedImportJobId(projectId) {
  const { data } = useQuery({
    queryKey: dismissedImportJobQueryKey(projectId),
    queryFn: () => null,
    enabled: !!projectId,
    staleTime: Infinity,
  });
  return data ?? null;
}

export function useDismissImportJob() {
  const queryClient = useQueryClient();
  return (projectId, jobId) => queryClient.setQueryData(dismissedImportJobQueryKey(projectId), jobId);
}
