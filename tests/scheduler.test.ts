import { describe, expect, it } from 'vitest';
import {
  MIN_INTERVAL_MINUTES,
  applyJitter,
  computePollInterval,
  type PollPolicy,
} from '../src/core/scheduler.js';

const base: PollPolicy = { baseMinutes: 10, adaptive: false, jitterSeconds: 60 };
// 2026-03-10 09:00 KST
const now = new Date('2026-03-10T00:00:00Z');

describe('computePollInterval', () => {
  it('적응형이 꺼져 있으면 날짜와 무관하게 기본 주기를 쓴다', () => {
    expect(computePollInterval(now, '2026-03-11', base).intervalMinutes).toBe(10);
    expect(computePollInterval(now, '2026-04-30', base).intervalMinutes).toBe(10);
  });

  it('적응형에서 먼 날짜는 주기를 완화한다', () => {
    const plan = computePollInterval(now, '2026-04-30', { ...base, adaptive: true });
    expect(plan.intervalMinutes).toBe(30);
  });

  it('적응형에서 2~7일 전은 기본 주기를 유지한다', () => {
    const plan = computePollInterval(now, '2026-03-14', { ...base, adaptive: true });
    expect(plan.intervalMinutes).toBe(10);
  });

  it('적응형에서 관람일 임박 구간은 하한까지 좁힌다', () => {
    const plan = computePollInterval(now, '2026-03-10', { ...base, adaptive: true });
    expect(plan.intervalMinutes).toBe(MIN_INTERVAL_MINUTES);
  });

  it('설정이 하한보다 낮아도 하한을 강제한다', () => {
    // 준수 요건이므로 사용자 설정으로 무력화할 수 없어야 한다.
    const plan = computePollInterval(now, '2026-03-14', { ...base, baseMinutes: 1 });
    expect(plan.intervalMinutes).toBe(MIN_INTERVAL_MINUTES);
  });

  it('선택 이유를 항상 설명한다', () => {
    expect(computePollInterval(now, '2026-03-14', base).reason).not.toBe('');
  });
});

describe('applyJitter', () => {
  it('지터는 주기 주변에서만 움직인다', () => {
    expect(applyJitter(10, 60, () => 0)).toBe(10 * 60_000 - 60_000); // 최저
    expect(applyJitter(10, 60, () => 1)).toBe(10 * 60_000 + 60_000); // 최고
    expect(applyJitter(10, 60, () => 0.5)).toBe(10 * 60_000);
  });

  it('지터가 하한을 뚫지 못한다', () => {
    // 5분 주기에 -60초 지터가 걸려도 5분 아래로 내려가면 안 된다.
    expect(applyJitter(5, 60, () => 0)).toBe(MIN_INTERVAL_MINUTES * 60_000);
  });
});
