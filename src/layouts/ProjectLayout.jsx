import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, Outlet, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { authFetchJson } from '../services/apiClient';
import { errorMessage } from '../services/apiErrors';
import ErrorNotice from '../components/ErrorNotice';

/**
 * Fetches the full project (including project_config) for :projectId and
 * hands it to the child route via Outlet context, so ProjectConfigPage/
 * RecordsPage/GeneratePage don't each re-fetch it. A 403/404 here means
 * this user has no access to this project (docs/v2 §4.1: the backend is
 * the real gate, this is just the UI reflecting that). AACF 1, Part 2: that
 * is said ("no access, or it no longer exists", with a link to the
 * projects) and told apart from a load that failed (no network, a server
 * error), which says so with Retry -- never a silent bounce to the list.
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
  const { t } = useTranslation();
  const [status, setStatus] = useState('loading'); // 'loading' | 'ok' | 'denied' | 'failed'
  const [loadError, setLoadError] = useState(null);
  const [reloadToken, setReloadToken] = useState(0);
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
      .catch((err) => {
        if (cancelled) return;
        if (err.status === 403 || err.status === 404) setStatus('denied');
        else {
          setLoadError(err);
          setStatus('failed');
        }
      });
    return () => {
      cancelled = true;
    };
    // Not keyed on the language: the error is kept and translated when shown,
    // so switching the language never loads the project again (that would
    // unmount the page under it, and its selection with it).
  }, [projectId, reloadToken]);

  const refreshProject = useCallback(
    () =>
      authFetchJson(`/api/projects/${projectId}/config`).then((data) => {
        if (currentId.current === projectId) setProject(data);
        return data;
      }),
    [projectId]
  );

  if (status === 'loading') return <div style={{ padding: 24 }}>…</div>;
  if (status === 'denied') {
    return (
      <div style={{ padding: 24 }} data-testid="project-denied">
        <p>{t('projectLayout.denied')}</p>
        <Link to="/projects">{t('projectLayout.backToProjects')}</Link>
      </div>
    );
  }
  if (status === 'failed') {
    return (
      <div style={{ padding: 24 }}>
        <ErrorNotice testId="project-load-error" message={t('projectLayout.loadFailed', { reason: errorMessage(loadError, t) })} onRetry={() => setReloadToken((n) => n + 1)} />
        <Link to="/projects">{t('projectLayout.backToProjects')}</Link>
      </div>
    );
  }

  return <Outlet context={{ project, refreshProject }} />;
}
