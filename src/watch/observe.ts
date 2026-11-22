import type { Slot } from '../core/types.js';
import type { Product, MultiDateResult } from '../adapters/audeum/http-flow.js';
import type { DateFragmentResult } from '../adapters/audeum/parse-date-fragment.js';
import type { PrepareResult } from '../booking/prepare.js';
import type { Observation } from '../notify/alert-server.js';
import { slotAlert } from '../notify/alert-text.js';

/**
 * 한 상품(전시 또는 렉처)에 대해, 신청된 회차들이 지금 비었는지 본다.
 *
 * 결과는 "회차별 관찰"이다. 누구에게 알릴지는 여기서 정하지 않는다 — 알림 서버가
 * 신청자별 규칙(즉시 1번, 10분 뒤 재확인)으로 정한다.
 *
 * **확인하지 못한 회차는 관찰에서 뺀다.** "자리 없음"으로 보내면 알림 서버가
 * 진행 중이던 알림을 끝내 버린다. 모르는 것은 모른다고 둔다.
 */
export interface ObserveDeps {
  fetchOpenDates(product: Product): Promise<DateFragmentResult>;
  fetchSlotsForDates(dates: readonly string[], product: Product): Promise<MultiDateResult>;
  prepareBooking(slot: Slot, product: Product): Promise<PrepareResult>;
}

export interface ProductCheck {
  /** OK: 정상으로 읽음. SKIPPED: 대기열·일시 오류로 이번엔 모름. BROKEN: 사이트 구조가 바뀐 듯함. */
  readonly kind: 'OK' | 'SKIPPED' | 'BROKEN';
  readonly observations: readonly Observation[];
  readonly reason?: string;
  readonly raw?: unknown;
}

const LABEL: Record<Product, string> = { exhibition: '전시', lecture: '렉처' };

export async function observeProduct(
  product: Product,
  wanted: readonly { readonly date: string; readonly time: string }[],
  deps: ObserveDeps,
  say: (line: string) => void = () => {},
): Promise<ProductCheck> {
  const label = LABEL[product];
  const observations: Observation[] = [];
  const none = (date: string, time: string): Observation => ({ product, date, time, available: false });

  // 신청한 날짜만 묻는다 — 요청 수가 신청 수에 비례하지, 사이트 사정에 좌우되지 않는다.
  let dates = [...new Set(wanted.map((w) => w.date))];

  // 그 중 예약이 열린 날짜만 남긴다. 안 열린 날의 회차는 물어봐야 헛돈다.
  // 안 열린 날은 "지금 자리 없음"이 맞다 — 확실히 아는 사실이므로 관찰로 보낸다.
  const open = await deps.fetchOpenDates(product);
  if (open.kind === 'OK') {
    const openSet = new Set(open.dates.map((d) => d.date));
    for (const w of wanted.filter((x) => !openSet.has(x.date))) observations.push(none(w.date, w.time));
    const closed = dates.filter((d) => !openSet.has(d));
    if (closed.length) say(`- ⏳ ${label} 아직 예약이 안 열린 날짜: ${closed.join(', ')}`);
    dates = dates.filter((d) => openSet.has(d));
  } else {
    // 걸러내기는 최적화일 뿐이다. 실패했다고 본래 일을 못 하면 안 된다.
    say(`- ${label} 열린 날짜 목록을 못 받아 신청한 날짜를 그대로 확인합니다 (${open.kind === 'QUEUED' ? open.message : open.reason})`);
  }

  if (dates.length === 0) return { kind: 'OK', observations };

  const { result, perDate, elapsedMs } = await deps.fetchSlotsForDates(dates, product);
  say(`- ${label} 날짜 ${dates.length}개 확인 / ${(elapsedMs / 1000).toFixed(1)}초`);

  if (result.kind === 'CONTRACT_BROKEN') {
    return { kind: 'BROKEN', observations, reason: result.reason, raw: result.raw };
  }
  if (result.kind === 'QUEUED' || result.kind === 'TRANSIENT_ERROR') {
    return { kind: 'SKIPPED', observations, reason: result.kind === 'QUEUED' ? result.message : result.reason };
  }

  for (const w of wanted) {
    if (!dates.includes(w.date)) continue;
    const day = perDate.get(w.date);
    if (!day || day.kind !== 'OK') {
      say(`- ⚠️ ${label} ${w.date}: 이번엔 확인하지 못했습니다`);
      continue; // 모르는 것은 보내지 않는다
    }
    const slot = day.slots.find((s) => s.time === w.time);
    if (!slot || slot.status !== 'AVAILABLE') {
      say(`- ${label} ${w.date} ${w.time} — ${slot ? '매진' : '그런 회차가 없음'}`);
      observations.push(none(w.date, w.time));
      continue;
    }

    // 목록의 여석을 그대로 믿지 않는다. 사이트 자신도 회차를 고른 뒤 매진을 한 번 더
    // 묻는다. 재확인 1초로 "열어 보니 없는" 알림을 막는다.
    const prepared = await deps.prepareBooking(slot, product);
    if (prepared.kind === 'GONE') {
      say(`- ${label} ${w.date} ${w.time} — 목록엔 있었지만 재확인하니 ${prepared.reason}`);
      observations.push(none(w.date, w.time));
      continue;
    }
    const message = slotAlert(product, w.date, w.time, {
      verified: prepared.kind === 'READY',
      bookUrl: slot.bookUrl,
    });
    say(`- 🎉 ${label} ${w.date} ${w.time} — 자리 있음${prepared.kind === 'UNVERIFIED' ? ` (재확인 못 함: ${prepared.reason})` : ''}`);
    observations.push({ product, date: w.date, time: w.time, available: true, ...message });
  }

  return { kind: 'OK', observations };
}
