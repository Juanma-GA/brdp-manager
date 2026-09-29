import { useCallback, useEffect, useRef, useState } from 'react';
import { Navigate, Outlet, useParams } from 'react-router-dom';
import { authFetchJson } from '../services/apiClient';

/**
 * Fetches the full project (including project_config) for :projectId and
 * hands it to the child route via Outlet context, so ProjectConfigPage/
 * RecordsPage/GeneratePage don't each re-fetch it. A 403/404 here means
 * this user has no access to this project (docs/v2 §4.1: the backend is
 * the real gate, this is just the UI reflecting that) -- bounced back to
 * the project list rather than shown a broken page.
 *
 * refreshProject() (after ProjectConfigPage's PUT, to pick up the freshly
 * saved project_config) re-fetches in place: it never goes back to the
 * loading state, which unmounted the child page and lost its state -- the
 * "Saved" indicator never got to show (C3, Part 2). It returns the fetch's
 * promise, so the caller can show a failure.
 */
export default function ProjectLayout() {
  const { projectId } = useParams();
  const [project, setProject] = useState(null);
  const [status, setStatus] = useState('loading'); // 'loading' | 'ok' | 'denied'
  const currentId = useRef(projectId);
  currentId.current = projectId;

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    authFetchJson(`/api/projects/${projectId}/config`)
      .then((data) => {
        if (!cancelled) {
          setProject(data);
          setStatus('ok');
        }
      })
      .catch(() => {
        if (!cancelled) setStatus('denied');
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const refreshProject = useCallback(
    () =>
      authFetchJson(`/api/projects/${projectId}/config`).then((data) => {
        if (currentId.current === projectId) setProject(data);
        return data;
      }),
    [projectId]
  );

  if (status === 'loading') return <div style={{ padding: 24 }}>…</div>;
  if (status === 'denied') return <Navigate to="/projects" replace />;

  return <Outlet context={{ project, refreshProject }} />;
}
