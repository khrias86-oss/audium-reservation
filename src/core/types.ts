/**
 * 사이트에 의존하지 않는 정규화 타입.
 *
 * 어댑터는 오디움의 응답을 이 타입으로 변환할 책임만 지고,
 * core의 나머지 로직은 오디움을 전혀 모른다. 사이트가 개편되어도
 * 파급은 어댑터 경계에서 멈춘다.
 */

export type SlotStatus =
  /** 예약 가능한 여석이 있다 */
  | 'AVAILABLE'
  /** 회차는 존재하나 여석이 없다 */
  | 'SOLD_OUT'
  /** 휴관일이거나 아직 오픈되지 않은 회차 */
  | 'CLOSED';

export interface Slot {
  /** KST 기준 YYYY-MM-DD */
  readonly date: string;
  /** 24시간제 HH:mm */
  readonly time: string;
  readonly status: SlotStatus;
  /**
   * 잔여 좌석 수. 사이트가 숫자를 노출하지 않고 가능/불가만 알려주는 경우 null.
   * null을 0으로 오해하면 여석을 놓치므로 절대 기본값을 씌우지 않는다.
   */
  readonly remain: number | null;
  readonly capacity: number | null;
  /** 해당 회차의 예약 진입 URL. 없으면 null */
  readonly bookUrl: string | null;
}

/** 슬롯의 고유 키. 멱등성 검사와 스냅샷 diff의 기준. */
export function slotKey(slot: Pick<Slot, 'date' | 'time'>): string {
  return `${slot.date}T${slot.time}`;
}

export type WatchState =
  /** 폴링 중 */
  | 'WATCHING'
  /** 여석을 감지했고 예약 시도 직전 */
  | 'DETECTED'
  /** 예약 제출 진행 중 */
  | 'CLAIMING'
  /** 예약 확정 */
  | 'BOOKED'
  /** 재시도를 소진했다. 사람이 직접 예약해야 한다 */
  | 'FAILED_NEEDS_HUMAN'
  /** 연속 실패로 일시 차단됨 */
  | 'CIRCUIT_OPEN'
  /** 응답 스키마가 계약과 달라 파싱이 깨졌다 */
  | 'CONTRACT_BROKEN'
  /** 관람일이 지났다 */
  | 'EXPIRED'
  /** 사용자가 킬스위치를 눌렀다 */
  | 'PAUSED'
  /** 다른 슬롯 예약 성공 등으로 더는 감시할 이유가 없다 */
  | 'STOPPED';

/** 종료 상태 — 여기서는 폴링하지 않는다. */
export const TERMINAL_STATES: ReadonlySet<WatchState> = new Set<WatchState>([
  'BOOKED',
  'EXPIRED',
  'STOPPED',
]);

export interface Watch {
  readonly id: string;
  readonly userId: string;
  /** KST 기준 YYYY-MM-DD */
  readonly date: string;
  /** 24시간제 HH:mm */
  readonly time: string;
  /** 낮을수록 먼저 시도한다. 사용자가 대시보드에서 드래그로 정한 순서. */
  readonly priority: number;
  readonly state: WatchState;
}

/**
 * 파싱 결과. "여석이 없다"와 "파서가 깨졌다"를 타입 수준에서 분리한다.
 *
 * 대부분의 예약봇이 실패하는 지점이 여기다 — 사이트가 개편되면 파싱이 빈 배열을
 * 반환하고, 시스템은 "빈자리 없음"으로 착각한 채 조용히 영원히 실패한다.
 */
export type ParseResult =
  | { readonly ok: true; readonly slots: readonly Slot[] }
  | { readonly ok: false; readonly reason: string; readonly raw?: unknown };
