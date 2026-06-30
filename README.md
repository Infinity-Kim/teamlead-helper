# Team Lead Helper

[![CI](https://github.com/Infinity-Kim/teamlead-helper/actions/workflows/ci.yml/badge.svg)](https://github.com/Infinity-Kim/teamlead-helper/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Chrome-расширение (MV3) — помощник тимлида. Накладывает на backlog **любой** Jira-доски
аналитику capacity прямо под заголовком каждого спринта: распределение story points по
capacity-бакетам, квартальный баланс и рекомендуемую ёмкость спринта по медиане velocity.

> Работает поверх веб-Jira (`*.atlassian.net`) под вашей сессией браузера — отдельный
> API-токен не нужен.

## Возможности

- **CAP-распределение по спринту** — stacked-bar под заголовком спринта: доли
  Product / Tech / Support / Unlabeled от размеченного объёма, маркер цели и подсветка
  значимого перекоса.
- **Квартальный баланс** — блок над списком спринтов: накопительный % Product за квартал
  (спринт относится к кварталу по дате старта), факт (только Done) vs план (Done + взятое в
  активный спринт), отклонение от цели-коридора и «долг» бакета.
- **Медиана velocity** — рекомендуемая ёмкость спринта по completed SP за последние N
  закрытых спринтов.
- **Кликабельная легенда** — фильтрует backlog через родной механизм меток Jira; отдельная
  подсветка задач без CAP-метки прямо на доске.
- Доска не зашита — `rapidViewId` берётся из URL; ручной override и цели задаются в Options.

## Стек

- **[WXT](https://wxt.dev)** 0.20 — фреймворк браузерных расширений (Vite-based, MV3).
- **Vue 3** + **Tailwind CSS v4** (через `@tailwindcss/vite`).
- **TypeScript** (strict) · **ESLint 9** (flat config) + **Prettier** · **Vitest**.
- **Yarn 4** (node-modules linker, не PnP).
- Целевой браузер: **Chrome (MV3)**; Firefox-сборка — одной командой при необходимости.

## Архитектура

Гибрид: тонкие entrypoints как корни композиции, вся логика — в слоях ниже (DDD-подобно).

```
src/
├─ entrypoints/        # точки входа расширения (тонкий wiring)
│  ├─ jira.content/    #   content script: монтаж виджетов на backlog + DOM-фильтр
│  ├─ background.ts    #   service worker
│  ├─ popup/ sidepanel/ options/
├─ core/               # чистые функции (тестируются без браузера)
│  ├─ domain/          #   модели + канон bucket↔label (единый источник истины)
│  └─ metrics/         #   cap-distribution, quarter-balance, median
├─ api/jira/           # Anti-Corruption Layer: greenhopper DTO → domain
│  ├─ client.ts endpoints.ts dto.ts mappers.ts index.ts
├─ shared/             # контракты между контекстами (storage, messaging)
└─ components/         # Vue-виджеты (CapBar, QuarterBar)
```

Принципы: расчёт — чистые функции в `core/` (без `chrome.*`/`fetch`/Vue); знание формы
Jira-ответа изолировано в `api/jira` (ACL); сеть к Jira идёт под сессией браузера; контракты
между UI и background — в `shared/`.

## Команды

```bash
yarn install        # установка (запустит wxt prepare)
yarn dev            # дев-сервер с HMR (Chrome)
yarn build          # production-сборка → .output/chrome-mv3
yarn zip            # упаковка для Chrome Web Store
yarn typecheck      # vue-tsc --noEmit
yarn lint           # ESLint
yarn test           # Vitest
```

## Установка распакованного расширения

1. `yarn build`
2. `chrome://extensions` → включить «Режим разработчика».
3. «Загрузить распакованное» → выбрать `.output/chrome-mv3`.

В режиме `yarn dev` WXT сам открывает браузер с подключённым расширением и HMR.

## Лицензия

[MIT](./LICENSE) © 2026 Valentin Kim
