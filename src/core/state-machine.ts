import { type Watch, type WatchState, TERMINAL_STATES } from './types.js';

export type WatchEvent =
  | { readonly type: 'SLOT_DETECTED' }
  | { readonly type: 'CLAIM_STARTED' }
  | { readonly type: 'CLAIM_SUCCEEDED' }
  | { readonly type: 'CLAIM_FAILED'; readonly retriesLeft: number }
  | { readonly type: 'CIRCUIT_OPENED' }
  | { readonly type: 'CIRCUIT_CLOSED' }
  | { readonly type: 'CONTRACT_DRIFT'; readonly reason: string }
  | { readonly type: 'DATE_PASSED' }
  | { readonly type: 'PAUSED_BY_USER' }
  | { readonly type: 'RESUMED_BY_USER' }
  /** 같은 사용자의 다른 감시가 예약에 성공했다 */
  | { readonly type: 'SUPERSEDED' };

/**
 * 허용된 전이만 정의한다. 표에 없는 조합은 무시되고 경고로 남는다.
 * 상태를 불리언 플래그 여러 개로 흩뿌리면 "감시 중인데 예약도 진행 중"
 * 같은 불가능한 조합이 생긴다. 여기서 한 곳으로 모은다.
 */
const TRANSITIONS: Readonly<Record<WatchState, Partial<Record<WatchEvent['type'], WatchState>>>> = {
  WATCHING: {
    SLOT_DETECTED: 'DETECTED',
    CIRCUIT_OPENED: 'CIRCUIT_OPEN',
    CONTRACT_DRIFT: 'CONTRACT_BROKEN',
    DATE_PASSED: 'EXPIRED',
    PAUSED_BY_USER: 'PAUSED',
    SUPERSEDED: 'STOPPED',
  },
  DETECTED: {
    CLAIM_STARTED: 'CLAIMING',
    PAUSED_BY_USER: 'PAUSED',
    CONTRACT_DRIFT: 'CONTRACT_BROKEN',
  },
  CLAIMING: {
    CLAIM_SUCCEEDED: 'BOOKED',
    // CLAIM_FAILED는 retriesLeft에 따라 갈리므로 applyEvent에서 별도 처리한다.
    CONTRACT_DRIFT: 'CONTRACT_BROKEN',
  },
  CIRCUIT_OPEN: {
    CIRCUIT_CLOSED: 'WATCHING',
    PAUSED_BY_USER: 'PAUSED',
    DATE_PASSED: 'EXPIRED',
  },
  CONTRACT_BROKEN: {
    // 계약이 깨졌을 때는 사람이 확인하고 고쳐야만 복귀한다. 자동 복귀 없음.
    PAUSED_BY_USER: 'PAUSED',
    DATE_PASSED: 'EXPIRED',
  },
  FAILED_NEEDS_HUMAN: {
    // 다음 취소표를 노리도록 감시는 계속한다.
    RESUMED_BY_USER: 'WATCHING',
    DATE_PASSED: 'EXPIRED',
    PAUSED_BY_USER: 'PAUSED',
    SUPERSEDED: 'STOPPED',
  },
  PAUSED: {
    RESUMED_BY_USER: 'WATCHING',
    DATE_PASSED: 'EXPIRED',
  },
  BOOKED: {},
  EXPIRED: {},
  STOPPED: {},
};

export interface TransitionResult {
  readonly watch: Watch;
  readonly changed: boolean;
  /** 전이가 거부된 이유. 로그로 남겨 조용한 실패를 막는다. */
  readonly rejected?: string;
}

export function applyEvent(watch: Watch, event: WatchEvent): TransitionResult {
  if (TERMINAL_STATES.has(watch.state)) {
    return { watch, changed: false, rejected: `종료 상태(${watch.state})에서는 전이하지 않는다` };
  }

  // 재시도가 남았으면 CLAIMING을 유지하고, 소진했으면 사람에게 넘긴다.
  if (event.type === 'CLAIM_FAILED') {
    if (watch.state !== 'CLAIMING') {
      return { watch, changed: false, rejected: `CLAIM_FAILED는 CLAIMING에서만 유효하다 (현재 ${watch.state})` };
    }
    const next: WatchState = event.retriesLeft > 0 ? 'CLAIMING' : 'FAILED_NEEDS_HUMAN';
    if (next === watch.state) return { watch, changed: false };
    return { watch: { ...watch, state: next }, changed: true };
  }

  const next = TRANSITIONS[watch.state][event.type];
  if (next === undefined) {
    return { watch, changed: false, rejected: `${watch.state} 상태에서 ${event.type}는 허용되지 않는다` };
  }
  return { watch: { ...watch, state: next }, changed: true };
}

/** 이 상태에서 폴링을 계속해야 하는가? */
export function shouldPoll(state: WatchState): boolean {
  return state === 'WATCHING' || state === 'FAILED_NEEDS_HUMAN';
}
