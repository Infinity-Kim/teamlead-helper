import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

// Документация: https://wxt.dev/api/config.html
export default defineConfig({
  // Подключаемые WXT-модули.
  // - module-vue: интеграция Vue 3 (SFC, авто-импорт компонентов/composables).
  // - auto-icons: генерация всех размеров иконок из одного исходника assets/icon.png.
  modules: ['@wxt-dev/module-vue', '@wxt-dev/auto-icons'],

  // Папка с исходниками. Держим всё в src/, чтобы корень проекта оставался чистым
  // (конфиги, lockfile) — рекомендованный паттерн для нетривиальных проектов.
  srcDir: 'src',

  // Авто-импорты WXT/Vue. eslintrc.enabled: 9 → генерируем globals для ESLint 9 flat config
  // в .wxt/eslint-auto-imports.mjs, чтобы не было ложных no-undef.
  imports: {
    eslintrc: {
      enabled: 9,
    },
  },

  // Манифест MV3. Описываем в MV3-формате — WXT сам адаптирует под другие браузеры.
  // name/version/icons WXT подставляет автоматически (из package.json и auto-icons).
  manifest: {
    name: 'Team Lead Helper',
    // side_panel.default_path и permission "sidePanel" WXT добавит сам,
    // обнаружив sidepanel-entrypoint. Здесь — только то, что не выводится автоматически.
    permissions: ['storage'],
    host_permissions: [
      // Jira Cloud. Self-hosted (DC/Server) добавим конкретным хостом позже.
      'https://*.atlassian.net/*',
    ],
    // Кнопка в тулбаре — нужна и для popup, и для открытия side panel по клику.
    action: {},
  },

  // Vite-плагины. Tailwind v4 подключается через официальный @tailwindcss/vite
  // (PostCSS не нужен).
  vite: () => ({
    plugins: [tailwindcss()],
  }),
});
