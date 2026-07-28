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

/**
 * Результат запроса к Jira через сессию браузера.
 * `status: 0` — запрос не дошёл (нет вкладки Jira / сеть), тело в `error`.
 */
export interface JiraProxyResult {
  ok: boolean;
  status: number;
  /** Тело ответа как текст (парсится вызывающим — background не знает про доменные типы). */
  body?: string;
  error?: string;
}

/**
 * Кому адресовано сообщение. В MV3 одно `runtime.sendMessage` получают ВСЕ слушатели
 * расширения, а «only the first listener to respond… will affect the sender» — то есть
 * лишний слушатель, ответивший первым, крадёт ответ у настоящего адресата
 * (https://developer.chrome.com/docs/extensions/develop/concepts/messaging).
 *
 * Поэтому у каждого сообщения есть явный адресат, и каждый слушатель молча пропускает чужое.
 * Это же снимает запрет «avoid multiple onMessage listeners for the same type».
 */
export const TARGET = {
  background: 'bg',
  jiraTab: 'jira-tab',
} as const;
export type Target = (typeof TARGET)[keyof typeof TARGET];

/** Сообщения, которые UI отправляет в background. */
export type AppMessage =
  | { type: 'ping' }
  /**
   * Выполнить GET к Jira ЧЕРЕЗ ОТКРЫТУЮ ВКЛАДКУ Jira (cookie сессии SSO).
   * Нужен, когда пользователь не заводил API-токен: страница расширения живёт на
   * chrome-extension://, её fetch куки Jira не отправляет, а content-script на вкладке Jira —
   * отправляет. `path` — относительный путь вида /rest/agile/1.0/...
   */
  | { type: 'jiraFetch'; path: string }
  /**
   * Готова ли вкладка Jira принимать запросы: не просто открыта, а её content-script отвечает.
   * Jira SPA поднимается секунды, поэтому «вкладка есть» ≠ «через неё можно ходить».
   */
  | { type: 'jiraTabReady' };

/** Ответы background на каждое сообщение (сопоставлены по type). */
export interface AppResponseMap {
  ping: { ok: true; ts: number };
  jiraFetch: JiraProxyResult;
  /** `ready` — content-script вкладки отвечает; `present` — вкладка хотя бы открыта. */
  jiraTabReady: { ready: boolean; present: boolean };
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
  // Адресат в конверте: без него content-script на вкладке Jira перехватывал бы сообщения,
  // предназначенные background, и отправитель получал бы null.
  const payload = { __target: TARGET.background, type, ...message } as unknown as MessageOf<T>;
  const res = (await browser.runtime.sendMessage(payload)) as AppResponseMap[T] | undefined;
  if (res === undefined || res === null) {
    // Пустой ответ = обработчик не отработал. Молчать нельзя: вызывающий деструктурирует ответ.
    throw new Error(`Сообщение «${type}» осталось без ответа от background.`);
  }
  return res;
}

/** Обработчик сообщений (регистрируется в background). */
export type MessageHandler = (
  message: AppMessage,
  sender: Browser.runtime.MessageSender,
) => AppResponseMap[MessageType] | Promise<AppResponseMap[MessageType]> | void;

/**
 * Зарегистрировать ЕДИНЫЙ обработчик сообщений background.
 *
 * Вызывать СИНХРОННО на верхнем уровне модуля: MV3-воркер просыпается по событию, и если
 * слушатель ещё не зарегистрирован (например, регистрация ждала await), событие теряется —
 * отправитель получает «Receiving end does not exist».
 */
export function onMessage(handler: MessageHandler): void {
  browser.runtime.onMessage.addListener(
    (
      message: AppMessage & { __target?: Target },
      sender: Browser.runtime.MessageSender,
      sendResponse: (r: unknown) => void,
    ) => {
      // Не наше — не трогаем канал вообще, иначе украдём ответ у настоящего адресата.
      if (message?.__target !== TARGET.background) return false;

      // `return true` обязан быть в СИНХРОННОМ теле слушателя (Chrome читает результат сразу,
      // до разрешения промиса) — поэтому сначала запускаем работу, а возвращаем true в конце.
      void Promise.resolve(handler(message, sender)).then(sendResponse);
      return true;
    },
  );
}
