import * as cheerio from 'cheerio';
import type { ParseResult, Slot } from '../../core/types.js';
import { isQueuePage } from './contract.js';

/**
 * `/booking/time` 응답 조각에서 회차와 여석을 읽어낸다.
 *
 * 이 함수가 시스템 전체에서 가장 중요한 판단을 한다 — "자리가 있는가".
 * 브라우저 없이 문자열만으로 동작하므로 실제 사이트를 건드리지 않고 테스트할 수 있고,
 * 정찰로 캡처한 진짜 HTML을 픽스처로 쓴다.
 *
 * ## 실측한 구조 (10차 정찰, 2026-09-10)
 *
 * ```html
 * <div class="radio time-slots disabled-time-slots">   ← 매진이면 이 클래스가 붙는다
 *   <label>
 *     <span>13:30</span>
 *     <span>매진</span>                                 ← 매진이면 이 span이 있다
 *     <seq_reserve>2058</seq_reserve>                   ← 예약 식별자
 *     <spectate_date>2026-09-10</spectate_date>
 *     <spectate_time>13:30</spectate_time>
 *   </label>
 * </div>
 * ```
 *
 * 매진 판별의 근거는 사이트 자신의 클릭 핸들러다:
 * `if($(this).hasClass("disabled-time-slots")) return;`
 * 즉 이 클래스가 붙으면 사이트가 클릭 자체를 거부한다. 추측이 아니라 사이트의 규칙이다.
 */
export function parseTimeFragment(html: string): ParseResult {
  // 대기열이 실제 응답 자리에 오는 경우가 있다. 빈 목록으로 오해하면 안 된다.
  if (isQueuePage(html)) {
    return { kind: 'QUEUED', message: '회차 조회 중 대기열 페이지를 받았습니다' };
  }

  const $ = cheerio.load(html);
  const nodes = $('.time-slots');

  if (nodes.length === 0) {
    // 회차가 0개인 것은 정상일 수 있다(예약 오픈 전, 휴관일). 하지만 우리가 아는
    // 구조가 통째로 사라진 것일 수도 있다. 둘을 구분할 근거가 이 조각에는 없으므로,
    // 빈 응답이면 여석 없음이 아니라 "확인하지 못함"으로 돌려준다.
    return $.root().text().trim().length === 0
      ? { kind: 'CONTRACT_BROKEN', reason: '응답이 비어 있습니다 — 회차 조각을 받지 못했습니다', raw: html.slice(0, 500) }
      : { kind: 'OK', slots: [] };
  }

  const slots: Slot[] = [];

  for (const node of nodes.toArray()) {
    const $node = $(node);
    const date = $node.find('spectate_date').text().trim();
    const time = $node.find('spectate_time').text().trim();

    if (!date || !time) {
      // 회차는 있는데 날짜/시각을 못 읽었다면 구조가 바뀐 것이다.
      // 이 회차만 조용히 버리면 있는 자리를 놓치게 된다.
      return {
        kind: 'CONTRACT_BROKEN',
        reason: '회차에서 spectate_date/spectate_time을 읽지 못했습니다',
        raw: $.html($node).slice(0, 500),
      };
    }

    const soldOut = $node.hasClass('disabled-time-slots');

    slots.push({
      date,
      time,
      status: soldOut ? 'SOLD_OUT' : 'AVAILABLE',
      // 사이트는 잔여 좌석 수를 노출하지 않는다. 0으로 채우면 "자리 없음"으로
      // 오해되므로 모른다는 뜻의 null을 그대로 둔다.
      remain: null,
      capacity: null,
      bookUrl: 'https://audeum.org/booking',
    });
  }

  return { kind: 'OK', slots };
}

/** 회차의 예약 식별자(`seq_reserve`). 예약 제출 단계에서 필요하다. */
export function extractReserveSeq(html: string, date: string, time: string): string | null {
  const $ = cheerio.load(html);
  for (const node of $('.time-slots').toArray()) {
    const $node = $(node);
    if ($node.find('spectate_date').text().trim() === date &&
        $node.find('spectate_time').text().trim() === time) {
      return $node.find('seq_reserve').text().trim() || null;
    }
  }
  return null;
}
