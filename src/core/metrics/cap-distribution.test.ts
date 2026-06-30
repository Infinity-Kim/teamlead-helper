import { describe, it, expect } from 'vitest';
import { calcCapDistribution, issuesOfSprint, issueKeysByBucket } from './cap-distribution';
import type { BacklogIssue } from '@/core/domain';

// Хелпер для краткости.
const issue = (p: Partial<BacklogIssue>): BacklogIssue => ({
  id: p.id ?? 1,
  key: p.key ?? 'X-1',
  storyPoints: p.storyPoints ?? 0,
  capBuckets: p.capBuckets ?? [],
  sprintIds: p.sprintIds ?? [],
  hierarchyLevel: p.hierarchyLevel ?? 0,
});

describe('issuesOfSprint', () => {
  const issues = [
    issue({ id: 1, sprintIds: [8173], hierarchyLevel: 0 }),
    issue({ id: 2, sprintIds: [8173], hierarchyLevel: 1 }), // подзадача — отбрасываем
    issue({ id: 3, sprintIds: [9999], hierarchyLevel: 0 }), // другой спринт
    issue({ id: 4, sprintIds: [], hierarchyLevel: 0 }), // backlog
  ];

  it('берёт только верхний уровень нужного спринта', () => {
    expect(issuesOfSprint(issues, 8173).map((i) => i.id)).toEqual([1]);
  });

  it('sprintId=null → задачи общего backlog (без спринта)', () => {
    expect(issuesOfSprint(issues, null).map((i) => i.id)).toEqual([4]);
  });
});

describe('calcCapDistribution — реальный спринт ELCAS-26.6.2', () => {
  // Воспроизводим итог исследования: Product 65, Support 15, Tech 2, Unlabeled 1 = 83 SP.
  const issues: BacklogIssue[] = [
    issue({ id: 1, storyPoints: 65, capBuckets: ['Product'] }),
    issue({ id: 2, storyPoints: 15, capBuckets: ['Support'] }),
    issue({ id: 3, storyPoints: 2, capBuckets: ['Tech'] }),
    issue({ id: 4, storyPoints: 1, capBuckets: [] }),
  ];
  const stats = calcCapDistribution({ id: 8173, name: 'ELCAS-26.6.2' }, issues);

  it('считает общий объём', () => {
    expect(stats.totalPoints).toBe(83);
    expect(stats.issueCount).toBe(4);
  });

  it('Product = 78.3%', () => {
    const product = stats.buckets.find((b) => b.bucket === 'Product')!;
    expect(product.points).toBe(65);
    expect(product.pct).toBe(78.3);
    expect(product.deltaPp).toBe(+(78.3 - 67).toFixed(1)); // +11.3 pp от цели 67
  });

  it('топовый перекос — сильнейший отрыв от цели по модулю (Tech недобран на 14.1pp)', () => {
    // Product перебран на +11.3, но Tech недобран на −14.1 (цель 16.5, факт 2.4) — это сильнее.
    expect(stats.topSkew).toEqual({ bucket: 'Tech', deltaPp: -14.1 });
  });

  it('Unlabeled не имеет дельты от цели', () => {
    const un = stats.buckets.find((b) => b.bucket === 'Unlabeled')!;
    expect(un.deltaPp).toBeNull();
    expect(un.pct).toBe(1.2);
  });
});

describe('calcCapDistribution — edge cases', () => {
  it('мультилейбловая задача делит SP поровну', () => {
    const stats = calcCapDistribution({ id: 1, name: 'S' }, [
      issue({ storyPoints: 10, capBuckets: ['Product', 'Tech'] }),
    ]);
    expect(stats.buckets.find((b) => b.bucket === 'Product')!.points).toBe(5);
    expect(stats.buckets.find((b) => b.bucket === 'Tech')!.points).toBe(5);
  });

  it('пустой спринт не делит на ноль', () => {
    const stats = calcCapDistribution({ id: 1, name: 'S' }, []);
    expect(stats.totalPoints).toBe(0);
    expect(stats.buckets.every((b) => b.pct === 0)).toBe(true);
    expect(stats.topSkew).toBeNull();
  });

  it('идеальное распределение не даёт перекоса', () => {
    const stats = calcCapDistribution({ id: 1, name: 'S' }, [
      issue({ id: 1, storyPoints: 67, capBuckets: ['Product'] }),
      issue({ id: 2, storyPoints: 16.5, capBuckets: ['Tech'] }),
      issue({ id: 3, storyPoints: 16.5, capBuckets: ['Support'] }),
    ]);
    expect(stats.topSkew).toBeNull();
  });

  it('весь объём Unlabeled → нет ложного перекоса (сигнал «нет разметки», не недобор)', () => {
    // Есть SP, но НИЧЕГО не размечено. Без guard это дало бы «Product −67pp».
    const stats = calcCapDistribution({ id: 1, name: 'S' }, [
      issue({ id: 1, storyPoints: 30, capBuckets: [] }),
      issue({ id: 2, storyPoints: 20, capBuckets: [] }),
    ]);
    expect(stats.totalPoints).toBe(50);
    expect(stats.topSkew).toBeNull();
    expect(stats.buckets.find((b) => b.bucket === 'Unlabeled')!.pct).toBe(100);
  });
});

describe('issueKeysByBucket', () => {
  it('группирует ключи по бакетам, без лейбла → Unlabeled', () => {
    const map = issueKeysByBucket([
      issue({ key: 'A-1', capBuckets: ['Product'] }),
      issue({ key: 'A-2', capBuckets: ['Support'] }),
      issue({ key: 'A-3', capBuckets: [] }),
    ]);
    expect(map.Product).toEqual(['A-1']);
    expect(map.Support).toEqual(['A-2']);
    expect(map.Unlabeled).toEqual(['A-3']);
    expect(map.Tech).toEqual([]);
  });

  it('мультибакетная задача попадает в оба', () => {
    const map = issueKeysByBucket([issue({ key: 'A-1', capBuckets: ['Product', 'Tech'] })]);
    expect(map.Product).toContain('A-1');
    expect(map.Tech).toContain('A-1');
  });
});
