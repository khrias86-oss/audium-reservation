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

/**
 * 예약 플로우의 엔드포인트 — **8차 정찰에서 사이트 인라인 스크립트로 확인**했다.
 *
 * 전시(도슨트)와 렉처가 대칭 구조이고, 응답은 JSON이 아니라 HTML 조각이다.
 * 각 조각은 지정된 컨테이너에 `.html(e)`로 주입된다.
 */
export const FLOW = {
  exhibition: {
    /** 연령·인원 선택 조각 */
    age: '/booking/age',
    /** 날짜·회차 조각 — 여석 판단의 근거가 여기서 온다 */
    date: '/booking/date',
    /** 제출. **자동화에서 호출하지 않는다** */
    payment: '/booking/payment',
    /** 상품 목록에서 이 항목을 고른다 */
    itemSelector: '.exhibition-list-container .exhibition-item.exhibition',
  },
  lecture: {
    age: '/programs/age',
    date: '/programs/date',
    payment: '/programs/payment',
    itemSelector: '.exhibition-list-container .exhibition-item.program',
  },
} as const;

/** 조각이 주입되는 컨테이너. 렌더 완료를 기다릴 때 쓴다. */
export const CONTAINERS = {
  age: '.exhibition-wrapper',
  date: '.exhibition-date-wrapper',
  payment: '.payment-form',
} as const;

/**
 * 상품 선택에 3초 쿨다운이 걸려 있다 (`isClick` 플래그 + `setTimeout(...,3000)`).
 * 이보다 빨리 다시 클릭하면 사이트가 무시한다.
 */
export const ITEM_CLICK_COOLDOWN_MS = 3_000;

/**
 * 매진을 알리는 문자열 — 사이트가 `com.msg()`로 띄운다.
 *
 * 사이트 소스의 주석이 판별 시점을 알려준다: "4) 시간을 선택하면 매진 여부를
 * 체크하고", "매진시 재조회". 즉 **날짜 목록에 회차가 보인다고 예약 가능한 것이
 * 아니다** — 회차를 고른 뒤에야 확정된다. 어댑터는 이 순서를 지켜야 한다.
 */
export const SOLD_OUT_MESSAGE = '예약가능한 시간이 아닙니다';

/**
 * 예약자 입력 필드. 지금까지 확인된 것은 이름과 이메일뿐이다.
 * `btn_reserve`는 제출 버튼이므로 **자동화가 클릭해서는 안 된다**
 * (`DRY_RUN=false`가 명시된 M6 이후에만).
 */
export const FORM_FIELDS = {
  name: '#input_spectatorNm',
  email: '#input_spectatorEmail',
  submitButton: '#btn_reserve',
  reserveTimeLabel: '#txt_reserveTime',
} as const;

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

  // 확인됨 (8차): jQuery AJAX가 HTML 조각을 주입하는 방식이다.
  rendering: 'SPA',

  // 확인됨 (8차): 날짜·회차 조각의 출처.
  slotPageUrl: FLOW.exhibition.date,

  // 확인됨 (8차). 다만 이 값이 채워졌다고 제출이 허용되는 것은 아니다 —
  // DRY_RUN 게이트가 별도로 막는다.
  submitEndpoint: FLOW.exhibition.payment,

  // 확인됨 (8차): 매진은 회차 선택 시점에 이 메시지로 드러난다.
  soldOutSignal: SOLD_OUT_MESSAGE,

  // 미확인: 대기열 통과 비용을 아직 측정하지 못했다. 6·8차는 1회 만에 통과했지만
  // 혼잡 시간대 표본이 없어 폴링 예산을 정할 근거로는 부족하다.
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
