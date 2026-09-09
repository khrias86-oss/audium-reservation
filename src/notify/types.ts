import type { Slot, Watch } from '../core/types.js';

export type Notification =
  | { readonly kind: 'BOOKED'; readonly watch: Watch; readonly slot: Slot; readonly confirmationId: string | null }
  | { readonly kind: 'NEEDS_ACTION'; readonly watch: Watch; readonly slot: Slot; readonly reason: string; readonly resumeUrl: string | null }
  | { readonly kind: 'SYSTEM_WARNING'; readonly reason: string };

export interface Notifier {
  send(notification: Notification): Promise<void>;
}

/** 제목 접두사. 모바일에서 제목만 봐도 결과를 알 수 있어야 한다 (§3.2 원칙 5). */
export function subjectFor(n: Notification): string {
  switch (n.kind) {
    case 'BOOKED':
      return `[예약완료] 오디움 ${n.slot.date} ${n.slot.time} 예약이 확정되었습니다`;
    case 'NEEDS_ACTION':
      return `[조치필요] 오디움 ${n.slot.date} ${n.slot.time} — ${n.reason}`;
    case 'SYSTEM_WARNING':
      return `[시스템경고] 오디움 감시 — ${n.reason}`;
  }
}
