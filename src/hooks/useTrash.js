import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authFetchJson } from '../services/apiClient';

// Admin-only surface (backend 403s anyone else) -- no polling, this is a
// plain admin listing the admin opens deliberately (Settings > Papelera),
// not something that needs to stay live in the background like the
// import job badge.
const TRASH_QUERY_KEY = ['trash'];

export function useTrash() {
  return useQuery({
    queryKey: TRASH_QUERY_KEY,
    queryFn: () => authFetchJson('/api/trash'),
  });
}

export function useRestoreBrdp() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (brdpId) => authFetchJson(`/api/trash/${brdpId}/restore`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: TRASH_QUERY_KEY }),
  });
}

export function usePermanentlyDeleteBrdp() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (brdpId) => authFetchJson(`/api/trash/${brdpId}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: TRASH_QUERY_KEY }),
  });
}

// One bulk request instead of N (docs request: same "single operation"
// criterion Reset Data already uses) -- returns { deleted, not_found }
// so a real race (a row restored by someone else between the checkbox
// selection and this confirm) is reported precisely rather than
// aborting the whole batch or surfacing a raw error.
export function useBulkPermanentlyDeleteBrdps() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (brdpIds) =>
      authFetchJson('/api/trash', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brdp_ids: brdpIds }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: TRASH_QUERY_KEY }),
  });
}
