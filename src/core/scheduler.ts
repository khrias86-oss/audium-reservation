import { daysUntil } from './time.js';

/**
 * 폴링 주기 하한. 적응형 모드에서도 이 값 아래로 내려가지 않는다.
 * `PROMPT.md` §0.5-2의 준수 요건이며, 설정으로 무력화할 수 없다.
 */
export const MIN_INTERVAL_MINUTES = 5;

export interface PollPolicy {
  /** 기본 주기(분). 사용자 설정값. */
  readonly baseMinutes: number;
  /** 관람일 임박 구간에서 주기를 좁힐지 여부. 기본 false. */
  readonly adaptive: boolean;
  /** 지터 폭(초). 서버 부하 분산과 재시작 시 동기화 방지가 목적. */
  readonly jitterSeconds: number;
}

export interface PollPlan {
  readonly intervalMinutes: number;
  /** 왜 이 주기가 선택됐는지. 로그와 대시보드에 그대로 노출한다. */
  readonly reason: string;
}

/**
 * 대상 회차까지 남은 기간에 따라 폴링 주기를 정한다.
 *
 * 취소표는 관람일 1~2일 전과 당일 오전에 집중되므로, 먼 날짜를 촘촘히 찌르는 것은
 * 사이트에 부담만 주고 얻는 것이 없다. 적응형이 꺼져 있으면 항상 기본 주기를 쓴다.
 */
export function computePollInterval(
  now: Date,
  targetDate: string,
  policy: PollPolicy,
): PollPlan {
  const clampedBase = Math.max(policy.baseMinutes, MIN_INTERVAL_MINUTES);

  if (!policy.adaptive) {
    return { intervalMinutes: clampedBase, reason: '기본 주기 (적응형 꺼짐)' };
  }

  const remaining = daysUntil(now, targetDate);

  if (remaining > 7) {
    return {
      intervalMinutes: Math.max(30, clampedBase),
      reason: `관람일 7일 초과(${remaining}일 남음) — 주기 완화`,
    };
  }
  if (remaining >= 2) {
    return {
      intervalMinutes: clampedBase,
      reason: `관람일 2~7일 전(${remaining}일 남음) — 기본 주기`,
    };
  }
  return {
    intervalMinutes: MIN_INTERVAL_MINUTES,
    reason: `관람일 임박(${remaining}일 남음) — 취소표 집중 구간`,
  };
}

/**
 * 계산된 주기에 ±jitter를 더해 실제 대기 시간을 만든다.
 *
 * 하한을 다시 한 번 강제한다. 지터가 주기를 5분 미만으로 끌어내리면 안 된다.
 */
export function applyJitter(
  intervalMinutes: number,
  jitterSeconds: number,
  random: () => number = Math.random,
): number {
  const baseMs = intervalMinutes * 60_000;
  const offsetMs = (random() * 2 - 1) * jitterSeconds * 1000;
  const floorMs = MIN_INTERVAL_MINUTES * 60_000;
  return Math.max(floorMs, Math.round(baseMs + offsetMs));
}
