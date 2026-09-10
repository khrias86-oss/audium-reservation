import { describe, expect, it } from 'vitest';
import { newlyAvailable, selectClaimTarget } from '../src/core/matcher.js';
import type { Slot, Watch } from '../src/core/types.js';

const slot = (date: string, time: string, status: Slot['status']): Slot => ({
  date, time, status, remain: status === 'AVAILABLE' ? 1 : 0, capacity: 20, bookUrl: null,
});

const watch = (over: Partial<Watch> = {}): Watch => ({
  id: 'w1', userId: 'u1', date: '2026-03-14', time: '10:00',
  priority: 0, state: 'WATCHING', ...over,
});

describe('selectClaimTarget', () => {
  it('감시 조건과 정확히 일치하는 여석만 고른다', () => {
    const target = selectClaimTarget([watch()], [slot('2026-03-14', '10:00', 'AVAILABLE')]);
    expect(target?.watch.id).toBe('w1');
  });

  it('매진 슬롯은 고르지 않는다', () => {
    expect(selectClaimTarget([watch()], [slot('2026-03-14', '10:00', 'SOLD_OUT')])).toBeNull();
  });

  it('사용자가 고르지 않은 회차로 확장하지 않는다', () => {
    // 같은 날 11시가 비어도, 10시를 감시 중이라면 예약하지 않는다.
    const target = selectClaimTarget([watch()], [slot('2026-03-14', '11:00', 'AVAILABLE')]);
    expect(target).toBeNull();
  });

  it('사용자가 고르지 않은 날짜로 확장하지 않는다', () => {
    const target = selectClaimTarget([watch()], [slot('2026-03-21', '10:00', 'AVAILABLE')]);
    expect(target).toBeNull();
  });

  it('이미 예약이 확정된 사용자는 추가로 예약하지 않는다 (1인 1매)', () => {
    const watches = [
      watch({ id: 'done', date: '2026-03-13', state: 'BOOKED' }),
      watch({ id: 'w1', state: 'WATCHING' }),
    ];
    expect(selectClaimTarget(watches, [slot('2026-03-14', '10:00', 'AVAILABLE')])).toBeNull();
  });

  it('다른 사용자의 예약 확정은 영향을 주지 않는다', () => {
    const watches = [
      watch({ id: 'other', userId: 'u2', date: '2026-03-13', state: 'BOOKED' }),
      watch({ id: 'w1', userId: 'u1', state: 'WATCHING' }),
    ];
    expect(selectClaimTarget(watches, [slot('2026-03-14', '10:00', 'AVAILABLE')])?.watch.id).toBe('w1');
  });

  it('여러 슬롯이 동시에 열리면 우선순위가 높은 것 하나만 반환한다', () => {
    const watches = [
      watch({ id: 'low', time: '15:30', priority: 5 }),
      watch({ id: 'high', time: '10:00', priority: 1 }),
    ];
    const slots = [slot('2026-03-14', '10:00', 'AVAILABLE'), slot('2026-03-14', '15:30', 'AVAILABLE')];
    expect(selectClaimTarget(watches, slots)?.watch.id).toBe('high');
  });

  it('우선순위가 같으면 이른 날짜·이른 회차를 먼저 시도한다', () => {
    const watches = [
      watch({ id: 'late', date: '2026-03-21', priority: 0 }),
      watch({ id: 'early', date: '2026-03-14', priority: 0 }),
    ];
    const slots = [slot('2026-03-14', '10:00', 'AVAILABLE'), slot('2026-03-21', '10:00', 'AVAILABLE')];
    expect(selectClaimTarget(watches, slots)?.watch.id).toBe('early');
  });

  it('WATCHING이 아닌 감시는 후보가 아니다', () => {
    for (const state of ['PAUSED', 'CIRCUIT_OPEN', 'CONTRACT_BROKEN', 'EXPIRED'] as const) {
      expect(selectClaimTarget([watch({ state })], [slot('2026-03-14', '10:00', 'AVAILABLE')])).toBeNull();
    }
  });
});

describe('newlyAvailable', () => {
  it('직전에도 열려 있던 슬롯은 새 알림 대상이 아니다', () => {
    const prev = [slot('2026-03-14', '10:00', 'AVAILABLE')];
    const curr = [slot('2026-03-14', '10:00', 'AVAILABLE')];
    expect(newlyAvailable(prev, curr)).toHaveLength(0);
  });

  it('매진에서 여석으로 바뀐 슬롯만 잡아낸다', () => {
    const prev = [slot('2026-03-14', '10:00', 'SOLD_OUT'), slot('2026-03-14', '11:00', 'AVAILABLE')];
    const curr = [slot('2026-03-14', '10:00', 'AVAILABLE'), slot('2026-03-14', '11:00', 'AVAILABLE')];
    const found = newlyAvailable(prev, curr);
    expect(found).toHaveLength(1);
    expect(found[0]?.time).toBe('10:00');
  });

  it('첫 조회에서는 열린 슬롯 전부가 새 것이다', () => {
    expect(newlyAvailable([], [slot('2026-03-14', '10:00', 'AVAILABLE')])).toHaveLength(1);
  });
});
