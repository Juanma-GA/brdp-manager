import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

// docs/v2/03-especificacion-v2-para-claude-code.md §5: react-i18next from
// the first NEW component onward -- not a retroactive translation of the
// v1 UI (BRDPTable, DetailPanel, ChatPanel, etc. keep their English
// strings for now). `en` is the base (matches v1's existing strings),
// `es` is the structure this was built to support next.
const resources = {
  en: {
    common: {
      appName: 'BRDP Manager',
      login: {
        title: 'Sign in',
        email: 'Email',
        password: 'Password',
        submit: 'Sign in',
        error: 'Invalid email or password',
      },
      nav: {
        projects: 'BRDP Projects',
        settings: 'Settings',
        allProjects: 'All projects',
        config: 'Project Configuration',
        records: 'BRDP Records',
        generate: 'Generate BREX / Schematron',
      },
      projects: {
        title: 'BRDP Projects',
        subtitle: 'Projects assigned to your user. Each is managed independently.',
        empty: 'You have no projects assigned yet. Ask an administrator to add you to one.',
        name: 'Project name',
        standard: 'Project standard',
        count: 'Number of BRDPs',
        actions: 'Actions',
      },
      language: 'Language',
    },
  },
  es: {
    common: {
      appName: 'BRDP Manager',
      login: {
        title: 'Iniciar sesión',
        email: 'Correo electrónico',
        password: 'Contraseña',
        submit: 'Entrar',
        error: 'Correo o contraseña incorrectos',
      },
      nav: {
        projects: 'Proyectos BRDP',
        settings: 'Ajustes',
        allProjects: 'Todos los proyectos',
        config: 'Configuración del proyecto',
        records: 'Registros BRDP',
        generate: 'Generar BREX / Schematron',
      },
      projects: {
        title: 'Proyectos BRDP',
        subtitle: 'Proyectos asignados a tu usuario. Cada uno se gestiona de forma independiente.',
        empty: 'Todavía no tienes proyectos asignados. Pide a un administrador que te añada a uno.',
        name: 'Nombre del proyecto',
        standard: 'Estándar del proyecto',
        count: 'Número de BRDPs',
        actions: 'Acciones',
      },
      language: 'Idioma',
    },
  },
};

const LANGUAGE_KEY = 'brdp_v2_language';

function getStoredLanguage() {
  try {
    return localStorage.getItem(LANGUAGE_KEY) || 'en';
  } catch {
    return 'en';
  }
}

export function setLanguage(lng) {
  try {
    localStorage.setItem(LANGUAGE_KEY, lng);
  } catch {
    // localStorage unavailable -- language choice just won't persist across reloads.
  }
  i18n.changeLanguage(lng);
}

i18n.use(initReactI18next).init({
  resources,
  lng: getStoredLanguage(),
  fallbackLng: 'en',
  defaultNS: 'common',
  interpolation: { escapeValue: false },
});

export default i18n;
