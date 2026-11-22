import type { Slot } from '../../core/types.js';
import { toKstDateString } from '../../core/time.js';
import type { OpenDate } from './parse-date-fragment.js';

/**
 * 프로그램(전시/렉처) 하나의 달력 상태를 만든다 — 이번 달과 다음 달.
 *
 * ## 왜 "요일 규칙"을 쓰지 않는가
 *
 * 이전에는 "목·금·토만 운영"이라는 규칙으로 달력을 그렸다. 이건 전시 쪽만 실측한
 * 값이고 렉처가 같은 요일에 여는지는 확인한 적이 없었다 — 추측으로 셀렉터나
 * 엔드포인트를 쓰지 않는 것과 같은 이유로, 요일도 추측하지 않는다.
 *
 * 사이트가 이미 "어느 날짜가 예약 가능한지"를 `/booking/date` 응답으로 알려준다
 * (`fetchOpenDates`). 그러니 하루의 상태는 **그 목록에 있느냐 없느냐**와
 * **거기서 회차가 있느냐**만으로 결정한다.
 *
 * ## 왜 다음 달까지 그리는가
 *
 * 이번 달만 그리면 월말에는 달력이 거의 비고, 다음 달 예약이 열려도 화면에 보이지
 * 않는다 (2026-11-22에 실제로 그랬다).
 */

export type DayState =
  | 'PAST'        // 이미 지난 날 — 볼 필요 없다
  | 'NOT_OPEN'    // 사이트가 예약 가능하다고 밝히지 않은 날 (휴관이거나 아직 안 열림)
  | 'SOLD_OUT'    // 예약은 열렸지만 모든 회차가 매진
  | 'AVAILABLE'   // 예약이 열렸고 회차가 하나 이상 비어 있음
  | 'UNKNOWN';    // 조회에 실패해 모른다 — "안 열림"으로 위장하면 안 된다

export interface DaySnapshot {
  readonly date: string;
  /** 0=일 … 6=토. 프론트가 달력 grid를 짤 때 다시 계산하지 않아도 되게 넣어 둔다. */
  readonly dow: number;
  readonly state: DayState;
  /** SOLD_OUT/AVAILABLE일 때만 채워진다 — 그 외엔 사이트가 회차를 안 줬다는 뜻이다. */
  readonly slots?: readonly { readonly time: string; readonly available: boolean }[];
  /** 사이트가 밝힌 예약 오픈 시각 (KST, `2026-09-08T14:00:00`). 열린 날짜에만 있다. */
  readonly opensAt?: string | null;
}

export interface ProductSnapshot {
  readonly product: 'exhibition' | 'lecture';
  /** 첫 달 `YYYY-MM`. 예전 스키마와의 호환을 위해 남겨 둔다. */
  readonly month: string;
  /** 그리는 달들 `YYYY-MM` (이번 달, 다음 달). `days`는 이 달들을 이어 붙인 것이다. */
  readonly months: readonly string[];
  readonly days: readonly DaySnapshot[];
  /** 날짜 목록 자체를 못 받았을 때의 이유. 있으면 지나지 않은 날은 전부 UNKNOWN이다. */
  readonly error?: string;
  /** 다음 예약 오픈 예상 시각 (KST). 격주 규칙으로 추정한 값이라 틀릴 수 있다. */
  readonly nextOpenGuess?: string | null;
}

export interface FullSnapshot {
  readonly generatedAt: string;
  readonly products: readonly ProductSnapshot[];
}

/** `YYYY-MM`에서 n달 뒤의 `YYYY-MM`. */
function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const total = y * 12 + (m - 1) + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

