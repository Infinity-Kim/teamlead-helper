import type { SprintReportDetail } from '@/core/domain';
import { sprintReportCache, SPRINT_CACHE_LIMIT } from './items';

/**
 * Отчёты закрытых спринтов из persist-кеша. Без TTL: состав спринта после закрытия не меняется,
 * а метки/оценки, поправленные позже, подтягивает кнопка «Обновить».
 */
export async function readSprintCache(): Promise<Map<number, SprintReportDetail>> {
  const cache = await sprintReportCache.getValue();
  const out = new Map<number, SprintReportDetail>();
  for (const [id, entry] of Object.entries(cache ?? {})) {
    // addedIssueKeys — Set, а JSON его не переживает: восстанавливаем из массива.
    out.set(Number(id), reviveDetail(entry.detail));
  }
  return out;
}

/**
 * chrome.storage сериализует через JSON, поэтому Set превращается в {} — восстанавливаем.
 * Без этого правило reestimate перестало бы исключать добавленные задачи (двойной счёт).
 */
function reviveDetail(d: SprintReportDetail): SprintReportDetail {
  const keys = d.addedIssueKeys;
  return {
    ...d,
    addedIssueKeys: keys instanceof Set ? keys : new Set(Array.isArray(keys) ? keys : []),
  };
}

/**
 * Дописать свежедобытые отчёты в кеш, вытеснив самые старые при переполнении.
 * Пишем ДАЖЕ при частичной загрузке — иначе упавший спринт пришлось бы тянуть каждый раз заново.
 */
export async function writeSprintCache(fetched: ReadonlyMap<number, SprintReportDetail>) {
  if (fetched.size === 0) return;
  const cache = { ...(await sprintReportCache.getValue()) };
  const now = Date.now();
  for (const [id, detail] of fetched) {
    // Set не сериализуется в chrome.storage — кладём массивом, обратно поднимаем в reviveDetail.
    cache[String(id)] = {
      detail: { ...detail, addedIssueKeys: [...detail.addedIssueKeys] as unknown as Set<string> },
      cachedAt: now,
    };
  }
  const entries = Object.entries(cache);
  if (entries.length > SPRINT_CACHE_LIMIT) {
    entries.sort((a, b) => b[1].cachedAt - a[1].cachedAt);
    await sprintReportCache.setValue(Object.fromEntries(entries.slice(0, SPRINT_CACHE_LIMIT)));
    return;
  }
  await sprintReportCache.setValue(cache);
}
