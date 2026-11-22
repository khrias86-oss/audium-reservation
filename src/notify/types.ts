import type { Slot, Watch } from '../core/types.js';

export type Product = 'exhibition' | 'lecture';

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
      /**
       * 전시와 렉처는 예약 화면에서 처음 누르는 카드부터 다르다. 이 값이 없으면
       * 알림의 순서표 1번이 항상 "전시"라고 말하게 되는데, 렉처 감시자에게는
       * 틀린 안내다.
       */
      readonly product: Product;
    }
  | {
      readonly kind: 'SYSTEM_WARNING';
      readonly reason: string;
      /**
       * 같은 문제를 하나로 묶는 열쇠 (예: `contract:exhibition`). 같은 열쇠의 경고는
       * 이슈 하나에 모이고, 복구되면(SYSTEM_RECOVERED) 그 이슈가 닫힌다.
       */
      readonly key?: string;
    }
  | { readonly kind: 'SYSTEM_RECOVERED'; readonly key: string; readonly note: string }
  /** 직전 확인 때 "안 열림"이던 날짜가 열렸다 — 예약 오픈. */
  | { readonly kind: 'OPENED'; readonly product: Product; readonly dates: readonly string[] }
  /** 예약 오픈이 곧이라고 추정된다 (격주 규칙). `at`은 KST `YYYY-MM-DDTHH:MM:SS`. */
  | { readonly kind: 'OPENING_SOON'; readonly product: Product; readonly at: string };

export interface Notifier {
  /**
   * @returns 실제로 알렸으면 true, 중복이라 건너뛰었으면 false.
   *   이 값으로 가족 알림(메일·푸시)을 보낼지 정한다 — 중복 판정은 이슈가 들고 있다.
   */
  send(notification: Notification): Promise<boolean | void>;
}

const DOW = ['일', '월', '화', '수', '목', '금', '토'];

/**
 * `2026-12-03` → `목`. getDay()가 아니라 getUTCDay()를 쓴다 — +09:00을 붙여 로컬
 * Date로 만들면 *실행 환경의* 타임존으로 요일을 읽어, UTC로 도는 Actions에서
 * 하루 밀린다 (2026-09-19 토요일을 "금"으로 알린 적이 있다, 이슈 #15).
 */
export function dowName(date: string): string {
  return DOW[new Date(`${date}T00:00:00Z`).getUTCDay()]!;
}

/** `2026-12-03` → `12/3(목)`. */
export function shortDate(date: string): string {
  return `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}(${dowName(date)})`;
}

export const PRODUCT_NAME: Record<Product, string> = { exhibition: '전시', lecture: '렉처' };

/** 제목 접두사. 모바일에서 제목만 봐도 결과를 알 수 있어야 한다 (§3.2 원칙 5). */
export function subjectFor(n: Notification): string {
  switch (n.kind) {
    case 'BOOKED':
      return `[예약완료] 오디움 ${n.slot.date} ${n.slot.time} 예약이 확정되었습니다`;
    case 'NEEDS_ACTION':
      // 폰 알림에서는 제목이 거의 전부다. 무엇을 잡았는지가 먼저 와야 한다.
      return `🎉 오디움 자리 났습니다 — ${n.slot.date} ${n.slot.time} (지금 예약하세요)`;
    case 'SYSTEM_WARNING':
      return `[시스템경고] 오디움 감시 — ${n.reason.split('\n')[0]}`;
    case 'SYSTEM_RECOVERED':
      return `[복구] 오디움 감시 — ${n.note}`;
    case 'OPENED':
      return `📢 오디움 ${PRODUCT_NAME[n.product]} 예약이 열렸습니다 — ${n.dates.map(shortDate).join(', ')}`;
    case 'OPENING_SOON':
      return `⏰ 오늘 ${n.at.slice(11, 16)} 오디움 예약 오픈 예상 — 미리 준비하세요`;
  }
}
