/**
 * Медиана набора чисел. Чистая функция (тестируется без браузера).
 * Слой: core/metrics (DDD Domain Service).
 */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
