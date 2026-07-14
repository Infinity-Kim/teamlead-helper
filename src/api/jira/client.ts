import { JiraRequestError } from './errors';

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

/**
 * jiraGetJson с ретраями. При множественных параллельных запросах (история спринтов) Jira
 * спорадически роняет один (rate limit / нагрузка) → без ретрая баланс считается по неполному набору.
 */
export async function jiraGetJsonRetry<T>(path: string, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await jiraGetJson<T>(path);
    } catch (e) {
      lastErr = e;
      // небольшой backoff перед повтором
      await new Promise((r) => setTimeout(r, 200 * (i + 1)));
    }
  }
  throw lastErr;
}
