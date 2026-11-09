import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { readChangelogCache, writeChangelogCache } from './changelog-cache';
import { changelogCache, CHANGELOG_CACHE_LIMIT } from './items';

beforeEach(() => fakeBrowser.reset());

describe('changelog-cache - история статусов закрытых задач', () => {
  it('пишет и читает переходы по ключу задачи, дописывает к старым', async () => {
    await writeChangelogCache(new Map([['A-1', [{ at: '2026-09-01T08:00:00Z', to: 'DEV' }]]]));
    await writeChangelogCache(new Map([['A-2', [{ at: '2026-09-02T08:00:00Z', to: 'Done' }]]]));
    const m = await readChangelogCache();
    expect(m.get('A-1')).toEqual([{ at: '2026-09-01T08:00:00Z', to: 'DEV' }]);
    expect(m.get('A-2')).toEqual([{ at: '2026-09-02T08:00:00Z', to: 'Done' }]);
  });

  it('при переполнении вытесняет самые давно закэшированные', async () => {
    const old = Object.fromEntries(
      Array.from({ length: CHANGELOG_CACHE_LIMIT }, (_, i) => [
        `O-${i}`,
        { transitions: [], cachedAt: i },
      ]),
    );
    await changelogCache.setValue(old);
    await writeChangelogCache(new Map([['N-1', []]]));
    const m = await readChangelogCache();
    expect(m.size).toBe(CHANGELOG_CACHE_LIMIT);
    expect(m.has('N-1')).toBe(true);
    expect(m.has('O-0')).toBe(false);
  });
});
