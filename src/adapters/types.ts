import type { ParseResult, Slot } from '../core/types.js';

/**
 * 사이트 어댑터가 지켜야 할 계약.
 *
 * 오디움 구현체(`./audeum/`)는 M1 정찰이 끝난 뒤에만 채운다.
 * 정찰 전에 셀렉터나 엔드포인트를 추측해서 넣지 않는다 —
 * 틀린 계약 위에 쌓은 코드는 전부 다시 써야 한다.
 */
export interface SiteAdapter {
  readonly name: string;

  /** 지정한 달의 슬롯 전체를 조회해 정규화한다. */
  fetchSlots(month: string): Promise<ParseResult>;

  /**
   * 예약을 제출한다.
   *
   * 구현체는 `DRY_RUN !== 'false'`이면 반드시 `{ kind: 'SIMULATED' }`를 반환하고
   * 실제 요청을 보내지 않아야 한다.
   */
  submitBooking(slot: Slot, applicant: Applicant): Promise<BookingOutcome>;
}

export interface Applicant {
  readonly name: string;
  readonly phone: string;
  readonly email: string;
}

export type BookingOutcome =
  | { readonly kind: 'BOOKED'; readonly confirmationId: string | null }
  | { readonly kind: 'SIMULATED'; readonly payload: unknown }
  /** 그 사이 남이 채갔다. 재시도할 가치가 없다. */
  | { readonly kind: 'SLOT_TAKEN' }
  /** CAPTCHA·본인인증·로그인 만료 등 사람이 개입해야 하는 지점 (§2.6) */
  | { readonly kind: 'NEEDS_HUMAN'; readonly reason: string; readonly resumeUrl: string | null }
  /** 일시적 오류. 재시도 대상. */
  | { readonly kind: 'RETRYABLE_ERROR'; readonly reason: string };
