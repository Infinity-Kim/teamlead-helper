/**
 * Типизированные ошибки Jira-клиента (discriminated union, не throw строк).
 * Слой: api/jira.
 */

export type JiraError =
  | { kind: 'unauthorized' } // 401/403 — токен невалиден
  | { kind: 'rate-limited'; retryAfterMs?: number } // 429
  | { kind: 'server'; status: number } // 5xx
  | { kind: 'network'; message: string }
  | { kind: 'not-configured' }; // baseUrl/токен не заданы

export class JiraRequestError extends Error {
  constructor(readonly error: JiraError) {
    super(`Jira request failed: ${error.kind}`);
    this.name = 'JiraRequestError';
  }
}
