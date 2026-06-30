import { browser } from 'wxt/browser';
import { onMessage } from '@/shared/messaging';

export default defineBackground(() => {
  // По клику на иконку расширения открываем side panel (а не popup).
  // setPanelBehavior доступен только в Chromium; в других браузерах — мягко игнорируем.
  browser.runtime.onInstalled.addListener(() => {
    void browser.sidePanel
      ?.setPanelBehavior({ openPanelOnActionClick: true })
      .catch((error) => console.warn('[TLH] sidePanel.setPanelBehavior:', error));
  });

  // Лёгкий мост сообщений. CAP-фича считается прямо в content script (через сессию браузера),
  // поэтому сетевых запросов к Jira здесь пока нет.
  onMessage(async (message) => {
    switch (message.type) {
      case 'ping':
        return { ok: true, ts: Date.now() };
    }
  });
});
