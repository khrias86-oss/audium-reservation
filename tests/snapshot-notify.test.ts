import { describe, expect, it } from 'vitest';
import { notificationsFor } from '../src/snapshot.js';
import { buildProductSnapshot, wrapSnapshot } from '../src/adapters/audeum/build-snapshot.js';
import type { Slot } from '../src/core/types.js';

const slot = (date: string, time: string): Slot => ({
  date, time, status: 'SOLD_OUT', remain: null, capacity: null, bookUrl: 'https://audeum.org/booking',
});
const kst = (s: string) => new Date(`${s}+09:00`);

describe('스냅샷이 알리는 것', () => {
  const lastOpen = [{ date: '2026-11-26', opensAt: '2026-11-10T14:00:00' }];
  const before = wrapSnapshot(kst('2026-11-24T13:00:00'), [
    buildProductSnapshot('exhibition', '2026-11-24', lastOpen, new Map([['2026-11-26', [slot('2026-11-26', '10:00')]]])),
  ]);

  it('예상 시각 90분 전부터 오픈 예고를 보낸다', () => {
    expect(notificationsFor(before, before, kst('2026-11-24T12:29:00'))).toEqual([]);
    expect(notificationsFor(before, before, kst('2026-11-24T12:30:00')))
      .toEqual([{ kind: 'OPENING_SOON', product: 'exhibition', at: '2026-11-24T14:00:00' }]);
    expect(notificationsFor(before, before, kst('2026-11-24T14:00:00'))).toEqual([]);
  });

  it('새로 열린 날짜가 생기면 오픈을 알린다', () => {
    const open = [...lastOpen, { date: '2026-12-03', opensAt: '2026-11-24T14:00:00' }];
    const after = wrapSnapshot(kst('2026-11-24T14:05:00'), [
      buildProductSnapshot('exhibition', '2026-11-24', open, new Map([
        ['2026-11-26', [slot('2026-11-26', '10:00')]],
        ['2026-12-03', [slot('2026-12-03', '10:00')]],
      ])),
    ]);
    const list = notificationsFor(before, after, kst('2026-11-24T14:05:00'));
    expect(list).toContainEqual({ kind: 'OPENED', product: 'exhibition', dates: ['2026-12-03'] });
  });

  it('직전 스냅샷이 없으면 오픈을 알리지 않는다 — 첫 실행에 거짓 알림이 나가지 않게', () => {
    expect(notificationsFor(null, before, kst('2026-11-25T10:00:00'))).toEqual([]);
  });
});
