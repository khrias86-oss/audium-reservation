import { isQueuePage } from './contract.js';

/**
 * `/booking/date` 응답에서 **예약이 열린 날짜**를 읽어낸다.
 *
 * 15차 정찰에서 발견했다. 사이트는 달력을 그리려고 날짜 목록을 조각 안에 JSON으로
 * 실어 보낸다.
 *
 * ```js
 * bookingDate.reserveList = [
 *   {"SPECTATE_DATE":"2026-09-10","RESERVE_OPEN_DATETIME":"2026-09-08T14:00:00"},
 *   ...
 * ];
 * ```
 *
 * ## 왜 이것이 중요한가
 *
 * 지금까지는 "목·금·토"라는 규칙으로 어림했다. 하지만 이 목록이 **사실**이다.
 * 예약이 격주로 열리므로 달력상 목·금·토라도 아직 열리지 않은 날이 대부분이고,
 * 그런 날짜를 물어보는 것은 매번 헛도는 요청이다.
 *
 * 열린 날짜만 물어보면 요청 수가 줄고, 사용자에게도 "그 날짜는 아직 예약이
 * 열리지 않았습니다"라고 정확히 말해 줄 수 있다 — "자리 없음"과는 전혀 다른 말이다.
 */

export interface OpenDate {
  /** 관람 날짜 `YYYY-MM-DD` */
  readonly date: string;
  /** 예약이 열린(열릴) 시각. 사이트가 KST로 준다. */
  readonly opensAt: string | null;
}

export type DateFragmentResult =
  | { readonly kind: 'OK'; readonly dates: readonly OpenDate[] }
  | { readonly kind: 'QUEUED'; readonly message: string }
  | { readonly kind: 'CONTRACT_BROKEN'; readonly reason: string };

/** `reserveList = [...]` 배열만 정확히 떼어낸다. */
const RESERVE_LIST = /reserveList\s*=\s*(\[[\s\S]*?\])\s*;/;

export function parseDateFragment(html: string): DateFragmentResult {
  if (isQueuePage(html)) {
    return { kind: 'QUEUED', message: '날짜 조회 중 대기열 페이지를 받았습니다' };
  }

  const match = html.match(RESERVE_LIST);
  if (!match?.[1]) {
    // 목록이 없는 것과 구조가 바뀐 것을 구분할 근거가 없다. 빈 배열로 넘기면
    // "예약 열린 날짜가 하나도 없다"가 되어 감시가 통째로 멈춘다 — 조용한 실패다.
    return { kind: 'CONTRACT_BROKEN', reason: '날짜 조각에서 reserveList를 찾지 못했습니다' };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(match[1]);
  } catch {
    return { kind: 'CONTRACT_BROKEN', reason: 'reserveList가 JSON으로 읽히지 않습니다' };
  }

  if (!Array.isArray(raw)) {
    return { kind: 'CONTRACT_BROKEN', reason: 'reserveList가 배열이 아닙니다' };
  }

  const dates: OpenDate[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const date = record['SPECTATE_DATE'];
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      // 키 이름이 바뀌었다는 뜻이다. 조용히 버리면 열린 날짜를 통째로 놓친다.
      return {
        kind: 'CONTRACT_BROKEN',
        reason: `reserveList 항목에서 SPECTATE_DATE를 읽지 못했습니다 (${JSON.stringify(entry).slice(0, 120)})`,
      };
    }
    const opensAt = record['RESERVE_OPEN_DATETIME'];
    dates.push({ date, opensAt: typeof opensAt === 'string' ? opensAt : null });
  }

  // 사이트가 "현재 예약이 완료되었습니다"를 띄우는 경우 목록이 비어 있는 것이 정상이다.
  return { kind: 'OK', dates };
}
