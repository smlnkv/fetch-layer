import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import importX from 'eslint-plugin-import-x';
import globals from 'globals';
import prettierConfig from 'eslint-config-prettier';

export default [
  // Что игнорировать
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.vitest/**',
      '**/*.tsbuildinfo',
      '**/*.config.js',
      '**/*.config.mjs',
      '**/*.config.ts',
    ],
  },

  // Базовые рекомендованные правила ESLint
  js.configs.recommended,

  // TypeScript + type-aware linting
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        ecmaVersion: 2023,
        sourceType: 'module',
      },
      globals: {
        ...globals.node,
        ...globals.browser,
        ...globals.es2023,
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      'import-x': importX,
    },
    rules: {
      // Базовые правила TypeScript
      ...tsPlugin.configs.recommended.rules,

      // Type-aware: ловит промисы без await/.catch()
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      // Единый стиль импорта типов
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],

      // Разрешаем `any` с предупреждением
      '@typescript-eslint/no-explicit-any': 'warn',

      // Неиспользуемые переменные с префиксом `_` игнорируются
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // Только два правила из import-x — без резолвера
      'import-x/no-cycle': 'error',
      'import-x/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index', 'type'],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],

      // Общие правила
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },

  // Отключаем правила ESLint, конфликтующие с Prettier
  prettierConfig,
];
