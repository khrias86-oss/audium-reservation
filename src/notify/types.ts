import type { Slot, Watch } from '../core/types.js';

export type Notification =
  | { readonly kind: 'BOOKED'; readonly watch: Watch; readonly slot: Slot; readonly confirmationId: string | null }
  | {
      readonly kind: 'NEEDS_ACTION';
      readonly watch: Watch;
      readonly slot: Slot;
      readonly reason: string;
      readonly resumeUrl: string | null;
      /** 사이트가 이 회차에 붙인 식별자. 화면에서 어느 회차인지 짚어 준다. */
      readonly reserveSeq?: string | null;
    }
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
      // 폰 알림에서는 제목이 거의 전부다. 무엇을 잡았는지가 먼저 와야 한다.
      return `🎉 오디움 자리 났습니다 — ${n.slot.date} ${n.slot.time} (지금 예약하세요)`;
    case 'SYSTEM_WARNING':
      return `[시스템경고] 오디움 감시 — ${n.reason}`;
  }
}
