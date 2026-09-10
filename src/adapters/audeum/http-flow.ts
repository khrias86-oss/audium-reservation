import type { ParseResult, Slot } from '../../core/types.js';
import {
  FLOW,
  ORIGIN,
  PRODUCT_SEQ,
  REQUEST_FIELDS,
  REQUEST_HEADERS,
  isQueuePage,
} from './contract.js';
import { parseTimeFragment } from './parse-time-fragment.js';
import { parseDateFragment, type DateFragmentResult } from './parse-date-fragment.js';

/**
 * 브라우저 없이 회차 정보를 가져온다.
 *
 * ## 왜 브라우저를 버렸는가
 *
 * 11차 정찰에서 실제 요청을 캡처해 보니, 회차 조회는 쿠키도 토큰도 선행 요청도
 * 없는 폼 POST 하나였다. 브라우저는 그 POST를 만들어내려고 돌리던 것이지,
 * 답을 얻는 데 필요한 것이 아니었다.
 *
 * 비용 차이가 크다. 브라우저 방식은 확인 1회에 약 44초가 들었다 — 크로미움 설치
 * 23초, 페이지 조작 21초. 이 방식은 요청 1건이므로 1초 안팎이다. 무료 한도가
 * 분 단위로 청구되는 곳에서 이 차이는 **감시를 계속할 수 있느냐 없느냐**를 가른다.
 *
 * ## 무엇을 하지 않는가
 *
 * 이 모듈은 조회만 한다. `/booking/payment`도, `#btn_reserve`도 건드리지 않는다.
 * 제출은 별도 모듈에서 `DRY_RUN` 관문을 통과한 경우에만 이뤄진다.
 */

export type Product = 'exhibition' | 'lecture';

export interface HttpFlowOptions {
  /** 요청 1건의 제한 시간. 확인 전체가 10초를 넘지 않도록 잡는다. */
  readonly timeoutMs?: number;
  /** 테스트에서 갈아끼우기 위한 주입점 */
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * 예약이 열린 날짜를 사이트에 물어본다.
 *
 * "목·금·토"라는 규칙으로 어림하는 대신 사이트가 실제로 여는 날짜를 받는다.
 * 예약이 격주로 열리므로 달력상 목·금·토라도 아직 안 열린 날이 대부분이고,
 * 그런 날짜의 회차를 물어보는 것은 매번 헛도는 요청이다.
 *
 * 요청 한 건 값으로 "그 날은 아직 예약이 열리지 않았습니다"를 정확히 말해 줄 수
 * 있게 된다 — "자리 없음"과는 전혀 다른 말이고, 사용자에게도 그렇다.
 */
export async function fetchOpenDates(
  product: Product = 'exhibition',
  options: HttpFlowOptions = {},
): Promise<DateFragmentResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const flow = product === 'exhibition' ? FLOW.exhibition : FLOW.lecture;
  const params = new URLSearchParams();
  params.set(REQUEST_FIELDS.locale, 'ko');
  params.set(
    product === 'exhibition' ? REQUEST_FIELDS.seqExhibition : REQUEST_FIELDS.seqProgram,
    PRODUCT_SEQ[product],
  );
  params.set(REQUEST_FIELDS.language, 'ko');

  try {
    const res = await doFetch(`${ORIGIN}${flow.date}`, {
      method: 'POST',
      headers: { ...REQUEST_HEADERS },
      body: params.toString(),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) {
      // 못 물어봤다고 감시를 멈추면 안 된다. 호출부가 날짜 전부를 확인하도록 둔다.
      return { kind: 'CONTRACT_BROKEN', reason: `날짜 목록 요청이 ${res.status}로 실패했습니다` };
    }
    return parseDateFragment(await res.text());
  } catch (error) {
    return {
      kind: 'CONTRACT_BROKEN',
      reason: `날짜 목록을 받지 못했습니다: ${describe(error)}`,
    };
  }
}

/** 사이트가 쓰는 폼 본문을 그대로 만든다. */
export function buildTimeRequestBody(date: string, product: Product): string {
  const params = new URLSearchParams();
  params.set(REQUEST_FIELDS.locale, 'ko');
  params.set(REQUEST_FIELDS.spectateDate, date);
  params.set(
    product === 'exhibition' ? REQUEST_FIELDS.seqExhibition : REQUEST_FIELDS.seqProgram,
    PRODUCT_SEQ[product],
  );
  params.set(REQUEST_FIELDS.language, 'ko');
  return params.toString();
}

/**
 * 한 날짜의 회차를 조회한다.
 *
 * 실패를 네 가지로 구분해 돌려준다. 이 구분이 시스템의 핵심이다 —
 * "자리 없음"과 "사이트가 대기열을 띄웠음"과 "우리 파서가 깨졌음"을 뭉뚱그리면
 * 빈자리가 나도 조용히 놓친다.
 */
export async function fetchSlotsForDate(
  date: string,
  product: Product = 'exhibition',
  options: HttpFlowOptions = {},
): Promise<ParseResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const flow = product === 'exhibition' ? FLOW.exhibition : FLOW.lecture;

