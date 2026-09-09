/**
 * 오디움 사이트 계약 — **M1 정찰 완료 후에만 채운다.**
 *
 * 셀렉터·URL·응답 스키마는 이 파일 밖에 존재해서는 안 된다.
 * 사이트가 개편되면 여기 하나만 고치면 되도록 유지한다.
 *
 * 채우는 방법: `/recon` 슬래시 커맨드를 실행하고 `docs/site-contract.md`를 먼저 확정한 뒤,
 * 그 문서의 표를 이 파일로 옮긴다.
 */

export const BOOKING_PAGE_URL = 'https://audeum.org/booking';

/** M1에서 확정할 항목들. 하나라도 null이면 어댑터를 실행하지 않는다. */
export interface AudeumContract {
  /** 'SSR' | 'SPA' */
  readonly rendering: 'SSR' | 'SPA' | null;
  /** 월별 가용일 조회 엔드포인트 */
  readonly monthEndpoint: string | null;
  /** 회차 조회 엔드포인트 */
  readonly slotEndpoint: string | null;
  /** 예약 제출 엔드포인트 */
  readonly submitEndpoint: string | null;
  /** 매진 판별 1순위 신호 */
  readonly soldOutSignal: string | null;
}

export const CONTRACT: AudeumContract = {
  rendering: null,
  monthEndpoint: null,
  slotEndpoint: null,
  submitEndpoint: null,
  soldOutSignal: null,
};

/** 계약이 채워지기 전에 어댑터가 실행되는 것을 막는다. */
export function assertContractReady(contract: AudeumContract = CONTRACT): void {
  const missing = Object.entries(contract)
    .filter(([, value]) => value === null)
    .map(([key]) => key);

  if (missing.length > 0) {
    throw new Error(
      `사이트 계약이 아직 확정되지 않았습니다 (미확인: ${missing.join(', ')}). ` +
        '`/recon`을 실행해 docs/site-contract.md를 먼저 완성하세요.',
    );
  }
}
