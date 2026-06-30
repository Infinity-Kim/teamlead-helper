import { storage } from 'wxt/utils/storage';
import { DEFAULT_CAP_TARGETS, type CapTargets } from '@/core/domain';

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
