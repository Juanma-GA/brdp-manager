import { useEffect, useState } from 'react';
import { Navigate, Outlet, useParams } from 'react-router-dom';
import { authFetchJson } from '../services/apiClient';

/**
 * Fetches the full project (including project_config) for :projectId and
 * hands it to the child route via Outlet context, so ProjectConfigPage/
 * RecordsPage/GeneratePage don't each re-fetch it. A 403/404 here means
 * this user has no access to this project (docs/v2 §4.1: the backend is
 * the real gate, this is just the UI reflecting that) -- bounced back to
 * the project list rather than shown a broken page.
 */
export default function ProjectLayout() {
  const { projectId } = useParams();
  const [project, setProject] = useState(null);
  const [status, setStatus] = useState('loading'); // 'loading' | 'ok' | 'denied'
  // Bumped by refreshProject() to force the fetch effect to re-run even
  // though projectId hasn't changed (e.g. after ProjectConfigPage's PUT,
  // to pick up the freshly saved project_config).
  const [refreshKey, setRefreshKey] = useState(0);

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
  }, [projectId, refreshKey]);

  if (status === 'loading') return <div style={{ padding: 24 }}>…</div>;
  if (status === 'denied') return <Navigate to="/projects" replace />;

  return <Outlet context={{ project, refreshProject: () => setRefreshKey((k) => k + 1) }} />;
}
