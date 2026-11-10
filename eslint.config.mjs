// Lint configuration for server and web (flat config). Rules follow the existing code style;
// formatting is Prettier's job, not ESLint's.
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', 'e2e/**', 'integrations/**', 'docs/**', 'backlog/**', '.claude/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Unused values are errors, except deliberately ignored ones (prefixed with _).
      // Warnings for now: parallel work still touches these files. Tighten to 'error' once the
      // count is zero (`npm run lint` lists the warnings).
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-useless-assignment': 'warn',
      'no-useless-escape': 'warn',
      // Database rows and external payloads are typed loosely in places; keep this a hint.
      '@typescript-eslint/no-explicit-any': 'warn',
      // Regular expressions deliberately match thin spaces and the byte order mark.
      'no-irregular-whitespace': ['error', { skipRegExps: true, skipStrings: true, skipTemplates: true }],
    },
  },
  {
    files: ['server/**/*.ts', 'tools/**/*.{js,mjs}', '*.mjs'],
    languageOptions: { globals: globals.node },
  },
  {
    // Slide generator script in CommonJS.
    files: ['tools/**/*.js'],
    languageOptions: { sourceType: 'commonjs', globals: globals.node },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    files: ['web/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
);
