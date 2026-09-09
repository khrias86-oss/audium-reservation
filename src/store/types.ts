import type { CircuitSnapshot } from '../core/circuit-breaker.js';
import type { Slot, Watch } from '../core/types.js';

/**
 * 저장소 포트.
 *
 * 인메모리와 Postgres 구현이 같은 인터페이스를 만족하므로,
 * 테스트는 DB 없이 돌고 배포처를 바꿔도 로직은 그대로다.
 */
export interface Store {
  listWatches(): Promise<readonly Watch[]>;
  saveWatch(watch: Watch): Promise<void>;

  /** 직전 틱의 슬롯 스냅샷. 새로 열린 슬롯을 가려내는 기준. */
  getSnapshot(): Promise<readonly Slot[]>;
  saveSnapshot(slots: readonly Slot[]): Promise<void>;

  getCircuit(): Promise<CircuitSnapshot>;
  saveCircuit(state: CircuitSnapshot): Promise<void>;

  getHeartbeat(): Promise<Date | null>;
  saveHeartbeat(at: Date): Promise<void>;

  /**
   * 예약 멱등성 키를 선점한다. 이미 있으면 false.
   *
   * 워커가 중복 실행되거나 재시작돼도 같은 슬롯에 두 번 제출하지 않는다.
   * Postgres 구현에서는 UNIQUE 제약 위반을 false로 변환한다.
   */
  claimBookingKey(key: string): Promise<boolean>;
}
