import { describe, expect, it } from 'vitest';
import { openingWindowEnd, planRun } from '../src/core/run-plan.js';
import { isExpired } from '../src/config/watch-requests.js';

/** KST 시각을 Date로 */
const kst = (s: string) => new Date(`${s}+09:00`);

describe('예약 오픈 시간대', () => {
  const guess = ['2026-11-24T14:00:00'];

  it('오픈 예상 75분 전부터 60분 뒤까지 지켜본다', () => {
    expect(openingWindowEnd(kst('2026-11-24T12:44:00'), guess)).toBeNull();
    expect(openingWindowEnd(kst('2026-11-24T12:45:00'), guess)).toBe(kst('2026-11-24T15:00:00').getTime());
    expect(openingWindowEnd(kst('2026-11-24T14:59:00'), guess)).not.toBeNull();
    expect(openingWindowEnd(kst('2026-11-24T15:00:00'), guess)).toBeNull();
  });

  it('추정이 없으면 화요일 13~15시를 본다', () => {
    expect(openingWindowEnd(kst('2026-11-24T13:30:00'), [])).toBe(kst('2026-11-24T15:00:00').getTime());
    expect(openingWindowEnd(kst('2026-11-25T13:30:00'), [])).toBeNull(); // 수요일
    expect(openingWindowEnd(kst('2026-11-24T12:59:00'), [])).toBeNull();
  });

  it('추정이 있으면 화요일이라도 추정 밖은 보지 않는다 — 격주의 빈 주에 헛걸음하지 않게', () => {
    expect(openingWindowEnd(kst('2026-12-01T13:30:00'), ['2026-12-08T14:00:00'])).toBeNull();
  });
});

describe('실행 계획', () => {
  it('신청이 있으면 105분 감시한다', () => {
    expect(planRun({ now: kst('2026-11-25T10:00:00'), activeRequests: 2, openingGuesses: [] }))
      .toEqual({ watch: true, openingWindow: false, loopMinutes: 105 });
  });

  it('신청도 오픈도 없으면 스냅샷 한 번으로 끝낸다', () => {
    expect(planRun({ now: kst('2026-11-25T10:00:00'), activeRequests: 0, openingGuesses: [] }))
      .toEqual({ watch: false, openingWindow: false, loopMinutes: 0 });
  });

  it('신청이 없어도 오픈 시간대면 끝날 때까지 돈다 (최대 105분)', () => {
    const plan = planRun({ now: kst('2026-11-24T13:20:00'), activeRequests: 0, openingGuesses: ['2026-11-24T14:00:00'] });
    expect(plan).toEqual({ watch: false, openingWindow: true, loopMinutes: 100 });
    expect(planRun({ now: kst('2026-11-24T12:50:00'), activeRequests: 0, openingGuesses: ['2026-11-24T14:00:00'] }).loopMinutes)
      .toBe(105);
  });

  it('사람이 고른 감시 시간을 따르되 105분을 넘기지 않는다', () => {
    expect(planRun({ now: kst('2026-11-25T10:00:00'), activeRequests: 1, openingGuesses: [], requestedLoopMinutes: 0 }).loopMinutes).toBe(0);
    expect(planRun({ now: kst('2026-11-25T10:00:00'), activeRequests: 1, openingGuesses: [], requestedLoopMinutes: 500 }).loopMinutes).toBe(105);
  });
});

describe('지난 감시 신청', () => {
  it('회차 시작 1시간 전부터는 지난 것으로 본다', () => {
    const r = { date: '2026-09-19', time: '13:30' };
    expect(isExpired(r, kst('2026-09-19T12:29:00'))).toBe(false);
    expect(isExpired(r, kst('2026-09-19T12:30:00'))).toBe(true);
    // 9/19 저녁 경고가 쌓이던 시각 — 이 신청은 이미 감시 대상이 아니었어야 했다.
    expect(isExpired(r, kst('2026-09-19T22:06:00'))).toBe(true);
  });

  it('실행 환경 타임존과 무관하게 KST로 판단한다', () => {
    // Actions는 UTC로 돈다. 2026-11-26 10:00 KST = 2026-11-26 01:00 UTC.
    expect(isExpired({ date: '2026-11-26', time: '10:00' }, new Date('2026-11-25T23:59:00Z'))).toBe(false);
    expect(isExpired({ date: '2026-11-26', time: '10:00' }, new Date('2026-11-26T00:00:00Z'))).toBe(true);
  });
});
