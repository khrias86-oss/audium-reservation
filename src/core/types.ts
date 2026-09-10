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
 * 조회 결과.
 *
 * 네 가지를 명확히 구분한다. 이 구분이 이 시스템의 성패를 가른다.
 *
 * - `OK`               자리 상황을 실제로 확인했다
 * - `QUEUED`           사이트가 대기열 페이지를 줬다 — 자리 상황을 **못 봤다**
 * - `CONTRACT_BROKEN`  응답이 계약과 다르다 — 우리 코드가 낡았다
 * - `TRANSIENT_ERROR`  네트워크·5xx 등 기다리면 나을 수 있는 문제
 *
 * 오디움은 혼잡 시 "동시접속자가 많아 잠시 대기 중입니다" 페이지를 HTTP 200으로
 * 반환한다(5차 정찰 확인). 이걸 빈 슬롯 목록으로 뭉개면 시스템은 "빈자리 없음"을
 * 조용히 반복하며 영원히 아무것도 잡지 못한다. 반대로 오류로 취급하면 정상 상황에
 * 서킷이 열려 감시가 멈춘다. 그래서 별도 상태다.
 */
export type ParseResult =
  | { readonly kind: 'OK'; readonly slots: readonly Slot[] }
  | { readonly kind: 'QUEUED'; readonly message: string }
  | { readonly kind: 'CONTRACT_BROKEN'; readonly reason: string; readonly raw?: unknown }
  | { readonly kind: 'TRANSIENT_ERROR'; readonly reason: string };
