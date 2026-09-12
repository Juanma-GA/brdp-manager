import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { ProjectProvider } from './context/ProjectContext';
import ProtectedRoute from './layouts/ProtectedRoute';
import AppLayout from './layouts/AppLayout';
import ProjectLayout from './layouts/ProjectLayout';
import LoginPage from './pages/LoginPage';
import ProjectsPage from './pages/ProjectsPage';
import ProjectConfigPage from './pages/ProjectConfigPage';
import RecordsPage from './pages/RecordsPage';
import GeneratePage from './pages/GeneratePage';
import SettingsPage from './pages/SettingsPage';
import './index.css';
import './App.css';

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ProjectProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />

            <Route
              element={
                <ProtectedRoute>
                  <AppLayout />
                </ProtectedRoute>
              }
            >
              <Route path="/projects" element={<ProjectsPage />} />
              <Route path="/settings" element={<SettingsPage />} />

              <Route path="/projects/:projectId" element={<ProjectLayout />}>
                <Route path="config" element={<ProjectConfigPage />} />
                <Route path="records" element={<RecordsPage />} />
                <Route path="generate" element={<GeneratePage />} />
                <Route index element={<Navigate to="records" replace />} />
              </Route>

              <Route path="/" element={<Navigate to="/projects" replace />} />
            </Route>

            <Route path="*" element={<Navigate to="/projects" replace />} />
          </Routes>
        </ProjectProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
