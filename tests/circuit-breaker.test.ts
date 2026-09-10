import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CIRCUIT, INITIAL_CIRCUIT, isOpen, markAlerted,
  recordFailure, recordSuccess, tryReset,
} from '../src/core/circuit-breaker.js';

const t0 = new Date('2026-03-10T00:00:00Z');
const at = (min: number) => new Date(t0.getTime() + min * 60_000);

const failTimes = (n: number, now = t0) => {
  let s = INITIAL_CIRCUIT;
  for (let i = 0; i < n; i++) s = recordFailure(s, now);
  return s;
};

describe('circuit breaker', () => {
  it('임계 미만의 실패로는 열리지 않는다', () => {
    expect(isOpen(failTimes(DEFAULT_CIRCUIT.failureThreshold - 1), t0)).toBe(false);
  });

  it('연속 5회 실패에서 열린다', () => {
    expect(isOpen(failTimes(DEFAULT_CIRCUIT.failureThreshold), t0)).toBe(true);
  });

  it('중간에 성공하면 카운터가 초기화된다', () => {
    let s = failTimes(4);
    s = recordSuccess();
    s = recordFailure(s, t0);
    expect(isOpen(s, t0)).toBe(false);
    expect(s.consecutiveFailures).toBe(1);
  });

  it('쿨다운이 끝나면 닫힌다', () => {
    const s = failTimes(5);
    expect(isOpen(s, at(29))).toBe(true);
    expect(isOpen(s, at(30))).toBe(false);
    expect(tryReset(s, at(30))).toEqual(INITIAL_CIRCUIT);
  });

  it('열린 상태에서 추가 실패해도 쿨다운이 연장되지 않는다', () => {
    // openedAt이 갱신되면 실패가 계속되는 동안 영원히 복구되지 않는다.
    let s = failTimes(5);
    const openedAt = s.openedAt;
    s = recordFailure(s, at(10));
    expect(s.openedAt).toEqual(openedAt);
    expect(isOpen(s, at(31))).toBe(false);
  });

  it('한 번 알린 뒤에는 재알림하지 않는다', () => {
    // 30분 동안 3분마다 같은 경고 메일이 오면 사용자는 알림을 끈다.
    let s = markAlerted(failTimes(5));
    s = recordFailure(s, at(5));
    expect(s.alerted).toBe(true);
  });

  it('회로가 닫히면 알림 플래그도 초기화되어 다음 장애를 다시 알린다', () => {
    const s = tryReset(markAlerted(failTimes(5)), at(31));
    expect(s.alerted).toBe(false);
  });
});
