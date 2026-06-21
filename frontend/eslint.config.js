import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'public/mockServiceWorker.js']),
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
  {
    // useAsync is a generic data-fetching hook: forwarding a dynamic deps
    // array to useCallback and setting a loading flag on mount are both
    // intentional and correct. The React-Compiler-era rules flag them as
    // false positives, so we scope them off for this file only.
    files: ['src/lib/useAsync.ts'],
    rules: {
      'react-hooks/use-memo': 'off',
      'react-hooks/set-state-in-effect': 'off',
    },
  },
  {
    // persona.tsx intentionally co-locates the provider component with its
    // context hook and constants — a standard React context module.
    files: ['src/lib/persona.tsx'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
])
