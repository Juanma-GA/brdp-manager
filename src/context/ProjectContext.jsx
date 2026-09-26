import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { authFetchJson } from '../services/apiClient';
import { useAuthContext } from './AuthContext';

const ProjectContext = createContext();

/**
 * Project list for the current user (docs/v2 §4.2/§4.3: admin sees every
 * project, everyone else only what they're assigned to -- the backend
 * already enforces this, this just reflects whatever GET /api/projects
 * returns).
 */
export function ProjectProvider({ children }) {
  const { isAuthenticated } = useAuthContext();
  const [projects, setProjects] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  const refreshProjects = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await authFetchJson('/api/projects');
      setProjects(data);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isAuthenticated) {
      refreshProjects();
    } else {
      setProjects([]);
      setIsLoading(false);
    }
  }, [isAuthenticated, refreshProjects]);

  const value = { projects, isLoading, error, refreshProjects };

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

export function useProjectContext() {
  const context = useContext(ProjectContext);
  if (!context) {
    throw new Error('useProjectContext must be used within ProjectProvider');
  }
  return context;
}
