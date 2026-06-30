import js from '@eslint/js';
import pluginVue from 'eslint-plugin-vue';
import {
  defineConfigWithVueTs,
  vueTsConfigs,
  configureVueProject,
} from '@vue/eslint-config-typescript';
import skipFormatting from '@vue/eslint-config-prettier/skip-formatting';
// Globals для авто-импортов WXT/Vue (генерируется `wxt prepare`).
import autoImports from './.wxt/eslint-auto-imports.mjs';

configureVueProject({ rootDir: import.meta.dirname });

export default defineConfigWithVueTs(
  // Что НЕ линтим.
  {
    ignores: ['.wxt/**', '.output/**', 'dist/**', 'node_modules/**', 'stats*.html'],
  },

  // WXT-globals должны идти раньше правил, иначе авто-импорты дадут no-undef.
  autoImports,

  js.configs.recommended,
  pluginVue.configs['flat/recommended'],
  vueTsConfigs.recommended,

  // Проектные правила.
  {
    rules: {
      // В небольшом расширении не требуем многословные имена компонентов.
      'vue/multi-word-component-names': 'off',
    },
  },

  // Content script монтирует несколько Vue-приложений (CapBar/QuarterBar) через createApp —
  // правило «один компонент на файл» здесь неприменимо.
  {
    files: ['src/entrypoints/**/*.ts'],
    rules: { 'vue/one-component-per-file': 'off' },
  },

  // E2E-скрипты: node-окружение + браузерные API внутри page.evaluate().
  {
    files: ['e2e/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        document: 'readonly',
        getComputedStyle: 'readonly',
        location: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        performance: 'readonly',
      },
    },
  },

  // Отключаем правила, конфликтующие с Prettier (форматирование делает Prettier).
  skipFormatting,
);
