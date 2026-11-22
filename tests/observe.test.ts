import { describe, expect, it, vi } from 'vitest';
import { observeProduct, type ObserveDeps } from '../src/watch/observe.js';
import type { ParseResult, Slot } from '../src/core/types.js';

const slot = (date: string, time: string, available: boolean): Slot => ({
  date, time, status: available ? 'AVAILABLE' : 'SOLD_OUT', remain: null, capacity: null, bookUrl: 'https://audeum.org/booking',
});

function deps(over: Partial<ObserveDeps> & { perDate?: Map<string, ParseResult>; openDates?: string[] } = {}): ObserveDeps {
  const perDate = over.perDate ?? new Map<string, ParseResult>();
  return {
    fetchOpenDates: over.fetchOpenDates ?? (async () => ({ kind: 'OK', dates: (over.openDates ?? [...perDate.keys()]).map((date) => ({ date, opensAt: null })) })),
    fetchSlotsForDates: over.fetchSlotsForDates ?? (async (dates) => {
      const slots = dates.flatMap((d) => { const r = perDate.get(d); return r?.kind === 'OK' ? [...r.slots] : []; });
      return { result: { kind: 'OK', slots }, perDate: new Map(dates.map((d) => [d, perDate.get(d) ?? { kind: 'OK', slots: [] }])), elapsedMs: 5 };
    }),
    prepareBooking: over.prepareBooking ?? (async (s) => ({ kind: 'READY', plan: { slot: s, reserveSeq: '1', product: 'exhibition', bookingUrl: 'x' } })),
  };
}

describe('회차 관찰', () => {
  it('자리가 있으면 재확인 후 알림 문구와 함께 "있음"으로 보낸다', async () => {
    const perDate = new Map<string, ParseResult>([['2026-12-04', { kind: 'OK', slots: [slot('2026-12-04', '10:00', true), slot('2026-12-04', '13:30', false)] }]]);
    const r = await observeProduct('exhibition', [{ date: '2026-12-04', time: '10:00' }, { date: '2026-12-04', time: '13:30' }], deps({ perDate }));
    expect(r.kind).toBe('OK');
    expect(r.observations).toHaveLength(2);
    const hit = r.observations.find((o) => o.time === '10:00')!;
    expect(hit.available).toBe(true);
    expect(hit.subject).toContain('12/4(금) 10:00');
    expect(hit.text).toContain('방금 한 번 더 확인');
    expect(r.observations.find((o) => o.time === '13:30')).toEqual({ product: 'exhibition', date: '2026-12-04', time: '13:30', available: false });
  });

  it('재확인에서 사라졌으면 "없음"으로 보낸다 — 열어 보니 없는 알림을 막는다', async () => {
    const perDate = new Map<string, ParseResult>([['2026-12-04', { kind: 'OK', slots: [slot('2026-12-04', '10:00', true)] }]]);
    const r = await observeProduct('exhibition', [{ date: '2026-12-04', time: '10:00' }],
      deps({ perDate, prepareBooking: async () => ({ kind: 'GONE', reason: '매진' }) }));
    expect(r.observations).toEqual([{ product: 'exhibition', date: '2026-12-04', time: '10:00', available: false }]);
  });

  it('재확인을 못 했으면 알리되, 확인 못 했다고 적는다', async () => {
    const perDate = new Map<string, ParseResult>([['2026-12-04', { kind: 'OK', slots: [slot('2026-12-04', '10:00', true)] }]]);
    const r = await observeProduct('exhibition', [{ date: '2026-12-04', time: '10:00' }],
      deps({ perDate, prepareBooking: async () => ({ kind: 'UNVERIFIED', reason: '대기열' }) }));
    expect(r.observations[0]!.available).toBe(true);
    expect(r.observations[0]!.text).toContain('다시 확인은 못 했습니다');
  });

  it('아직 예약이 안 열린 날짜는 사이트에 묻지 않고 "없음"으로 보낸다', async () => {
    const fetchSlotsForDates = vi.fn();
    const r = await observeProduct('exhibition', [{ date: '2026-12-10', time: '10:00' }],
      deps({ openDates: ['2026-12-04'], fetchSlotsForDates }));
    expect(fetchSlotsForDates).not.toHaveBeenCalled();
    expect(r.observations).toEqual([{ product: 'exhibition', date: '2026-12-10', time: '10:00', available: false }]);
  });

  it('확인하지 못한 날짜는 관찰에서 뺀다 — 진행 중인 알림을 "없음"으로 끝내지 않게', async () => {
    const perDate = new Map<string, ParseResult>([
      ['2026-12-04', { kind: 'OK', slots: [slot('2026-12-04', '10:00', false)] }],
      ['2026-12-05', { kind: 'TRANSIENT_ERROR', reason: '500' }],
    ]);
    const r = await observeProduct('exhibition', [{ date: '2026-12-04', time: '10:00' }, { date: '2026-12-05', time: '10:00' }], deps({ perDate }));
    expect(r.observations.map((o) => o.date)).toEqual(['2026-12-04']);
  });

  it('대기열이면 건너뛰고, 계약이 깨졌으면 그렇다고 알린다', async () => {
    const wanted = [{ date: '2026-12-04', time: '10:00' }];
    const queued = await observeProduct('exhibition', wanted, deps({
      openDates: ['2026-12-04'],
      fetchSlotsForDates: async () => ({ result: { kind: 'QUEUED', message: '대기열' }, perDate: new Map(), elapsedMs: 1 }),
    }));
    expect(queued).toMatchObject({ kind: 'SKIPPED', observations: [] });

    const broken = await observeProduct('exhibition', wanted, deps({
      openDates: ['2026-12-04'],
      fetchSlotsForDates: async () => ({ result: { kind: 'CONTRACT_BROKEN', reason: '필드 없음', raw: '<html>' }, perDate: new Map(), elapsedMs: 1 }),
    }));
    expect(broken).toMatchObject({ kind: 'BROKEN', reason: '필드 없음', raw: '<html>', observations: [] });
  });

  it('열린 날짜 목록을 못 받아도 신청한 날짜를 그대로 확인한다', async () => {
    const perDate = new Map<string, ParseResult>([['2026-12-04', { kind: 'OK', slots: [slot('2026-12-04', '10:00', true)] }]]);
    const r = await observeProduct('exhibition', [{ date: '2026-12-04', time: '10:00' }],
      deps({ perDate, fetchOpenDates: async () => ({ kind: 'QUEUED', message: '대기열' }) }));
    expect(r.observations[0]!.available).toBe(true);
  });
});
