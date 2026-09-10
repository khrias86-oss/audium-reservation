import { type Slot, type Watch, slotKey } from './types.js';

export interface ClaimTarget {
  readonly watch: Watch;
  readonly slot: Slot;
}

/**
 * 이번 틱에서 예약을 시도할 대상 하나를 고른다.
 *
 * 가드레일 (`PROMPT.md` §0.5, §2.4):
 * - 사용자가 대시보드에서 명시적으로 고른 날짜/회차와 **정확히** 일치할 때만 후보가 된다.
 *   비슷한 시각이나 인접 날짜로 확장하지 않는다.
 * - 이미 예약이 확정된 사용자는 후보에서 제외한다 (오디움은 1인 1매이고
 *   중복 예약은 취소 사유다).
 * - 여러 슬롯이 동시에 열려도 **한 번에 하나만** 반환한다. 사용자가 정한
 *   우선순위가 곧 시도 순서다.
 */
export function selectClaimTarget(
  watches: readonly Watch[],
  slots: readonly Slot[],
): ClaimTarget | null {
  const usersWithBooking = new Set(
    watches.filter((w) => w.state === 'BOOKED').map((w) => w.userId),
  );

  const availableByKey = new Map<string, Slot>();
  for (const slot of slots) {
    if (slot.status === 'AVAILABLE') {
      availableByKey.set(slotKey(slot), slot);
    }
  }

  const candidates: ClaimTarget[] = [];
  for (const watch of watches) {
    if (watch.state !== 'WATCHING') continue;
    if (usersWithBooking.has(watch.userId)) continue;

    const slot = availableByKey.get(slotKey(watch));
    if (slot) candidates.push({ watch, slot });
  }

  if (candidates.length === 0) return null;

  candidates.sort(comparePriority);
  return candidates[0] ?? null;
}

/** 우선순위 → 날짜 → 시각 순. 동점이면 빠른 회차를 먼저 시도한다. */
function comparePriority(a: ClaimTarget, b: ClaimTarget): number {
  if (a.watch.priority !== b.watch.priority) {
    return a.watch.priority - b.watch.priority;
  }
  if (a.watch.date !== b.watch.date) {
    return a.watch.date < b.watch.date ? -1 : 1;
  }
  return a.watch.time < b.watch.time ? -1 : a.watch.time > b.watch.time ? 1 : 0;
}

/**
 * 직전 스냅샷 대비 새로 열린 슬롯을 찾는다.
 *
 * 알림 중복 억제의 기준이다. 이미 열려 있던 슬롯을 매 틱마다 "새로 열렸다"고
 * 알리면 사용자는 알림을 무시하게 되고, 정작 중요한 알림을 놓친다.
 */
export function newlyAvailable(
  previous: readonly Slot[],
  current: readonly Slot[],
): readonly Slot[] {
  const wasAvailable = new Set(
    previous.filter((s) => s.status === 'AVAILABLE').map(slotKey),
  );
  return current.filter(
    (s) => s.status === 'AVAILABLE' && !wasAvailable.has(slotKey(s)),
  );
}
