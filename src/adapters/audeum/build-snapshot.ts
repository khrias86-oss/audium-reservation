import type { Slot } from '../../core/types.js';
import { toKstDateString } from '../../core/time.js';
import type { OpenDate } from './parse-date-fragment.js';

/**
 * 프로그램(전시/렉처) 하나의 당월 달력 상태를 만든다.
 *
 * ## 왜 "요일 규칙"을 쓰지 않는가
 *
 * 이전에는 "목·금·토만 운영"이라는 규칙으로 달력을 그렸다. 이건 전시 쪽만 실측한
 * 값이고 렉처가 같은 요일에 여는지는 확인한 적이 없다 — 추측으로 셀렉터나
 * 엔드포인트를 쓰지 않는 것과 같은 이유로, 요일도 추측하지 않는다.
 *
 * 사이트가 이미 "어느 날짜가 예약 가능한지"를 `/booking/date` 응답으로 알려준다
 * (`fetchOpenDates`). 그러니 하루의 상태는 **그 목록에 있느냐 없느냐**와
 * **거기서 회차가 있느냐**만으로 결정한다. 요일 가정이 전혀 필요 없다.
 */

export type DayState =
  | 'PAST'        // 이미 지난 날 — 볼 필요 없다
  | 'NOT_OPEN'    // 사이트가 예약 가능하다고 밝히지 않은 날 (휴관이거나 아직 안 열림)
  | 'SOLD_OUT'    // 예약은 열렸지만 모든 회차가 매진
  | 'AVAILABLE';  // 예약이 열렸고 회차가 하나 이상 비어 있음

export interface DaySnapshot {
  readonly date: string;
  /** 0=일 … 6=토. 프론트가 달력 grid를 짤 때 다시 계산하지 않아도 되게 넣어 둔다. */
  readonly dow: number;
  readonly state: DayState;
  /** SOLD_OUT/AVAILABLE일 때만 채워진다 — 그 외엔 사이트가 회차를 안 줬다는 뜻이다. */
  readonly slots?: readonly { readonly time: string; readonly available: boolean }[];
  /** 사이트가 밝힌 오픈 예정 시각. NOT_OPEN일 때만 의미가 있다. */
  readonly opensAt?: string | null;
}

export interface ProductSnapshot {
  readonly product: 'exhibition' | 'lecture';
  /** 달력에 그릴 월. `YYYY-MM` */
  readonly month: string;
  readonly days: readonly DaySnapshot[];
}

export interface FullSnapshot {
  readonly generatedAt: string;
  readonly products: readonly ProductSnapshot[];
}

/** 당월 1일부터 말일까지의 날짜 문자열. 이번 달이 며칠까지인지는 달력이 안다. */
function daysOfMonth(monthStart: string): string[] {
  const [y, m] = monthStart.split('-').map(Number) as [number, number];
  const total = new Date(y, m, 0).getDate(); // 다음 달 0일 = 이번 달 마지막 날
  return Array.from({ length: total }, (_, i) => {
    const d = String(i + 1).padStart(2, '0');
    return `${monthStart}-${d}`;
  });
}

/**
 * 하루 치 회차 목록에서 하루의 상태를 결정한다.
 * 빈 배열이면 "회차가 없는 날"이 아니라 "이 함수를 부르지 말았어야 할 날"이다 —
 * 호출부가 openDates에 있는 날짜에만 이걸 부르므로, 빈 배열은 실제로 회차가
 * 0개라는 뜻(휴관일이 openDates에 섞여 있는 경우)이고, 그때도 SOLD_OUT으로 본다 —
 * "이 날은 볼 게 없다"는 점에서 결과가 같다.
 */
function stateFromSlots(slots: readonly Slot[]): DayState {
  return slots.some((s) => s.status === 'AVAILABLE') ? 'AVAILABLE' : 'SOLD_OUT';
}

/**
 * 한 프로그램의 당월 스냅샷을 만든다.
 *
 * @param today KST 기준 오늘 날짜 (`YYYY-MM-DD`). 과거/현재 판별의 기준이다.
 * @param openDates 사이트가 예약 가능하다고 밝힌 날짜 (실측, `fetchOpenDates`).
 * @param slotsByDate 그 중 실제로 조회한 날짜들의 회차 목록 (`fetchSlotsForDates`).
 *   openDates에는 있지만 이 맵에 없는 날짜는 조회하지 않은 것으로 보고 NOT_OPEN
 *   과는 다른, 하지만 지금 우리가 가진 정보로는 구분할 근거가 없으므로 SOLD_OUT과
 *   같게 취급하지 않고 그대로 제외한다 — 호출부가 openDates 전부를 조회하는 것을
 *   전제로 하며, 그러지 않으면 이 함수가 아니라 호출부의 책임이다.
 */
export function buildProductSnapshot(
  product: 'exhibition' | 'lecture',
  today: string,
  openDates: readonly OpenDate[],
  slotsByDate: ReadonlyMap<string, readonly Slot[]>,
): ProductSnapshot {
  const month = today.slice(0, 7);
  const openByDate = new Map(openDates.map((d) => [d.date, d]));

  const days: DaySnapshot[] = daysOfMonth(month).map((date) => {
    // getUTCDay()를 쓴다. +09:00을 붙여 로컬 Date로 만들면 .getDay()가
    // *실행 환경의* 시스템 타임존으로 요일을 읽어서, UTC로 도는 CI에서는
    // 하루 밀린 요일이 나온다 — 실제로 그렇게 틀렸다. 날짜 문자열 자체가
    // 이미 KST 달력일이므로, UTC 자정으로 파싱해 UTC로 요일만 읽으면
    // 실행 환경과 무관하게 항상 같은 답이 나온다.
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();

    if (date < today) return { date, dow, state: 'PAST' };

    const open = openByDate.get(date);
    if (!open) return { date, dow, state: 'NOT_OPEN', opensAt: null };

    const slots = slotsByDate.get(date);
    if (!slots) return { date, dow, state: 'NOT_OPEN', opensAt: open.opensAt };

    return {
      date, dow,
      state: stateFromSlots(slots),
      slots: slots.map((s) => ({ time: s.time, available: s.status === 'AVAILABLE' })),
    };
  });

  return { product, month, days };
}

/** 지금 이 순간의 스냅샷 전체를 어제/오늘 어느 시각에 만들었는지 기록해 감싼다. */
export function wrapSnapshot(
  now: Date,
  products: readonly ProductSnapshot[],
): FullSnapshot {
  return { generatedAt: now.toISOString(), products };
}

export { toKstDateString };
