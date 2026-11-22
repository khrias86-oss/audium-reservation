import { describe, expect, it } from 'vitest';
import {
  buildProductSnapshot, guessNextOpening, newlyOpenedDates, wrapSnapshot,
} from '../src/adapters/audeum/build-snapshot.js';
import type { Slot } from '../src/core/types.js';
import type { OpenDate } from '../src/adapters/audeum/parse-date-fragment.js';

const slot = (date: string, time: string, status: Slot['status']): Slot => ({
  date, time, status, remain: null, capacity: null, bookUrl: 'https://audeum.org/booking',
});

const dayOf = (snap: ReturnType<typeof buildProductSnapshot>, date: string) =>
  snap.days.find((d) => d.date === date)!;

describe('스냅샷 — 요일을 추측하지 않는다', () => {
  it('사이트가 밝힌 열린 날짜만 회차를 채운다 — 나머지는 NOT_OPEN이다', () => {
    const openDates: OpenDate[] = [{ date: '2026-09-19', opensAt: '2026-09-08T14:00:00' }];
    const slots = new Map([
      ['2026-09-19', [slot('2026-09-19', '13:30', 'SOLD_OUT'), slot('2026-09-19', '14:30', 'AVAILABLE')]],
    ]);

    const snap = buildProductSnapshot('exhibition', '2026-09-10', openDates, slots);

    const day19 = dayOf(snap, '2026-09-19');
    expect(day19.state).toBe('AVAILABLE'); // 하나라도 비어 있으면 AVAILABLE
    expect(day19.slots).toEqual([
      { time: '13:30', available: false },
      { time: '14:30', available: true },
    ]);
    expect(day19.opensAt).toBe('2026-09-08T14:00:00');

    const day20 = dayOf(snap, '2026-09-20');
    expect(day20.state).toBe('NOT_OPEN');
    expect(day20.slots).toBeUndefined();
  });

  it('열린 날짜인데 전부 매진이면 SOLD_OUT이다', () => {
    const openDates: OpenDate[] = [{ date: '2026-09-19', opensAt: null }];
    const slots = new Map([
      ['2026-09-19', [slot('2026-09-19', '13:30', 'SOLD_OUT'), slot('2026-09-19', '14:30', 'SOLD_OUT')]],
    ]);
    const snap = buildProductSnapshot('exhibition', '2026-09-10', openDates, slots);
    expect(dayOf(snap, '2026-09-19').state).toBe('SOLD_OUT');
  });

  it('오늘보다 이전 날짜는 PAST다 — 열려 있었더라도 지난 일이다', () => {
    const openDates: OpenDate[] = [{ date: '2026-09-05', opensAt: null }];
    const slots = new Map([['2026-09-05', [slot('2026-09-05', '10:00', 'AVAILABLE')]]]);
    const snap = buildProductSnapshot('exhibition', '2026-09-10', openDates, slots);
    expect(dayOf(snap, '2026-09-05').state).toBe('PAST');
  });

  it('오늘 날짜 자체는 지난 날로 치지 않는다', () => {
    const openDates: OpenDate[] = [{ date: '2026-09-10', opensAt: null }];
    const slots = new Map([['2026-09-10', [slot('2026-09-10', '10:00', 'SOLD_OUT')]]]);
    const snap = buildProductSnapshot('exhibition', '2026-09-10', openDates, slots);
    expect(dayOf(snap, '2026-09-10').state).toBe('SOLD_OUT');
  });

  it('요일(dow)을 실제 달력과 맞게 계산한다', () => {
    // 2026-09-19는 토요일이다.
    const snap = buildProductSnapshot('exhibition', '2026-09-01', [], new Map());
    expect(dayOf(snap, '2026-09-19').dow).toBe(6);
  });

  it('전시와 렉처는 완전히 독립적으로 판단된다 — 한쪽 상태가 다른 쪽에 영향 없다', () => {
    const exhibitionOpen: OpenDate[] = [{ date: '2026-09-19', opensAt: null }];
    const exhibitionSlots = new Map([['2026-09-19', [slot('2026-09-19', '13:30', 'AVAILABLE')]]]);

    const ex = buildProductSnapshot('exhibition', '2026-09-10', exhibitionOpen, exhibitionSlots);
    const lec = buildProductSnapshot('lecture', '2026-09-10', [], new Map());

    expect(dayOf(ex, '2026-09-19').state).toBe('AVAILABLE');
    expect(dayOf(lec, '2026-09-19').state).toBe('NOT_OPEN');
    expect(lec.product).toBe('lecture');
  });
});

describe('스냅샷 — 이번 달과 다음 달', () => {
  it('두 달을 이어 붙여 그린다 — 월말에도 다음 달 예약이 보여야 한다', () => {
    const snap = buildProductSnapshot('exhibition', '2026-09-10', [], new Map());
    expect(snap.month).toBe('2026-09');
    expect(snap.months).toEqual(['2026-09', '2026-10']);
    expect(snap.days).toHaveLength(30 + 31);
    expect(snap.days.at(-1)!.date).toBe('2026-10-31');
  });

  it('해가 바뀌어도 다음 달을 맞게 센다', () => {
    const snap = buildProductSnapshot('exhibition', '2026-12-20', [], new Map());
    expect(snap.months).toEqual(['2026-12', '2027-01']);
    expect(snap.days).toHaveLength(31 + 31);
  });

  it('달 수를 줄이면 그만큼만 그린다', () => {
    expect(buildProductSnapshot('exhibition', '2026-09-01', [], new Map(), { months: 1 }).days).toHaveLength(30);
    expect(buildProductSnapshot('exhibition', '2026-10-01', [], new Map(), { months: 1 }).days).toHaveLength(31);
  });
});

