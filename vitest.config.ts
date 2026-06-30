import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing';

// WxtVitest() поднимает алиасы (@/...), авто-импорты WXT и fakeBrowser,
// чтобы юнит/интеграционные тесты видели то же окружение, что и сборка.
export default defineConfig({
  plugins: [WxtVitest()],
  test: {
    // unit-тесты домена (core/, api/jira/mappers) — чистые, без браузера;
    // интеграционные (messaging/storage) используют fakeBrowser из окружения.
    include: ['src/**/*.{test,spec}.ts'],
    environment: 'node',
  },
});
