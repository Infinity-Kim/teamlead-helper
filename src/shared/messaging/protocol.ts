import { browser, type Browser } from 'wxt/browser';

/**
 * Контракт сообщений UI ↔ background. ЕДИНЫЙ источник истины для всех контекстов
 * (popup/sidepanel/options/content импортируют отсюда).
 *
 * Архитектура: в MV3 сетевые запросы к Jira идут через background (там токен и обход CORS).
 * UI-контексты шлют типизированное сообщение, background выполняет и возвращает результат.
 * Контракт — discriminated union по `type`, поэтому и отправитель, и обработчик типизированы.
 *
 * Слой: shared/ (FSD) — стабильный контракт, от которого зависят и UI, и background,
 * но не друг от друга напрямую (Dependency Inversion).
 */

/** Сообщения, которые UI отправляет в background. */
export type AppMessage = { type: 'ping' };

/** Ответы background на каждое сообщение (сопоставлены по type). */
export interface AppResponseMap {
  ping: { ok: true; ts: number };
}

type MessageType = AppMessage['type'];
type MessageOf<T extends MessageType> = Extract<AppMessage, { type: T }>;

/** Отправить сообщение в background и получить типизированный ответ. */
export async function sendMessage<T extends MessageType>(
  type: T,
  ...[message]: MessageOf<T> extends { type: T }
    ? [Omit<MessageOf<T>, 'type'>?]
    : [Omit<MessageOf<T>, 'type'>]
): Promise<AppResponseMap[T]> {
  const payload = { type, ...message } as MessageOf<T>;
  return browser.runtime.sendMessage(payload) as Promise<AppResponseMap[T]>;
}

/** Обработчик сообщений (регистрируется в background). */
export type MessageHandler = (
  message: AppMessage,
  sender: Browser.runtime.MessageSender,
) => Promise<AppResponseMap[MessageType]> | void;

/** Зарегистрировать единый обработчик входящих сообщений в background. */
export function onMessage(handler: MessageHandler): void {
  browser.runtime.onMessage.addListener(
    (
      message: AppMessage,
      sender: Browser.runtime.MessageSender,
      sendResponse: (r: unknown) => void,
    ) => {
      const result = handler(message, sender);
      if (result instanceof Promise) {
        result.then(sendResponse);
        return true; // держим канал открытым для асинхронного ответа
      }
      return false;
    },
  );
}
