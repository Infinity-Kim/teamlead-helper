import { storage } from 'wxt/utils/storage';
import {
  DEFAULT_CAP_TARGETS,
  DEFAULT_DIVISIONS,
  DEFAULT_TEAMS,
  type CapTargets,
  type Division,
  type SprintReportDetail,
  type TeamBoard,
} from '@/core/domain';
import {
  DEFAULT_HEALTH_COLORS,
  DEFAULT_HEALTH_SETTINGS,
  type HealthColors,
  type HealthSettings,
} from '@/core/metrics';

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

/**
 * Команды (доски) для отчёта по спринтам. Порядок = порядок вкладок в отчёте.
 * Дефолт — El Casino / POC / Web; пользователь может выключить их и добавить свои по ссылке
 * на доску. sync — это общая настройка, а не данные.
 */
export const teams = storage.defineItem<TeamBoard[]>('sync:teams', {
  fallback: DEFAULT_TEAMS.map((t) => ({ ...t })),
});

/** Дивизионы — группы команд для общей квартальной сводки. По умолчанию только Games. */
export const divisions = storage.defineItem<Division[]>('sync:divisions', {
  fallback: DEFAULT_DIVISIONS.map((d) => ({ ...d, teamIds: [...d.teamIds] })),
});

/**
 * Кэш детальных sprint-отчётов, ПО СПРИНТАМ (не по доскам) и БЕЗ TTL.
 *
 * Состав закрытого спринта неизменен — его отчёт можно держать вечно, поэтому кэшируем поштучно.
 * Метки и оценки задач правят и после закрытия — их подтягивает кнопка «Обновить» в отчёте:
 * при открытии страницы догружаются только новые спринты (1–2 раз в две недели) вместо
 * всех 83 закрытых спринтов доски. Частично добытые данные тоже сохраняются — упавший
 * из-за rate-limit спринт дотянется в следующий раз, а не потеряется.
 *
 * Ключ — sprintId (глобально уникален в Jira), поэтому разделения по доскам не требуется.
 * local: — данные объёмные (списки задач), не для sync.
 */
export interface SprintReportCacheEntry {
  detail: SprintReportDetail;
  /** Когда положили — для вытеснения самых старых при переполнении. */
  cachedAt: number;
}
export const sprintReportCache = storage.defineItem<Record<string, SprintReportCacheEntry>>(
  'local:sprintReportCache',
  { fallback: {} },
);

/**
 * Максимум спринтов в кэше. ~8 кварталов × 6 спринтов × 3 команды ≈ 144, берём с запасом.
 * При переполнении вытесняются самые давно закэшированные (chrome.storage.local ~10 МБ).
 */
export const SPRINT_CACHE_LIMIT = 200;

/**
 * Кэш СПИСКА спринтов доски (Agile API) — с TTL, в отличие от отчётов: список меняется
 * при каждом закрытии спринта, а сами отчёты закрытых спринтов — никогда.
 */
export interface SprintListCacheEntry {
  updatedAt: number;
  /** Сырые спринты Agile API: id + даты. Хватает, чтобы решить, что догружать. */
  sprints: Array<{ id: number; name: string; startDate?: string }>;
}
export const sprintListCache = storage.defineItem<Record<string, SprintListCacheEntry>>(
  'local:sprintListCache',
  { fallback: {} },
);

/** Свежесть списка спринтов. Спринты закрываются раз в 2 недели — 15 минут с запасом. */
export const SPRINT_LIST_TTL_MS = 15 * 60 * 1000;

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

/**
 * Пороги правил «здоровья спринта». Настраиваются в options, а не захардкожены: пороги —
 * это командная договорённость, а не физическая константа, и у ELCAS/POC/Web они могут
 * отличаться. Хардкод сделал бы метрику неоспоримой, что для планировочного (а не
 * отчётного) инструмента вредно — команда должна иметь возможность обсудить и сдвинуть порог.
 *
 * Для каждого правила два порога: первый красит чип в жёлтый, второй — в красный (issue #18).
 * Дефолты — DEFAULT_HEALTH_SETTINGS. Значения, сохранённые до v0.6 (без вторых порогов),
 * читать через `withHealthDefaults` / `toThresholds` — они дополнят недостающее дефолтами.
 */
export type SprintHealthThresholds = HealthSettings;
export const sprintHealthThresholds = storage.defineItem<SprintHealthThresholds>(
  'sync:sprintHealthThresholds',
  { fallback: { ...DEFAULT_HEALTH_SETTINGS } },
);

/**
 * Цвета уровней здоровья спринта (зелёный / жёлтый / красный), настраиваются в options.
 * Читать через `withHealthColorDefaults` — дополнит отсутствующие и отбросит битые значения.
 */
export const sprintHealthColors = storage.defineItem<HealthColors>('sync:sprintHealthColors', {
  fallback: { ...DEFAULT_HEALTH_COLORS },
});
