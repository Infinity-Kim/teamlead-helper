import type { StatusTransition } from '@/core/metrics';
import { changelogCache, CHANGELOG_CACHE_LIMIT } from './items';

/** История статусов закрытых задач из постоянного кэша: ключ задачи → переходы. */
export async function readChangelogCache(): Promise<Map<string, StatusTransition[]>> {
  const cache = await changelogCache.getValue();
  const out = new Map<string, StatusTransition[]>();
  for (const [key, entry] of Object.entries(cache ?? {})) {
    if (Array.isArray(entry?.transitions)) out.set(key, entry.transitions);
  }
  return out;
}

/**
 * Дописать историю новых закрытых задач, вытеснив самые старые при переполнении.
 * Кэш читаем заново перед записью: его же пишут отчёт по спринтам и виджет на доске.
 */
export async function writeChangelogCache(
  fetched: ReadonlyMap<string, readonly StatusTransition[]>,
): Promise<void> {
  if (fetched.size === 0) return;
  const cache = { ...(await changelogCache.getValue()) };
  const now = Date.now();
  for (const [key, transitions] of fetched) {
    cache[key] = { transitions: transitions.map((t) => ({ at: t.at, to: t.to })), cachedAt: now };
  }
  const entries = Object.entries(cache);
  if (entries.length > CHANGELOG_CACHE_LIMIT) {
    entries.sort((a, b) => b[1].cachedAt - a[1].cachedAt);
    await changelogCache.setValue(Object.fromEntries(entries.slice(0, CHANGELOG_CACHE_LIMIT)));
    return;
  }
  await changelogCache.setValue(cache);
}
