/**
 * 연속 실패가 쌓이면 폴링을 잠시 멈춘다.
 *
 * 사이트가 내려갔거나 우리를 차단하고 있을 때 10분마다 계속 두드리는 것은
 * 상황을 악화시킬 뿐이다. 열린 동안에는 알림을 1회만 보낸다(스팸 방지).
 */
export interface CircuitOptions {
  readonly failureThreshold: number;
  readonly cooldownMinutes: number;
}

export const DEFAULT_CIRCUIT: CircuitOptions = {
  failureThreshold: 5,
  cooldownMinutes: 30,
};

export interface CircuitSnapshot {
  readonly consecutiveFailures: number;
  readonly openedAt: Date | null;
  /** 이번 open 구간에서 사용자에게 이미 알렸는지 */
  readonly alerted: boolean;
}

export const INITIAL_CIRCUIT: CircuitSnapshot = {
  consecutiveFailures: 0,
  openedAt: null,
  alerted: false,
};

export function recordSuccess(): CircuitSnapshot {
  return INITIAL_CIRCUIT;
}

export function recordFailure(
  state: CircuitSnapshot,
  now: Date,
  options: CircuitOptions = DEFAULT_CIRCUIT,
): CircuitSnapshot {
  const failures = state.consecutiveFailures + 1;
  if (failures < options.failureThreshold) {
    return { consecutiveFailures: failures, openedAt: null, alerted: false };
  }
  // 이미 열려 있으면 openedAt과 alerted를 유지한다 — 재알림을 막기 위해서다.
  return {
    consecutiveFailures: failures,
    openedAt: state.openedAt ?? now,
    alerted: state.alerted,
  };
}

export function isOpen(
  state: CircuitSnapshot,
  now: Date,
  options: CircuitOptions = DEFAULT_CIRCUIT,
): boolean {
  if (state.openedAt === null) return false;
  const elapsedMs = now.getTime() - state.openedAt.getTime();
  return elapsedMs < options.cooldownMinutes * 60_000;
}

/** 쿨다운이 끝났으면 회로를 닫아 폴링을 재개한다. */
export function tryReset(
  state: CircuitSnapshot,
  now: Date,
  options: CircuitOptions = DEFAULT_CIRCUIT,
): CircuitSnapshot {
  if (state.openedAt !== null && !isOpen(state, now, options)) {
    return INITIAL_CIRCUIT;
  }
  return state;
}

export function markAlerted(state: CircuitSnapshot): CircuitSnapshot {
  return { ...state, alerted: true };
}
