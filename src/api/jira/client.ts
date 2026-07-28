import { JiraRequestError } from './errors';

/**
 * Прогнать `items` через async `fn` с ограничением параллелизма `limit` — «промис-пул».
 * Нужен, чтобы не слать десятки одновременных запросов и не пробивать burst-лимит Jira
 * (100 GET/с на эндпоинт → 429). Порядок результатов соответствует порядку `items`.
 * Ошибка отдельного элемента НЕ роняет весь пул — она пробрасывается в его позицию
 * (вызывающий решает, как обработать). Слой: api/jira.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  /** Сколько воркеров сейчас реально в работе — чтобы гасить лишних при снижении лимита. */
  let active = 0;

  const worker = async () => {
    active++;
    while (next < items.length) {
      // Лимит мог упасть из-за 429 в другом воркере — тогда лишние завершаются, не добирая items.
      if (active > Math.min(limit, currentConcurrency()) && active > 1) break;
      const i = next++;
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i], i) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
    active--;
  };

  const pool = Math.max(1, Math.min(limit, currentConcurrency(), items.length));
  await Promise.all(Array.from({ length: pool }, worker));

  // Воркеры могли выйти досрочно (снижение лимита), оставив хвост необработанным — дожимаем
  // последовательно, чтобы ни один элемент не пропал молча.
  while (next < items.length) {
    const i = next++;
    try {
      results[i] = { status: 'fulfilled', value: await fn(items[i], i) };
    } catch (reason) {
      results[i] = { status: 'rejected', reason };
    }
  }
  return results;
}

/**
 * Ступени конкурентности: старт → после первого 429 → после второго.
 * Rate limit Jira Cloud считается PER-TENANT и PER-RESOURCE-PATH (не на пользователя и не на
 * способ авторизации) — то есть бюджет делится со всем трафиком тенанта по этому пути,
 * включая UI Jira у коллег. Единственный рычаг — снижать СВОЮ долю.
 * https://developer.atlassian.com/cloud/jira/platform/rate-limiting/
 */
const CONCURRENCY_STEPS = [5, 2, 1] as const;

/** Текущая ступень. Модульное состояние: живёт столько же, сколько страница. */
let concurrencyStep = 0;

/**
 * Разрешённая сейчас конкурентность. Снижается при 429 и НЕ восстанавливается до перезагрузки:
 * возврат к 5 сразу после успеха даёт пилу «429 → замедлились → успех → 429», потому что Jira
 * применяет лимиты окнами. Одностороннее понижение предсказуемее.
 */
export function currentConcurrency(): number {
  return CONCURRENCY_STEPS[concurrencyStep];
}

/** Сообщить ограничителю о 429 — понижает ступень (до минимальной). */
export function reportRateLimited(): void {
  concurrencyStep = Math.min(concurrencyStep + 1, CONCURRENCY_STEPS.length - 1);
}

/** Сброс ступени. Только для тестов — в проде конкурентность намеренно не восстанавливается. */
export function resetConcurrency(): void {
  concurrencyStep = 0;
}

/**
 * Учётные данные для прямого API-доступа (Basic auth) со страницы расширения.
 * Если заданы — fetch идёт на абсолютный `baseUrl` + заголовок Authorization (email:token),
 * что обходит SameSite-cookie ограничение extension-origin. Если null — старый режим:
 * относительный путь + credentials:'include' (работает в content-script на странице Jira).
 */
export interface JiraAuth {
  baseUrl: string;
  email: string;
  apiToken: string;
}

/** Активные креды процесса. Устанавливаются один раз при старте страницы (setJiraAuth). */
let activeAuth: JiraAuth | null = null;

/** Задать креды для прямого API-доступа (вызывать на extension-странице до запросов). */
export function setJiraAuth(auth: JiraAuth | null): void {
  activeAuth = auth;
}

/**
 * Транспорт «через вкладку Jira»: выполняет GET чужими руками (content-script на домене Jira,
 * cookie сессии SSO) и отдаёт распарсенный JSON. Позволяет работать БЕЗ API-токена.
 *
 * Ставится страницей расширения (она умеет слать сообщения в background); в самом api/jira
 * знания о messaging нет — только функция нужной формы. Инверсия зависимостей: слой api
 * не тянет за собой browser.runtime.
 */
export type JiraTabTransport = (path: string) => Promise<{
  ok: boolean;
  status: number;
  body?: string;
  error?: string;
}>;

let tabTransport: JiraTabTransport | null = null;

/** Включить фолбэк «через вкладку Jira». null — выключить. */
export function setJiraTabTransport(transport: JiraTabTransport | null): void {
  tabTransport = transport;
}

/** Есть ли хоть какой-то способ ходить в Jira (токен или вкладка). */
export function hasJiraAccess(): boolean {
  return activeAuth !== null || tabTransport !== null;
}

