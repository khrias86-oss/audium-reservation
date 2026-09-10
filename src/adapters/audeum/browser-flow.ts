import type { Browser, Page } from 'playwright';
import type { ParseResult, Slot } from '../../core/types.js';
import { CONTAINERS, FLOW, ITEM_CLICK_COOLDOWN_MS, isQueuePage } from './contract.js';
import { parseTimeFragment } from './parse-time-fragment.js';

/**
 * 브라우저로 오디움 예약 흐름을 따라가 회차 정보를 가져온다.
 *
 * ## 왜 브라우저가 필요한가
 *
 * 이 사이트는 JSON API가 없다. 예약 정보는 jQuery가 페이지에 끼워 넣는 HTML 조각으로만
 * 오고, 그 조각은 순서대로 클릭해야 나타난다. 그래서 HTTP 요청만으로는 얻을 수 없다.
 *
 * ## 어떻게 가져오는가
 *
 * 화면에 그려진 결과를 읽는 대신 **`/booking/time` 응답 자체를 가로챈다.**
 * 화면 읽기는 렌더가 끝났는지, 애니메이션이 남았는지에 좌우되지만, 응답 가로채기는
 * 그런 타이밍 문제가 없다. 사이트가 보낸 원본을 그대로 받는다.
 */

export interface FlowOptions {
  /** 한국어 페이지라야 실제 내용이 나온다 (6차 정찰에서 확인) */
  readonly locale?: string;
  readonly navigationTimeoutMs?: number;
  /** 상품을 클릭한 뒤 조각들이 채워질 때까지 기다리는 시간 */
  readonly settleMs?: number;
}

const DEFAULTS: Required<FlowOptions> = {
  locale: 'ko-KR',
  navigationTimeoutMs: 40_000,
  settleMs: 9_000,
};

export type FlowResult = ParseResult;

/**
 * 예약 가능 회차를 조회한다.
 *
 * 제출은 하지 않는다. 이 함수는 `/booking/time` 까지만 가고, 결제 단계
 * (`/booking/payment`, `#btn_reserve`)는 건드리지 않는다.
 */
export async function fetchSlotsViaBrowser(
  browser: Browser,
  product: 'exhibition' | 'lecture' = 'exhibition',
  options: FlowOptions = {},
): Promise<FlowResult> {
  const opts = { ...DEFAULTS, ...options };
  const flow = product === 'exhibition' ? FLOW.exhibition : FLOW.lecture;

  const context = await browser.newContext({
    locale: opts.locale,
    viewport: { width: 1280, height: 2000 },
  });
  const page = await context.newPage();

  // 회차 조각을 응답 단계에서 그대로 받아 둔다. 화면 렌더를 기다릴 필요가 없다.
  const timeFragments: string[] = [];
  page.on('response', (response) => {
    if (!response.url().includes(flow.time)) return;
    void response.text().then(
      (body) => timeFragments.push(body),
      () => { /* 본문을 못 읽으면 아래에서 "조각 없음"으로 처리된다 */ },
    );
  });

  try {
    const response = await page.goto(`https://audeum.org${flow.age.replace(/\/age$/, '')}`, {
      waitUntil: 'networkidle',
      timeout: opts.navigationTimeoutMs,
    }).catch(() => null);

    if (response === null) {
      return { kind: 'TRANSIENT_ERROR', reason: '예약 페이지를 열지 못했습니다' };
    }

    const pageText = await page.locator('body').innerText().catch(() => '');
    if (isQueuePage(pageText)) {
      return { kind: 'QUEUED', message: '예약 페이지가 대기열을 표시했습니다' };
    }

    const item = page.locator(flow.itemSelector).first();
    if ((await item.count().catch(() => 0)) === 0) {
      // 상품 항목이 없다는 것은 페이지 구조가 우리가 아는 것과 다르다는 뜻이다.
      // "자리 없음"으로 넘기면 사이트 개편을 눈치채지 못한다.
      return {
        kind: 'CONTRACT_BROKEN',
        reason: `상품 항목을 찾지 못했습니다 (${flow.itemSelector})`,
      };
    }

    await item.click({ timeout: 5_000 });

    // 사이트가 연령 → NetFunnel → 날짜 → 회차 순으로 채운다.
    await page.waitForTimeout(opts.settleMs);

    // 중간에 대기열로 넘어가는 경우가 있다. 조각을 못 받은 채 끝나기 전에 확인한다.
    const afterClick = await page.locator('body').innerText().catch(() => '');
    if (isQueuePage(afterClick)) {
      return { kind: 'QUEUED', message: '회차 조회 중 대기열로 전환됐습니다' };
    }

    if (timeFragments.length === 0) {
      // 날짜 컨테이너는 채워졌는데 회차 조각이 없다면, 그 날짜에 회차가 없는 것일 수도
      // 있고 흐름이 끊긴 것일 수도 있다. 둘을 구분할 근거가 없으므로 확인 실패로 본다.
      const dateFilled = await page.locator(CONTAINERS.date).innerHTML().catch(() => '');
      return {
        kind: 'CONTRACT_BROKEN',
        reason: dateFilled.trim().length > 0
          ? '날짜는 표시됐지만 회차 조각을 받지 못했습니다'
          : '예약 흐름이 날짜 단계까지 진행되지 않았습니다',
      };
    }

    // 여러 날짜를 거쳤다면 조각이 여러 개다. 전부 합쳐 중복을 제거한다.
    const all: Slot[] = [];
    for (const fragment of timeFragments) {
      const parsed = parseTimeFragment(fragment);
      if (parsed.kind !== 'OK') return parsed; // 하나라도 이상하면 전체를 신뢰하지 않는다
      all.push(...parsed.slots);
    }

    const seen = new Set<string>();
    const unique = all.filter((s) => {
      const key = `${s.date}T${s.time}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return { kind: 'OK', slots: unique };
  } catch (error) {
    return {
      kind: 'TRANSIENT_ERROR',
      reason: error instanceof Error ? error.message.split('\n')[0] ?? '알 수 없는 오류' : String(error),
    };
  } finally {
    await context.close().catch(() => { /* 정리 실패는 결과에 영향을 주지 않는다 */ });
  }
}

/** 상품을 연달아 조회할 때 사이트의 3초 쿨다운을 지킨다. */
export const PRODUCT_SWITCH_DELAY_MS = ITEM_CLICK_COOLDOWN_MS + 500;

export type { Page };