  let response: Response;
  try {
    response = await doFetch(`${ORIGIN}${flow.time}`, {
      method: 'POST',
      headers: { ...REQUEST_HEADERS },
      body: buildTimeRequestBody(date, product),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    });
  } catch (error) {
    return {
      kind: 'TRANSIENT_ERROR',
      reason: `${date} 회차를 요청하지 못했습니다: ${describe(error)}`,
    };
  }

  if (response.status >= 500) {
    // 사이트 쪽 장애다. 우리 계약이 깨진 것과는 다르므로 경보를 울리지 않는다.
    return { kind: 'TRANSIENT_ERROR', reason: `${date}: 사이트가 ${response.status}를 반환했습니다` };
  }

  if (!response.ok) {
    // 4xx는 우리가 잘못된 요청을 보내고 있다는 뜻이다. 상품 번호가 바뀌었을 때
    // 여기로 온다. "자리 없음"으로 넘기면 개편을 영영 눈치채지 못한다.
    return {
      kind: 'CONTRACT_BROKEN',
      reason: `${date}: 회차 요청이 ${response.status}로 거부됐습니다 — 상품 번호나 파라미터가 바뀌었을 수 있습니다`,
    };
  }

  let html: string;
  try {
    html = await response.text();
  } catch (error) {
    return { kind: 'TRANSIENT_ERROR', reason: `${date}: 응답 본문을 읽지 못했습니다 (${describe(error)})` };
  }

  if (isQueuePage(html)) {
    return { kind: 'QUEUED', message: `${date} 조회 중 대기열 페이지를 받았습니다` };
  }

  return parseTimeFragment(html);
}

export interface MultiDateResult {
  /** 합쳐진 결과. 날짜 하나라도 계약이 깨지면 전체가 CONTRACT_BROKEN이다. */
  readonly result: ParseResult;
  /** 날짜별 결과 — 어느 날짜에서 무슨 일이 있었는지 로그에 남긴다. */
  readonly perDate: ReadonlyMap<string, ParseResult>;
  /** 전체 소요 시간(ms). 10초 예산을 지키는지 확인한다. */
  readonly elapsedMs: number;
}

/**
 * 여러 날짜를 **동시에** 조회한다.
 *
 * 순차로 돌리면 날짜 수만큼 시간이 늘어난다. 요청끼리 의존이 없으므로 병렬로 보내면
 * 전체 시간이 가장 느린 요청 하나로 수렴한다. 사용자가 보통 감시하는 날짜는
 * 한두 개이고, 많아야 대여섯 개다.
 */
export async function fetchSlotsForDates(
  dates: readonly string[],
  product: Product = 'exhibition',
  options: HttpFlowOptions = {},
): Promise<MultiDateResult> {
  const started = Date.now();
  const unique = [...new Set(dates)];

  const settled = await Promise.all(
    unique.map(async (date) => [date, await fetchSlotsForDate(date, product, options)] as const),
  );
  const perDate = new Map(settled);
  const elapsedMs = Date.now() - started;

  // 계약 파손이 하나라도 있으면 전체를 신뢰하지 않는다. 나머지 날짜가 "자리 없음"으로
  // 보이더라도 그 판단의 근거가 흔들린 상태이기 때문이다.
  const broken = settled.find(([, r]) => r.kind === 'CONTRACT_BROKEN');
  if (broken) return { result: broken[1], perDate, elapsedMs };

  const slots: Slot[] = [];
  let sawOk = false;
  for (const [, r] of settled) {
    if (r.kind !== 'OK') continue;
    sawOk = true;
    slots.push(...r.slots);
  }

  if (sawOk) return { result: { kind: 'OK', slots }, perDate, elapsedMs };

  // 성공한 날짜가 하나도 없다. 대기열이 섞여 있으면 대기열로 본다 — 다음 회차에
  // 다시 시도하면 되는 상황이고, 서킷을 열 이유가 아니다.
  const queued = settled.find(([, r]) => r.kind === 'QUEUED');
  if (queued) return { result: queued[1], perDate, elapsedMs };

  const transient = settled.find(([, r]) => r.kind === 'TRANSIENT_ERROR');
  if (transient) return { result: transient[1], perDate, elapsedMs };

  return {
    result: { kind: 'TRANSIENT_ERROR', reason: '조회할 날짜가 없습니다' },
    perDate,
    elapsedMs,
  };
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.name === 'TimeoutError' ? '제한 시간을 넘겼습니다' : error.message;
  }
  return String(error);
}
