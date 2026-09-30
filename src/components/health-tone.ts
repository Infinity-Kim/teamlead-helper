import type { CSSProperties } from 'vue';
import type { HealthColors } from '@/core/metrics';

/** Уровень здоровья, у которого есть цвет (no-data / insufficient-history — серые). */
export type HealthLevel = keyof HealthColors;

/**
 * Стиль элемента, окрашенного цветом уровня: рамка — сам цвет, фон — тот же цвет с
 * прозрачностью. Смешивание с transparent, а не с белым: подложка просвечивает, и один и тот же
 * цвет одинаково работает в светлой и тёмной теме. Текст остаётся нейтральным — так читается
 * любой цвет, который выберут в настройках (жёлтый текст на белом не читается).
 */
export function levelStyle(color: string, fill = 22): CSSProperties {
  return {
    backgroundColor: `color-mix(in srgb, ${color} ${fill}%, transparent)`,
    borderColor: color,
  };
}
