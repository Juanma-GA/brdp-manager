import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authFetchJson } from '../services/apiClient';

// Same interval as useImportJob.js's POLL_INTERVAL_MS -- deliberately not
// aggressive, and GET /embeddings/status/active is a single indexed query,
// same shape as the import job's own status poll.
const POLL_INTERVAL_MS = 3000;

function pendingEmbeddingsQueryKey(projectId) {
  return ['pending-embeddings', projectId];
}

function embeddingJobQueryKey(projectId) {
  return ['embedding-job', projectId];
}

// Backs the Suggest area's banner/button gate (docs request): shown, and
// Suggest disabled, whenever project_pending or catalog_pending is
// non-zero. No polling here on its own -- RecordsPage re-fetches it after
// a job completes (see useActiveEmbeddingJob below) and after any edit
// that could change what's pending, same as the rest of this page's
// invalidation pattern.
export function usePendingEmbeddings(projectId) {
  return useQuery({
    queryKey: pendingEmbeddingsQueryKey(projectId),
    queryFn: () => authFetchJson(`/api/projects/${projectId}/embeddings/pending`),
    enabled: !!projectId,
  });
}

export function useInvalidatePendingEmbeddings() {
  const queryClient = useQueryClient();
  return (projectId) => queryClient.invalidateQueries({ queryKey: pendingEmbeddingsQueryKey(projectId) });
}

// Same "one shared cache entry, one polling query" reasoning as
// useImportJob.js's useActiveImportJob -- returns the most recent
// embedding job for the project regardless of status, null if none ever
// existed. Polling stops on its own once the job is no longer "running".
export function useActiveEmbeddingJob(projectId) {
  return useQuery({
    queryKey: embeddingJobQueryKey(projectId),
    queryFn: () => authFetchJson(`/api/projects/${projectId}/embeddings/status/active`),
    enabled: !!projectId,
    refetchInterval: (query) => (query.state.data?.status === 'running' ? POLL_INTERVAL_MS : false),
  });
}

export function useInvalidateEmbeddingJob() {
  const queryClient = useQueryClient();
  return (projectId) => queryClient.invalidateQueries({ queryKey: embeddingJobQueryKey(projectId) });
}

// POST /compute -- launches the background job (docs request: editor-only,
// enforced server-side regardless of what the UI shows). 409 (another job
// already running, e.g. two editors clicking at once) surfaces via
// mutation.error like any other authFetchJson failure; the caller
// re-invalidates the job query either way so the UI reflects whatever IS
// actually running instead of staying stuck on a stale view.
export function useComputeEmbeddings(projectId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => authFetchJson(`/api/projects/${projectId}/embeddings/compute`, { method: 'POST' }),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: embeddingJobQueryKey(projectId) });
    },
  });
}
