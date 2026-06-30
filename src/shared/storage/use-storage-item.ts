import { ref, onScopeDispose, type Ref } from 'vue';
import type { WxtStorageItem } from 'wxt/utils/storage';

/**
 * Реактивная обёртка над storage-item: даёт Vue-`ref`, который автоматически
 * синхронизируется с chrome.storage ВО ВСЕХ контекстах через item.watch().
 *
 * Это и есть наш cross-context "single source of truth" вместо Pinia: меняем значение
 * в options — sidepanel/popup увидят его мгновенно (storage.onChanged срабатывает везде).
 *
 * Использование:
 *   const theme = useStorageItem(themePreference)  // Ref<ThemePreference>, реактивный
 */
export function useStorageItem<T>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  item: WxtStorageItem<T, any>,
): Ref<T> {
  const state = ref(item.fallback) as Ref<T>;

  void item.getValue().then((v) => {
    state.value = v;
  });

  const unwatch = item.watch((v) => {
    state.value = v;
  });
  onScopeDispose(unwatch);

  return state;
}
