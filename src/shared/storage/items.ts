import { storage } from 'wxt/utils/storage';
import { DEFAULT_CAP_TARGETS, type CapTargets, type SprintReportDetail } from '@/core/domain';

/**
 * Типобезопасный слой хранилища расширения — ЕДИНЫЙ источник истины для persisted-state.
 *
 * В MV3 popup/sidepanel/options — это разные JS-контексты, а background-SW засыпает и теряет
 * in-memory состояние. Поэтому всё, что должно переживать закрытие UI / сон SW и быть видимым
 * во всех контекстах, живёт ТОЛЬКО в chrome.storage. `item.watch()` (поверх storage.onChanged)
 * срабатывает во всех контекстах — это встроенный cross-context реактивный источник правды.
 *
 * Каждый ключ обязан иметь префикс области: local: / sync: / session: / managed:.
 * Слой: shared/ (FSD).
 */

/** Целевое распределение SP по CAP-бакетам (%). Настраивается в options. sync — общая настройка. */
export const capTargets = storage.defineItem<CapTargets>('sync:capTargets', {
  fallback: DEFAULT_CAP_TARGETS,
});

/** Конфигурация доски, для которой считаем CAP-распределение. */
export interface BoardConfig {
  /** rapidViewId доски (ELCAS board = 80). */
  rapidViewId: number;
}

/** Текущая отслеживаемая доска. sync — общая настройка. */
export const boardConfig = storage.defineItem<BoardConfig>('sync:boardConfig', {
  fallback: { rapidViewId: 80 },
});

/**
 * Учётные данные Jira для прямого API-доступа со страницы расширения (Basic auth:
 * email + API-token). Позволяет fetch к Jira с extension-origin, минуя SameSite-cookie
 * ограничение (не нужен content-script/открытая вкладка Jira). Токен создаётся на
 * id.atlassian.com/manage-profile/security/api-tokens. local: — не синхронизируем секрет.
 * ПУСТО по умолчанию — вводится в options. НИКОГДА не хардкодить в код.
 */
export interface JiraCreds {
  baseUrl: string; // https://tvbet.atlassian.net
  email: string;
  apiToken: string;
}
export const jiraCreds = storage.defineItem<JiraCreds | null>('local:jiraCreds', {
  fallback: null,
});

/** Доски команд для sprint-отчёта (El Casino / POC / Web). Порядок = порядок в UI. */
export const TEAM_BOARDS: ReadonlyArray<{ team: string; rapidViewId: number }> = [
  { team: 'El Casino', rapidViewId: 80 },
  { team: 'POC', rapidViewId: 1178 },
  { team: 'Web', rapidViewId: 16 },
];

/**
 * Кэш детальных sprint-отчётов по командам (для страницы sprint-report).
 * local: — данные объёмные (списки задач), не для sync. Пишет content-script на Jira
 * (там куки сессии работают), читает страница sprint-report. `updatedAt` — свежесть кэша.
 */
export interface SprintReportsCache {
  updatedAt: number; // Date.now()
  boards: Array<{
    team: string;
    rapidViewId: number;
    sprints: SprintReportDetail[];
  }>;
}
export const sprintReportsCache = storage.defineItem<SprintReportsCache | null>(
  'local:sprintReportsCache',
  { fallback: null },
);

/** Сколько последних закрытых спринтов брать для медианы velocity (рекомендуемый capacity). */
export const sprintHistoryCount = storage.defineItem<number>('sync:sprintHistoryCount', {
  fallback: 6,
});

/** Целевой % Product на КВАРТАЛ (остальное = 100−product) + полуширина коридора (пп). */
export interface QuarterTargetConfig {
  productPct: number;
  bandPp: number;
}
export const quarterTarget = storage.defineItem<QuarterTargetConfig>('sync:quarterTarget', {
  fallback: { productPct: 67, bandPp: 5 },
});

/** Где показывать квартальный баланс на доске. */
export type QuarterUiMode = 'topBoard' | 'perSprint' | 'off';
export const quarterUiMode = storage.defineItem<QuarterUiMode>('sync:quarterUiMode', {
  fallback: 'topBoard',
});

/** Тема интерфейса расширения. sync — можно безопасно синхронизировать. */
export type ThemePreference = 'system' | 'light' | 'dark';
export const themePreference = storage.defineItem<ThemePreference>('sync:themePreference', {
  fallback: 'system',
});

/**
 * Статусы «реальной работы» и «завершено» для Work Item Age / cycle time.
 * Возраст считается от ПЕРВОГО входа в workStatuses (очередь типа Ready for DEV НЕ входит).
 * Дефолт — под ELCAS доску 80 (recon 2026-07-08; смешаны рус/англ имена статусов).
 */
export interface StatusConfig {
  workStatuses: string[];
  doneStatuses: string[];
}
export const statusConfig = storage.defineItem<StatusConfig>('sync:statusConfig', {
  fallback: {
    workStatuses: ['DEV', 'В работе', 'In Progress', 'In Development'],
    doneStatuses: ['Готово', 'Done', 'DoD/Release', 'Closed'],
  },
});
