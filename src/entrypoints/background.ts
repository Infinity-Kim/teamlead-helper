import { browser } from 'wxt/browser';
import { onMessage, TARGET, type JiraProxyResult } from '@/shared/messaging';

/** Вкладки Jira, через которые можно ходить в API с cookie сессии. */
const JIRA_TAB_MATCH = '*://*.atlassian.net/*';

/** Найти открытую вкладку Jira (любую). null — вкладок нет. */
async function findJiraTab(): Promise<number | null> {
  const tabs = await browser.tabs.query({ url: JIRA_TAB_MATCH });
  // Предпочитаем активную вкладку: её content-script точно жив (не выгружен из-за discard).
  const active = tabs.find((t) => t.active && typeof t.id === 'number');
  const any = tabs.find((t) => typeof t.id === 'number');
  return (active ?? any)?.id ?? null;
}

/**
 * GET к Jira руками пользователя: запрос исполняет content-script на вкладке Jira,
 * поэтому уходят cookie сессии SSO и токен не нужен.
 *
 * `__target` обязателен: сообщение получают все слушатели вкладки, и без адресата чужой
 * слушатель может ответить первым, перебив ответ нашего content-script.
 */
async function jiraFetchViaTab(path: string): Promise<JiraProxyResult> {
  const tabId = await findJiraTab();
  if (tabId === null) {
    return { ok: false, status: 0, error: 'no-jira-tab' };
  }
  try {
    const res = (await browser.tabs.sendMessage(tabId, {
      __target: TARGET.jiraTab,
      type: 'jiraFetch',
      path,
    })) as JiraProxyResult | undefined;
    // undefined = content-script ещё не поднялся на этой вкладке (Jira SPA грузится секунды).
    return res ?? { ok: false, status: 0, error: 'tab-not-ready' };
  } catch (e) {
    // Вкладка только открыта / выгружена из памяти — её скрипт не отвечает.
    return { ok: false, status: 0, error: `tab-unreachable: ${String(e)}` };
  }
}

/**
 * Готова ли вкладка Jira принимать запросы. Проверяем не «есть ли вкладка» (она появляется
 * мгновенно), а отвечает ли её content-script — иначе первый же запрос упадёт.
 *
 * Состояние НЕ кэшируем: MV3-воркер выгружается и теряет память («global variables are not
 * preserved between terminations»), поэтому опрашиваем вкладку по факту.
 */
async function probeJiraTab(): Promise<{ ready: boolean; present: boolean }> {
  const tabId = await findJiraTab();
  if (tabId === null) return { ready: false, present: false };
  const ready = await browser.tabs
    .sendMessage(tabId, { __target: TARGET.jiraTab, type: 'jiraPing' })
    .then((r) => (r as { ready?: boolean } | undefined)?.ready === true)
    .catch(() => false);
  return { ready, present: true };
}

// Слушатели регистрируются СИНХРОННО на верхнем уровне: MV3-воркер просыпается по событию,
// и обработчик, зарегистрированный позже (внутри async-инициализации), это событие пропустит.
browser.runtime.onInstalled.addListener(() => {
  // По клику на иконку открываем side panel (а не popup). Только Chromium — иначе игнорируем.
  void browser.sidePanel
    ?.setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.warn('[TLH] sidePanel.setPanelBehavior:', error));
});

// Мост сообщений. Сам background в Jira не ходит: у него нет cookie сессии. Запросы исполняет
// content-script на вкладке Jira, где живёт SSO-сессия пользователя.
onMessage((message) => {
  switch (message.type) {
    case 'ping':
      return { ok: true as const, ts: Date.now() };
    case 'jiraFetch':
      return jiraFetchViaTab(message.path);
    case 'jiraTabReady':
      return probeJiraTab();
  }
});

export default defineBackground(() => {
  // Точка входа WXT. Регистрация слушателей уже выполнена на верхнем уровне модуля —
  // здесь ничего делать не нужно, и это осознанно (см. комментарий выше).
});
