import { describe, it, expect } from 'vitest';
import { firstWorkStart } from './status-transitions';

// Рабочие статусы ELCAS доски 80 (реальные, из recon 2026-07-08).
const WORK = ['DEV', 'В работе'];

describe('firstWorkStart — момент реального начала работы', () => {
  // Реальный changelog ELCAS-11485 (из recon): Ready for DEV — очередь, DEV — начало работы.
  const t11485 = [
    { at: '2026-04-17T13:22:01.371+0300', to: 'Doc/Design' },
    { at: '2026-05-21T18:06:00.373+0300', to: 'DoR/PBR' },
    { at: '2026-06-11T16:29:58.325+0300', to: 'Ready for DEV' },
    { at: '2026-07-02T17:06:37.777+0300', to: 'DEV' },
  ];

  it('берёт вход в DEV, а не Ready for DEV (очередь не считается)', () => {
    expect(firstWorkStart(t11485, WORK)).toBe('2026-07-02T17:06:37.777+0300');
  });

  it('регистронезависимо + берёт ПЕРВЫЙ вход в рабочий статус', () => {
    const tr = [
      { at: '2026-07-05T10:00:00Z', to: 'dev' }, // первый (lowercase)
      { at: '2026-07-06T10:00:00Z', to: 'В работе' }, // второй рабочий — игнор
    ];
    expect(firstWorkStart(tr, WORK)).toBe('2026-07-05T10:00:00Z');
  });

  it('задача не дошла до работы → null', () => {
    const tr = [{ at: '2026-07-01T10:00:00Z', to: 'Ready for DEV' }];
    expect(firstWorkStart(tr, WORK)).toBeNull();
  });
});
