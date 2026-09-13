import { describe, expect, it } from 'vitest';
import { buildProductSnapshot, wrapSnapshot } from '../src/adapters/audeum/build-snapshot.js';
import type { Slot } from '../src/core/types.js';
import type { OpenDate } from '../src/adapters/audeum/parse-date-fragment.js';

const slot = (date: string, time: string, status: Slot['status']): Slot => ({
  date, time, status, remain: null, capacity: null, bookUrl: 'https://audeum.org/booking',
});

describe('당월 스냅샷 — 요일을 추측하지 않는다', () => {
  it('사이트가 밝힌 열린 날짜만 회차를 채운다 — 나머지는 NOT_OPEN이다', () => {
    // 9월은 30일까지다. 열린 날짜는 딱 하루뿐이라고 가정한다.
    const openDates: OpenDate[] = [{ date: '2026-09-19', opensAt: '2026-09-08T14:00:00' }];
    const slots = new Map([
      ['2026-09-19', [slot('2026-09-19', '13:30', 'SOLD_OUT'), slot('2026-09-19', '14:30', 'AVAILABLE')]],
    ]);

    const snap = buildProductSnapshot('exhibition', '2026-09-10', openDates, slots);

    expect(snap.month).toBe('2026-09');
    expect(snap.days).toHaveLength(30);

    const day19 = snap.days.find((d) => d.date === '2026-09-19')!;
    expect(day19.state).toBe('AVAILABLE'); // 하나라도 비어 있으면 AVAILABLE
    expect(day19.slots).toEqual([
      { time: '13:30', available: false },
      { time: '14:30', available: true },
    ]);

    // 열린 날짜 목록에 없는 날은 요일과 무관하게 전부 NOT_OPEN이다.
    const day20 = snap.days.find((d) => d.date === '2026-09-20')!;
    expect(day20.state).toBe('NOT_OPEN');
    expect(day20.slots).toBeUndefined();
  });

  it('열린 날짜인데 전부 매진이면 SOLD_OUT이다', () => {
    const openDates: OpenDate[] = [{ date: '2026-09-19', opensAt: null }];
    const slots = new Map([
      ['2026-09-19', [slot('2026-09-19', '13:30', 'SOLD_OUT'), slot('2026-09-19', '14:30', 'SOLD_OUT')]],
    ]);
    const snap = buildProductSnapshot('exhibition', '2026-09-10', openDates, slots);
    expect(snap.days.find((d) => d.date === '2026-09-19')!.state).toBe('SOLD_OUT');
  });

  it('오늘보다 이전 날짜는 PAST다 — 열려 있었더라도 지난 일이다', () => {
    const openDates: OpenDate[] = [{ date: '2026-09-05', opensAt: null }];
    const slots = new Map([['2026-09-05', [slot('2026-09-05', '10:00', 'AVAILABLE')]]]);
    const snap = buildProductSnapshot('exhibition', '2026-09-10', openDates, slots);
    expect(snap.days.find((d) => d.date === '2026-09-05')!.state).toBe('PAST');
  });

  it('오늘 날짜 자체는 지난 날로 치지 않는다', () => {
    const openDates: OpenDate[] = [{ date: '2026-09-10', opensAt: null }];
    const slots = new Map([['2026-09-10', [slot('2026-09-10', '10:00', 'SOLD_OUT')]]]);
    const snap = buildProductSnapshot('exhibition', '2026-09-10', openDates, slots);
    expect(snap.days.find((d) => d.date === '2026-09-10')!.state).toBe('SOLD_OUT');
  });

  it('열린 날짜인데 아직 조회하지 않았으면(호출부 책임) NOT_OPEN으로 안전하게 떨어진다', () => {
    // 오픈 시각을 함께 들고 있어야 "언제 다시 보면 되는지" 프론트에 알려줄 수 있다.
    const openDates: OpenDate[] = [{ date: '2026-09-19', opensAt: '2026-09-08T14:00:00' }];
    const snap = buildProductSnapshot('exhibition', '2026-09-10', openDates, new Map());
    const day = snap.days.find((d) => d.date === '2026-09-19')!;
    expect(day.state).toBe('NOT_OPEN');
    expect(day.opensAt).toBe('2026-09-08T14:00:00');
  });

  it('요일(dow)을 실제 달력과 맞게 계산한다', () => {
    // 2026-09-19는 토요일이다.
    const snap = buildProductSnapshot('exhibition', '2026-09-01', [], new Map());
    expect(snap.days.find((d) => d.date === '2026-09-19')!.dow).toBe(6);
  });

  it('전시와 렉처는 완전히 독립적으로 판단된다 — 한쪽 상태가 다른 쪽에 영향 없다', () => {
    const exhibitionOpen: OpenDate[] = [{ date: '2026-09-19', opensAt: null }];
    const exhibitionSlots = new Map([['2026-09-19', [slot('2026-09-19', '13:30', 'AVAILABLE')]]]);
    const lectureOpen: OpenDate[] = []; // 렉처는 이번 달 예약이 아예 안 열렸다

    const ex = buildProductSnapshot('exhibition', '2026-09-10', exhibitionOpen, exhibitionSlots);
    const lec = buildProductSnapshot('lecture', '2026-09-10', lectureOpen, new Map());

    expect(ex.days.find((d) => d.date === '2026-09-19')!.state).toBe('AVAILABLE');
    expect(lec.days.find((d) => d.date === '2026-09-19')!.state).toBe('NOT_OPEN');
    expect(lec.product).toBe('lecture');
  });

  it('30일과 31일짜리 달을 정확히 센다', () => {
    expect(buildProductSnapshot('exhibition', '2026-09-01', [], new Map()).days).toHaveLength(30);
    expect(buildProductSnapshot('exhibition', '2026-10-01', [], new Map()).days).toHaveLength(31);
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
