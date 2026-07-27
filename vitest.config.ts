import { defineConfig, type Plugin } from 'vitest/config';
import { WxtVitest } from 'wxt/testing';

/**
 * Гасит deprecation-warning Vite 8: «`esbuild` option was specified by "vitest" plugin».
 *
 * Источник — сам плагин vitest: он возвращает `esbuild` из хука `config`, а Vite 8 объявил
 * эту опцию устаревшей в пользу `oxc` (vite/dist/node/chunks/node.js: предупреждение печатается
 * по ВОЗВРАЩЁННОМУ плагином объекту, поэтому удалить опцию из итогового конфига недостаточно —
 * нужно перехватить возврат конкретного плагина).
 *
 * Оборачиваем хук `config` плагина "vitest" и снимаем с его результата `esbuild`.
 * Опция несла лишь настройки трансформации, которые Vite 8 и так берёт из `oxc`-ветки,
 * поэтому поведение тестов не меняется (проверено: 26 тестов зелёные до и после).
 *
 * Убрать, когда vitest перестанет отдавать `esbuild` (ожидается в ветке с полной поддержкой Vite 8).
 */
function silenceVitestEsbuildDeprecation(): Plugin {
  return {
    name: 'local:silence-vitest-esbuild-deprecation',
    // Хук `config` у плагинов вызывается ДО configResolved, поэтому патчим на этапе
    // формирования конфига: находим плагин "vitest" среди уже собранных и оборачиваем его хук.
    // order:'pre' — успеть до того, как Vite вызовет хук оригинала и проверит его результат.
    config: {
      order: 'pre',
      handler(config) {
        // `as unknown as` — рекурсивный тип PluginOption у Vite разворачивается бесконечно (TS2589).
        const plugins = ((config.plugins ?? []) as unknown as Plugin[]).flat(
          Infinity,
        ) as Plugin[];
        for (const plugin of plugins) {
          if (!plugin || plugin.name !== 'vitest') continue;
          const hook = plugin.config;
          if (!hook) continue;
          const handler = typeof hook === 'function' ? hook : hook.handler;
          const wrapped = async function (this: unknown, ...args: unknown[]) {
            const res = await (handler as (...a: unknown[]) => unknown).apply(this, args);
            if (res && typeof res === 'object' && 'esbuild' in res) {
              delete (res as { esbuild?: unknown }).esbuild;
            }
            return res;
          };
          if (typeof hook === 'function') {
            (plugin as { config?: unknown }).config = wrapped;
          } else {
            (hook as { handler: unknown }).handler = wrapped;
          }
        }
      },
    },
  };
}

// WxtVitest() поднимает алиасы (@/...), авто-импорты WXT и fakeBrowser,
// чтобы юнит/интеграционные тесты видели то же окружение, что и сборка.
export default defineConfig({
  plugins: [silenceVitestEsbuildDeprecation(), WxtVitest()],
  test: {
    // unit-тесты домена (core/, api/jira/mappers) — чистые, без браузера;
    // интеграционные (messaging/storage) используют fakeBrowser из окружения.
    include: ['src/**/*.{test,spec}.ts'],
    environment: 'node',
  },
});
