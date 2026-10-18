import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

// An object rest that leaves a field out on purpose (`{ entry, ...problem }`)
// and names starting with "_" are not reported as unused.
const UNUSED_VARS = {
  'no-unused-vars': ['error', { ignoreRestSiblings: true, argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
}

export default defineConfig([
  globalIgnores(['dist', 'backend/.venv', 'public', 'sources', 'coverage']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
  },
  // The app itself (.js/.jsx in the browser).
  //
  // Downgraded to warnings (listed in the lint report, never fixed en masse):
  // fixing them would change behaviour or restructure modules, which a
  // lint-only change must not do.
  // - react-hooks/exhaustive-deps: adding a dependency changes when an
  //   effect runs.
  // - react-hooks/set-state-in-effect, refs, preserve-manual-memoization
  //   (React Compiler rules of eslint-plugin-react-hooks 7): each needs the
  //   component's state flow rewritten.
  // - react-refresh/only-export-components: only Vite's hot reload in
  //   development (a file that also exports a hook or a constant reloads
  //   the whole page instead of the component); splitting those files is a
  //   refactor, not a lint fix.
  {
    files: ['src/**/*.{js,jsx}'],
    extends: [js.configs.recommended, reactHooks.configs.flat.recommended, reactRefresh.configs.vite],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      ...UNUSED_VARS,
      'react-hooks/exhaustive-deps': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-refresh/only-export-components': 'warn',
    },
  },
  // Node: scripts, config files and the v1 Express server.
  {
    files: ['scripts/**/*.{js,mjs}', '*.{js,mjs}'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: UNUSED_VARS,
  },
])
