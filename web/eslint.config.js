import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/**/*.test.{ts,tsx}', 'src/test/**'],
    rules: { 'no-console': 'error' },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/api.ts', 'src/**/*.test.{ts,tsx}', 'src/test/**'],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'fetch',
          message: 'Use the validating request/decoder boundary in src/api.ts.',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[property.name='fetch']",
          message: 'Keep network access and response decoding in src/api.ts.',
        },
        {
          selector: "MemberExpression[computed=true][property.value='fetch']",
          message: 'Keep network access and response decoding in src/api.ts.',
        },
      ],
    },
  },
  {
    files: ['src/components/**/*.{ts,tsx}', 'src/lib/**/*.{ts,tsx}'],
    ignores: ['src/**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex:
                '(^|/)(api|hooks|forms|pages|App|components)(\\.[cm]?[jt]sx?)?$',
              message:
                'Generic UI and lib modules must not depend on domain pages or API state. Pass typed props from the caller.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['*.{js,ts}', 'scripts/*.mjs'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: { globals: globals.node },
  },
]);
