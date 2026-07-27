import { browser } from 'wxt/browser';
import { onMessage, type JiraProxyResult } from '@/shared/messaging';

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
 */
async function jiraFetchViaTab(path: string): Promise<JiraProxyResult> {
  const tabId = await findJiraTab();
  if (tabId === null) {
    return { ok: false, status: 0, error: 'no-jira-tab' };
  }
  try {
    return (await browser.tabs.sendMessage(tabId, {
      type: 'jiraFetch',
      path,
    })) as JiraProxyResult;
  } catch (e) {
    // Content-script мог не успеть подняться (вкладка только открыта) или быть выгружен.
    return { ok: false, status: 0, error: `tab-unreachable: ${String(e)}` };
  }
}

export default defineBackground(() => {
  // По клику на иконку расширения открываем side panel (а не popup).
  // setPanelBehavior доступен только в Chromium; в других браузерах — мягко игнорируем.
  browser.runtime.onInstalled.addListener(() => {
    void browser.sidePanel
      ?.setPanelBehavior({ openPanelOnActionClick: true })
      .catch((error) => console.warn('[TLH] sidePanel.setPanelBehavior:', error));
  });

  // Мост сообщений. Сам background в Jira не ходит: у него нет cookie сессии, а токен —
  // не единственный способ авторизации. Запросы исполняет content-script на вкладке Jira.
  onMessage(async (message) => {
    switch (message.type) {
      case 'ping':
        return { ok: true, ts: Date.now() };
      case 'jiraFetch':
        return jiraFetchViaTab(message.path);
      case 'jiraTabPresent':
        return { present: (await findJiraTab()) !== null };
    }
  });
});
