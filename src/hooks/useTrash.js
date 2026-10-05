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

// AACF 1, Part 1 (HR20): restoring and deleting for good are optimistic --
// the rows leave the list at once; if the server refuses, the list comes
// back as it was (the page shows the reason). The list is read again when
// the request settles, either way.
function optimisticRemoval(queryClient, idsOf) {
  return {
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey: TRASH_QUERY_KEY });
      const previous = queryClient.getQueryData(TRASH_QUERY_KEY);
      const ids = new Set(idsOf(variables));
      if (previous) queryClient.setQueryData(TRASH_QUERY_KEY, previous.filter((e) => !ids.has(e.id)));
      return { previous };
    },
    onError: (_err, _variables, context) => {
      if (context?.previous) queryClient.setQueryData(TRASH_QUERY_KEY, context.previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: TRASH_QUERY_KEY }),
  };
}

export function useRestoreBrdp() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (brdpId) => authFetchJson(`/api/trash/${brdpId}/restore`, { method: 'POST' }),
    ...optimisticRemoval(queryClient, (brdpId) => [brdpId]),
  });
}

export function usePermanentlyDeleteBrdp() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (brdpId) => authFetchJson(`/api/trash/${brdpId}`, { method: 'DELETE' }),
    ...optimisticRemoval(queryClient, (brdpId) => [brdpId]),
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
    ...optimisticRemoval(queryClient, (brdpIds) => brdpIds),
  });
}
