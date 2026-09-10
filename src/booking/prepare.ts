import type { Slot } from '../core/types.js';
import { BOOKING_PAGE_URL, PRODUCT_SEQ } from '../adapters/audeum/contract.js';
import { extractReserveSeq } from '../adapters/audeum/parse-time-fragment.js';
import {
  buildTimeRequestBody,
  fetchSlotsForDate,
  type HttpFlowOptions,
  type Product,
} from '../adapters/audeum/http-flow.js';
import { FLOW, ORIGIN, REQUEST_HEADERS } from '../adapters/audeum/contract.js';

/**
 * 자리를 찾은 직후, 예약에 필요한 것을 모아 둔다.
 *
 * ## 왜 다시 확인하는가
 *
 * 감지와 알림 사이에 자리가 사라질 수 있다. 오디움은 회차를 고른 뒤 서버가 매진을
 * 한 번 더 확인하고 `rsMsg.message == "soldout"`으로 되돌린다 — 사이트 자신도
 * 목록의 여석을 최종 답으로 믿지 않는다는 뜻이다.
 *
 * 다시 확인하는 비용은 요청 한 건, 1초 안팎이다. 그 값으로 "자리 났다"고 알렸는데
 * 열어 보니 없는 상황을 막는다. 그 알림은 사용자를 뛰게 만들어 놓고 배신한다.
 *
 * ## 왜 seq를 챙기는가
 *
 * `seq_reserve`는 그 회차를 가리키는 사이트의 식별자다. 예약 화면을 여는 데
 * 필요하고(`seqExhibitionReserveList`), 날짜·시각 문자열보다 정확하다.
 * 사이트가 회차를 재편해도 이 값이 가리키는 대상은 흔들리지 않는다.
 */

export interface BookingPlan {
  readonly slot: Slot;
  /** 사이트가 이 회차에 붙인 식별자. 예약 화면을 여는 열쇠다. */
  readonly reserveSeq: string;
  readonly product: Product;
  /** 사람이 열 주소 */
  readonly bookingUrl: string;
}

export type PrepareResult =
  | { readonly kind: 'READY'; readonly plan: BookingPlan }
  /** 다시 확인해 보니 이미 나갔다. 알리지 않는 편이 낫다. */
  | { readonly kind: 'GONE'; readonly reason: string }
  /** 확인 자체를 못 했다. 자리가 있을 수도 있으므로 알리기는 한다. */
  | { readonly kind: 'UNVERIFIED'; readonly reason: string };

export async function prepareBooking(
  slot: Slot,
  product: Product = 'exhibition',
  options: HttpFlowOptions = {},
): Promise<PrepareResult> {
  const fresh = await fetchSlotsForDate(slot.date, product, options);

  if (fresh.kind === 'QUEUED') {
    return { kind: 'UNVERIFIED', reason: `재확인 중 대기열을 만났습니다 (${fresh.message})` };
  }
  if (fresh.kind === 'TRANSIENT_ERROR' || fresh.kind === 'CONTRACT_BROKEN') {
    const reason = fresh.kind === 'TRANSIENT_ERROR' ? fresh.reason : fresh.reason;
    return { kind: 'UNVERIFIED', reason: `재확인하지 못했습니다 (${reason})` };
  }

  const still = fresh.slots.find((s) => s.date === slot.date && s.time === slot.time);
  if (!still) {
    // 회차가 목록에서 통째로 빠졌다. 시간이 지났거나 사이트가 내렸다.
    return { kind: 'GONE', reason: '재확인 시점에 회차가 목록에 없습니다' };
  }
  if (still.status !== 'AVAILABLE') {
    return { kind: 'GONE', reason: '재확인 사이에 매진됐습니다' };
  }

  const seq = await fetchReserveSeq(slot.date, slot.time, product, options);
  if (seq === null) {
    // 여석은 확인했는데 식별자를 못 읽었다. 알림은 보내되 예약 링크는 일반 주소로 준다.
    return {
      kind: 'READY',
      plan: { slot: still, reserveSeq: '', product, bookingUrl: BOOKING_PAGE_URL },
    };
  }

  return {
    kind: 'READY',
    plan: { slot: still, reserveSeq: seq, product, bookingUrl: BOOKING_PAGE_URL },
  };
}

/** 회차 조각을 한 번 더 받아 `seq_reserve`를 읽는다. */
async function fetchReserveSeq(
  date: string,
  time: string,
  product: Product,
  options: HttpFlowOptions,
): Promise<string | null> {
  const doFetch = options.fetchImpl ?? fetch;
  const flow = product === 'exhibition' ? FLOW.exhibition : FLOW.lecture;
  try {
    const res = await doFetch(`${ORIGIN}${flow.time}`, {
      method: 'POST',
      headers: { ...REQUEST_HEADERS },
      body: buildTimeRequestBody(date, product),
      signal: AbortSignal.timeout(options.timeoutMs ?? 8_000),
    });
    if (!res.ok) return null;
    return extractReserveSeq(await res.text(), date, time);
  } catch {
    // 식별자를 못 얻어도 알림 자체는 나가야 한다. 없으면 없는 대로 진행한다.
    return null;
  }
}

/** 상품 식별자를 노출해 둔다 — 예약 화면을 여는 쪽에서 필요하다. */
export const productSeq = (product: Product): string => PRODUCT_SEQ[product];
