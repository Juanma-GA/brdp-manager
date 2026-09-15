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
