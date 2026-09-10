/**
 * 오디움 사이트 계약.
 *
 * 셀렉터·URL·응답 스키마는 이 파일 밖에 존재해서는 안 된다.
 * 사이트가 개편되면 여기 하나만 고치면 되도록 유지한다.
 *
 * **실측으로 확인된 것만 채운다.** 미확인 항목은 null로 두고,
 * `assertContractReady()`가 어댑터 실행을 막는다.
 */

export const BOOKING_PAGE_URL = 'https://audeum.org/booking';

/**
 * 가상 대기열 페이지의 지문 — **5차 정찰에서 실제로 관측한 문구다.**
 *
 * 사이트는 혼잡 시 실제 페이지 대신 이 페이지를 HTTP 200으로 반환한다.
 * 상태 코드로는 구분할 수 없으므로 본문으로 판별해야 한다.
 *
 * 이 판별이 틀리면 시스템이 조용히 실패한다 — 대기열을 "여석 없음"으로 읽으면
 * 빈자리가 나도 영원히 잡지 못하고, 겉보기에는 정상으로 보인다.
 */
export const QUEUE_MARKERS = [
  '동시접속자가 많아',
  'high volume of traffic',
  'Please give us a moment',
] as const;

/**
 * 응답이 대기열 페이지인지 판별한다.
 *
 * 여러 지문 중 하나만 맞아도 대기열로 본다. 사이트가 문구를 조금 바꾸거나
 * 언어에 따라 다르게 보여줘도 놓치지 않기 위해서다. 대기열을 놓치는 쪽이
 * 대기열로 오판하는 쪽보다 훨씬 손해가 크다 — 전자는 영원한 침묵이고,
 * 후자는 한 틱을 건너뛸 뿐이다.
 */
export function isQueuePage(pageText: string): boolean {
  return QUEUE_MARKERS.some((marker) => pageText.includes(marker));
}

/** M1에서 확정할 항목들. 하나라도 null이면 어댑터를 실행하지 않는다. */
export interface AudeumContract {
  /** 예약 흐름의 시작점 — 티켓 종류 선택 페이지 */
  readonly entryUrl: string;
  /** 렌더링 방식 */
  readonly rendering: 'SSR' | 'SPA' | null;
  /** 회차·잔여석이 실린 페이지 URL */
  readonly slotPageUrl: string | null;
  /** 예약 제출 엔드포인트 */
  readonly submitEndpoint: string | null;
  /** 매진 판별 1순위 신호 */
  readonly soldOutSignal: string | null;
  /** 대기열 통과에 필요한 평균 재시도 횟수 (폴링 예산 산정용) */
  readonly queueRetriesNeeded: number | null;
}

export const CONTRACT: AudeumContract = {
  // 확인됨 (정찰 2~3차): /booking은 티켓 종류(전시/강의) 선택 페이지다.
  entryUrl: BOOKING_PAGE_URL,

  // 미확인 — 대기열 뒤에 가려 아직 실물을 보지 못했다.
  rendering: null,
  slotPageUrl: null,
  submitEndpoint: null,
  soldOutSignal: null,
  queueRetriesNeeded: null,
};

/** 계약이 채워지기 전에 어댑터가 실행되는 것을 막는다. */
export function assertContractReady(contract: AudeumContract = CONTRACT): void {
  const missing = Object.entries(contract)
    .filter(([, value]) => value === null)
    .map(([key]) => key);

  if (missing.length > 0) {
    throw new Error(
      `사이트 계약이 아직 확정되지 않았습니다 (미확인: ${missing.join(', ')}). ` +
        '정찰(.github/workflows/recon.yml)을 실행해 docs/site-contract.md를 먼저 완성하세요.',
    );
  }
}
