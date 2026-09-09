import { INITIAL_CIRCUIT, type CircuitSnapshot } from '../core/circuit-breaker.js';
import type { Slot, Watch } from '../core/types.js';
import type { Store } from './types.js';

/** 테스트와 로컬 실행용. 프로세스가 죽으면 상태도 사라진다. */
export function createMemoryStore(seed: readonly Watch[] = []): Store {
  const watches = new Map<string, Watch>(seed.map((w) => [w.id, w]));
  const bookingKeys = new Set<string>();
  let snapshot: readonly Slot[] = [];
  let circuit: CircuitSnapshot = INITIAL_CIRCUIT;
  let heartbeat: Date | null = null;

  return {
    async listWatches() {
      return [...watches.values()];
    },
    async saveWatch(watch) {
      watches.set(watch.id, watch);
    },
    async getSnapshot() {
      return snapshot;
    },
    async saveSnapshot(slots) {
      snapshot = slots;
    },
    async getCircuit() {
      return circuit;
    },
    async saveCircuit(state) {
      circuit = state;
    },
    async getHeartbeat() {
      return heartbeat;
    },
    async saveHeartbeat(at) {
      heartbeat = at;
    },
    async claimBookingKey(key) {
      if (bookingKeys.has(key)) return false;
      bookingKeys.add(key);
      return true;
    },
  };
}