describe('스냅샷 — 실패를 "안 열림"으로 위장하지 않는다', () => {
  it('날짜 목록을 못 받았으면 지나지 않은 날은 전부 UNKNOWN이다', () => {
    // 렉처가 9월부터 500을 받는 동안 달력은 "아직 안 열림"으로 보였다. 그게 오해의 원인이었다.
    const snap = buildProductSnapshot('lecture', '2026-11-22', [], new Map(), { error: 'HTTP 500' });
    expect(snap.error).toBe('HTTP 500');
    expect(dayOf(snap, '2026-11-21').state).toBe('PAST');
    expect(dayOf(snap, '2026-11-22').state).toBe('UNKNOWN');
    expect(dayOf(snap, '2026-12-05').state).toBe('UNKNOWN');
  });

  it('열린 날짜인데 회차 조회에 실패했으면 UNKNOWN이다', () => {
    const openDates: OpenDate[] = [{ date: '2026-09-19', opensAt: '2026-09-08T14:00:00' }];
    const snap = buildProductSnapshot('exhibition', '2026-09-10', openDates, new Map());
    const day = dayOf(snap, '2026-09-19');
    expect(day.state).toBe('UNKNOWN');
    expect(day.opensAt).toBe('2026-09-08T14:00:00');
  });

  it('오늘 회차 조회가 실패했으면 PAST로 본다 — 당일 회차가 끝나면 사이트가 필드를 빼고 보낸다', () => {
    // 2026-09-19 저녁, 당일 회차 조각이 날짜·시각 필드 없이 와서 경고가 99건 쌓였다.
    const openDates: OpenDate[] = [{ date: '2026-09-19', opensAt: null }];
    const snap = buildProductSnapshot('exhibition', '2026-09-19', openDates, new Map());
    expect(dayOf(snap, '2026-09-19').state).toBe('PAST');
  });
});

describe('다음 예약 오픈 추정', () => {
  it('가장 최근 오픈 시각에 14일을 더한다', () => {
    const open: OpenDate[] = [
      { date: '2026-11-26', opensAt: '2026-11-10T14:00:00' },
      { date: '2026-11-27', opensAt: '2026-11-10T14:00:00' },
    ];
    expect(guessNextOpening(open, '2026-11-22')).toBe('2026-11-24T14:00:00');
  });

  it('추정한 날이 이미 지났으면 14일씩 더 민다', () => {
    const open: OpenDate[] = [{ date: '2026-11-26', opensAt: '2026-11-10T14:00:00' }];
    expect(guessNextOpening(open, '2026-11-25')).toBe('2026-12-08T14:00:00');
  });

  it('오늘이 추정일이면 오늘을 그대로 돌려준다', () => {
    const open: OpenDate[] = [{ date: '2026-11-26', opensAt: '2026-11-10T14:00:00' }];
    expect(guessNextOpening(open, '2026-11-24')).toBe('2026-11-24T14:00:00');
  });

  it('오픈 시각을 하나도 모르면 추정하지 않는다', () => {
    expect(guessNextOpening([{ date: '2026-11-26', opensAt: null }], '2026-11-22')).toBeNull();
    expect(guessNextOpening([], '2026-11-22')).toBeNull();
  });
});

describe('새로 열린 날짜 감지', () => {
  const build = (open: OpenDate[], slots: Map<string, Slot[]>, error?: string) =>
    buildProductSnapshot('exhibition', '2026-11-22', open, slots, error ? { error } : {});

  it('직전에 NOT_OPEN이던 날이 열리면 알린다', () => {
    const before = build([], new Map());
    const after = build(
      [{ date: '2026-12-03', opensAt: '2026-11-24T14:00:00' }],
      new Map([['2026-12-03', [slot('2026-12-03', '10:00', 'AVAILABLE')]]]),
    );
    expect(newlyOpenedDates(before, after)).toEqual(['2026-12-03']);
  });

  it('직전에 이미 열려 있던 날은 다시 알리지 않는다', () => {
    const open = [{ date: '2026-12-03', opensAt: null }];
    const slots = new Map([['2026-12-03', [slot('2026-12-03', '10:00', 'SOLD_OUT')]]]);
    expect(newlyOpenedDates(build(open, slots), build(open, slots))).toEqual([]);
  });

  it('직전에 조회 실패(UNKNOWN)였던 날은 알리지 않는다 — 사이트가 흔들렸다 돌아온 것일 수 있다', () => {
    const open = [{ date: '2026-12-03', opensAt: null }];
    const before = build(open, new Map()); // 열린 날인데 회차 조회 실패 → UNKNOWN
    const after = build(open, new Map([['2026-12-03', [slot('2026-12-03', '10:00', 'SOLD_OUT')]]]));
    expect(newlyOpenedDates(before, after)).toEqual([]);
  });

  it('직전 스냅샷 전체가 실패였거나 없으면 아무것도 알리지 않는다', () => {
    const after = build(
      [{ date: '2026-12-03', opensAt: null }],
      new Map([['2026-12-03', [slot('2026-12-03', '10:00', 'SOLD_OUT')]]]),
    );
    expect(newlyOpenedDates(build([], new Map(), 'HTTP 500'), after)).toEqual([]);
    expect(newlyOpenedDates(undefined, after)).toEqual([]);
  });
});

describe('스냅샷 포장', () => {
  it('생성 시각과 프로그램 목록을 그대로 담는다', () => {
    const now = new Date('2026-09-10T12:00:00Z');
    const ex = buildProductSnapshot('exhibition', '2026-09-10', [], new Map());
    const wrapped = wrapSnapshot(now, [ex]);
    expect(wrapped.generatedAt).toBe('2026-09-10T12:00:00.000Z');
    expect(wrapped.products).toEqual([ex]);
  });
});