/** Собрать (url, headers) под текущий режим: Basic-auth абсолютный ИЛИ куки относительный. */
function buildRequest(path: string): { url: string; headers: HeadersInit; credentials: RequestCredentials } {
  if (activeAuth) {
    const token = btoa(`${activeAuth.email}:${activeAuth.apiToken}`);
    return {
      url: `${activeAuth.baseUrl.replace(/\/$/, '')}${path}`,
      headers: { Accept: 'application/json', Authorization: `Basic ${token}` },
      credentials: 'omit',
    };
  }
  return { url: path, headers: { Accept: 'application/json' }, credentials: 'include' };
}

/**
 * Низкоуровневый fetch к Jira. Два режима: (1) Basic-auth (email+token, абсолютный URL) — со
 * страницы расширения; (2) сессия браузера (credentials:'include', относительный путь) — в
 * content-script на странице Jira, куки SSO. Режим выбирается наличием setJiraAuth. Слой: api/jira.
 */
export async function jiraGetJson<T>(path: string): Promise<T> {
  // Нет токена, но есть вкладка Jira — идём через неё (cookie сессии вместо Basic auth).
  if (!activeAuth && tabTransport) {
    return jiraGetViaTab<T>(path);
  }

  const { url, headers, credentials } = buildRequest(path);
  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', headers, credentials });
  } catch (e) {
    throw new JiraRequestError({ kind: 'network', message: String(e) });
  }

  if (res.status === 401 || res.status === 403) {
    throw new JiraRequestError({ kind: 'unauthorized' });
  }
  if (res.status === 429) {
    // Понижаем конкурентность для ВСЕХ последующих пулов — не только для текущего запроса.
    reportRateLimited();
    const retry = Number(res.headers.get('Retry-After')) * 1000 || undefined;
    throw new JiraRequestError({ kind: 'rate-limited', retryAfterMs: retry });
  }
  if (res.status >= 500) {
    throw new JiraRequestError({ kind: 'server', status: res.status });
  }
  if (!res.ok) {
    throw new JiraRequestError({ kind: 'server', status: res.status });
  }

  try {
    return (await res.json()) as T;
  } catch (e) {
    throw new JiraRequestError({ kind: 'network', message: `bad json: ${e}` });
  }
}

/**
 * GET через вкладку Jira. Коды ответа трактуем так же, как в прямом режиме, чтобы
 * вызывающий не различал транспорты. Отсутствие вкладки — терминальная ошибка
 * (`not-configured`): ретраить бессмысленно, пользователю нужно открыть Jira.
 */
async function jiraGetViaTab<T>(path: string): Promise<T> {
  const res = await tabTransport!(path);

  if (!res.ok && res.status === 0) {
    throw new JiraRequestError({ kind: 'not-configured' });
  }
  if (res.status === 401 || res.status === 403) {
    throw new JiraRequestError({ kind: 'unauthorized' });
  }
  if (res.status === 429) {
    reportRateLimited();
    throw new JiraRequestError({ kind: 'rate-limited' });
  }
  if (!res.ok) {
    throw new JiraRequestError({ kind: 'server', status: res.status });
  }
  try {
    return JSON.parse(res.body ?? '') as T;
  } catch (e) {
    throw new JiraRequestError({ kind: 'network', message: `bad json: ${e}` });
  }
}

/** Ошибку НЕ имеет смысла ретраить (повтор ничего не изменит). */
function isTerminal(e: unknown): boolean {
  return (
    e instanceof JiraRequestError &&
    (e.error.kind === 'unauthorized' || e.error.kind === 'not-configured')
  );
}

/**
 * Задержка перед попыткой `attempt` (1-based) — по best practices Atlassian:
 *  - при 429 уважаем Retry-After (retryAfterMs из ошибки), если он больше расчётного;
 *  - иначе экспонента base·2^(attempt-1);
 *  - плюс jitter ×[0.7..1.3], чтобы параллельные запросы не ретраились «стадом».
 * https://developer.atlassian.com/cloud/jira/platform/rate-limiting/
 */
export function retryDelayMs(attempt: number, err: unknown, baseMs = 300): number {
  const expo = baseMs * 2 ** (attempt - 1);
  const retryAfter =
    err instanceof JiraRequestError && err.error.kind === 'rate-limited'
      ? (err.error.retryAfterMs ?? 0)
      : 0;
  const target = Math.max(expo, retryAfter);
  const jitter = 0.7 + Math.random() * 0.6;
  return Math.round(target * jitter);
}

/**
 * jiraGetJson с ретраями и экспоненциальным backoff + jitter, уважающими Retry-After.
 * Terminal-ошибки (401/403, not-configured) НЕ ретраятся — повтор бесполезен и лишь бьёт по лимиту.
 * При множественных запросах истории спринтов Jira спорадически отдаёт 429 (burst-лимит 100 GET/с) —
 * ретрай не даёт спринтам «пропасть» из-за случайного 429.
 */
export async function jiraGetJsonRetry<T>(path: string, attempts = 4): Promise<T> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await jiraGetJson<T>(path);
    } catch (e) {
      lastErr = e;
      if (isTerminal(e) || i === attempts) break;
      await new Promise((r) => setTimeout(r, retryDelayMs(i, e)));
    }
  }
  throw lastErr;
}
