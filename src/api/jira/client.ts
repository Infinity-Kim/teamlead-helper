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
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i], i) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  };
  const pool = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: pool }, worker));
  return results;
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