function daysOfMonth(month: string): string[] {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const total = new Date(Date.UTC(y, m, 0)).getUTCDate(); // 다음 달 0일 = 이번 달 마지막 날
  return Array.from({ length: total }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
}

function stateFromSlots(slots: readonly Slot[]): DayState {
  return slots.some((s) => s.status === 'AVAILABLE') ? 'AVAILABLE' : 'SOLD_OUT';
}

export interface BuildOptions {
  /** 날짜 목록 조회 실패 사유. 주어지면 지나지 않은 날은 전부 UNKNOWN이 된다. */
  readonly error?: string;
  /** 몇 달을 그릴지. 기본 2 (이번 달 + 다음 달). */
  readonly months?: number;
}

/**
 * 한 프로그램의 스냅샷을 만든다.
 *
 * @param today KST 기준 오늘 날짜 (`YYYY-MM-DD`). 과거/현재 판별의 기준이다.
 * @param openDates 사이트가 예약 가능하다고 밝힌 날짜 (실측, `fetchOpenDates`).
 * @param slotsByDate 그 중 회차 조회에 **성공한** 날짜들의 회차 목록.
 *   열린 날짜인데 이 맵에 없으면 조회에 실패한 것이다 → UNKNOWN.
 *   단 오늘은 예외로 PAST다: 2026-09-19에 관측했듯 당일 회차가 모두 끝나면
 *   사이트는 회차 조각을 날짜·시각 필드 없이 보내고, 우리는 그걸 실패로 받는다.
 *   그날 저녁 내내 "확인 불가"를 띄우는 것보다 "지난 날"이 사실에 가깝다.
 */
export function buildProductSnapshot(
  product: 'exhibition' | 'lecture',
  today: string,
  openDates: readonly OpenDate[],
  slotsByDate: ReadonlyMap<string, readonly Slot[]>,
  options: BuildOptions = {},
): ProductSnapshot {
  const first = today.slice(0, 7);
  const months = Array.from({ length: options.months ?? 2 }, (_, i) => addMonths(first, i));
  const openByDate = new Map(openDates.map((d) => [d.date, d]));

  const days: DaySnapshot[] = months.flatMap(daysOfMonth).map((date) => {
    // getUTCDay()를 쓴다. +09:00을 붙여 로컬 Date로 만들면 .getDay()가
    // *실행 환경의* 시스템 타임존으로 요일을 읽어서, UTC로 도는 CI에서는
    // 하루 밀린 요일이 나온다 — 실제로 그렇게 틀렸다.
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();

    if (date < today) return { date, dow, state: 'PAST' };
    if (options.error !== undefined) return { date, dow, state: 'UNKNOWN' };

    const open = openByDate.get(date);
    if (!open) return { date, dow, state: 'NOT_OPEN', opensAt: null };

    const slots = slotsByDate.get(date);
    if (!slots) return { date, dow, state: date === today ? 'PAST' : 'UNKNOWN', opensAt: open.opensAt };

    return {
      date, dow,
      state: stateFromSlots(slots),
      slots: slots.map((s) => ({ time: s.time, available: s.status === 'AVAILABLE' })),
      opensAt: open.opensAt,
    };
  });

  return {
    product,
    month: first,
    months,
    days,
    ...(options.error !== undefined ? { error: options.error } : {}),
    nextOpenGuess: guessNextOpening(openDates, today),
  };
}

/**
 * 다음 예약 오픈 시각을 추정한다.
 *
 * 사이트는 이미 열린 날짜에만 오픈 시각(`RESERVE_OPEN_DATETIME`)을 붙여 주고,
 * 아직 안 열린 날짜는 목록에 올리지 않는다(실측). 그래서 다음 오픈은 직접 알 수
 * 없고, 사이트 공지("전시 예약은 격주 화요일 오후 2시")에 기대어 **가장 최근 오픈
 * 시각 + 14일**로 추정한다. 그 날짜가 이미 지났으면 14일씩 더 민다.
 *
 * 추정이므로 화면과 알림에는 반드시 "예상"이라고 적는다.
 */
export function guessNextOpening(openDates: readonly OpenDate[], today: string): string | null {
  const latest = openDates
    .map((d) => d.opensAt)
    .filter((v): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v))
    .sort()
    .at(-1);
  if (!latest) return null;

  const [datePart, timePart] = latest.split('T') as [string, string];
  let next = Date.parse(`${datePart}T00:00:00Z`);
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  do next += 14 * 86_400_000; while (next < todayMs);

  return `${new Date(next).toISOString().slice(0, 10)}T${timePart.slice(0, 8)}`;
}

/**
 * 직전 스냅샷에는 "안 열림"이었는데 이번에 열린 날짜들 — 예약 오픈을 알리는 근거다.
 *
 * 직전에 UNKNOWN(조회 실패)이었던 날은 넣지 않는다. 그 날이 실패 전부터 열려
 * 있었는지 알 수 없으므로, 넣으면 사이트가 잠깐 흔들렸다 돌아올 때마다 "새로
 * 열렸다"는 거짓 알림이 나간다. 직전 스냅샷에 아예 없던 날(달이 넘어가며 새로
 * 들어온 날)도 같은 이유로 넣지 않는다.
 */
export function newlyOpenedDates(previous: ProductSnapshot | undefined, next: ProductSnapshot): string[] {
  if (!previous || previous.error !== undefined) return [];
  const before = new Map(previous.days.map((d) => [d.date, d.state]));
  return next.days
    .filter((d) => (d.state === 'SOLD_OUT' || d.state === 'AVAILABLE') && before.get(d.date) === 'NOT_OPEN')
    .map((d) => d.date);
}

/** 지금 이 순간의 스냅샷 전체를 생성 시각과 함께 감싼다. */
export function wrapSnapshot(
  now: Date,
  products: readonly ProductSnapshot[],
): FullSnapshot {
  return { generatedAt: now.toISOString(), products };
}

export { toKstDateString };
