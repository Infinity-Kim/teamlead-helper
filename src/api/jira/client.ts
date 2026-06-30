import { JiraRequestError } from './errors';

/**
 * Низкоуровневый fetch к Jira через сессию браузера (credentials:'include').
 * Работает в content script на странице Jira: относительный путь /rest/... резолвится к Jira сам,
 * куки SSO-сессии применяются автоматически, токен не нужен. Слой: api/jira.
 */
export async function jiraGetJson<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'include',
    });
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
