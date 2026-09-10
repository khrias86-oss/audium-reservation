import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Browser } from 'playwright';
import { fetchSlotsViaBrowser } from '../src/adapters/audeum/browser-flow.js';

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');

/**
 * 가짜 브라우저.
 *
 * 실제 Playwright와 실제 사이트 없이 흐름을 검증한다. 사이트를 반복해서 두드리지
 * 않으면서도, 대기열·구조 변경 같은 경우를 마음대로 재현할 수 있다.
 */
function fakeBrowser(opts: {
  bodyText?: string;
  bodyTextAfterClick?: string;
  itemCount?: number;
  timeFragments?: string[];
  dateContainerHtml?: string;
  gotoFails?: boolean;
}): Browser {
  const handlers: Array<(res: unknown) => void> = [];

  const page = {
    on(event: string, handler: (res: unknown) => void) {
      if (event === 'response') handlers.push(handler);
    },
    async goto() {
      if (opts.gotoFails) throw new Error('net::ERR_CONNECTION_REFUSED');
      // 사이트가 회차 조각을 보내는 것을 흉내낸다.
      for (const body of opts.timeFragments ?? []) {
        for (const h of handlers) {
          h({ url: () => 'https://audeum.org/booking/time', text: async () => body });
        }
      }
      return {};
    },
    locator(selector: string) {
      return {
        first: () => page.locator(selector),
        async count() {
          if (selector.includes('exhibition-item')) return opts.itemCount ?? 1;
          return 1;
        },
        async click() { /* 클릭은 성공한 것으로 본다 */ },
        async innerText() {
          return page._clicked ? (opts.bodyTextAfterClick ?? opts.bodyText ?? '') : (opts.bodyText ?? '');
        },
        async innerHTML() { return opts.dateContainerHtml ?? ''; },
      };
    },
    async waitForTimeout() { page._clicked = true; },
    _clicked: false,
  } as never as { [k: string]: unknown; _clicked: boolean; locator: (s: string) => never };

  return {
    async newContext() {
      return { newPage: async () => page, close: async () => {} };
    },
  } as never as Browser;
}

const run = (b: Browser) => fetchSlotsViaBrowser(b, 'exhibition', { settleMs: 0 });

describe('정상 조회', () => {
  it('회차 조각을 받아 슬롯으로 변환한다', async () => {
    const result = await run(fakeBrowser({ timeFragments: [fixture('time-partially-available')] }));
    expect(result.kind).toBe('OK');
    if (result.kind !== 'OK') return;
    expect(result.slots.find((s) => s.time === '10:00')?.status).toBe('AVAILABLE');
    expect(result.slots.find((s) => s.time === '11:00')?.status).toBe('SOLD_OUT');
  });

  it('여러 날짜의 조각을 합치되 중복은 없앤다', async () => {
    const result = await run(fakeBrowser({
      timeFragments: [fixture('time-all-sold-out'), fixture('time-all-sold-out')],
    }));
    if (result.kind !== 'OK') throw new Error('OK여야 한다');
    expect(result.slots).toHaveLength(3);
  });
});

describe('대기열', () => {
  it('첫 화면이 대기열이면 클릭하지 않고 물러난다', async () => {
    const result = await run(fakeBrowser({ bodyText: '동시접속자가 많아 잠시 대기 중입니다.' }));
    expect(result.kind).toBe('QUEUED');
  });

  it('클릭 뒤 대기열로 넘어가도 잡아낸다', async () => {
    // 흐름 중간에 게이트가 걸린다(NetFunnel이 예약 단계 안에 있다).
    const result = await run(fakeBrowser({
      bodyText: '예약',
      bodyTextAfterClick: 'We are currently experiencing a high volume of traffic.',
    }));
    expect(result.kind).toBe('QUEUED');
  });
});

describe('구조 변경 감지', () => {
  it('상품 항목이 없으면 여석 없음이 아니라 계약 파손이다', async () => {
    const result = await run(fakeBrowser({ itemCount: 0 }));
    expect(result.kind).toBe('CONTRACT_BROKEN');
    if (result.kind !== 'CONTRACT_BROKEN') return;
    expect(result.reason).toContain('상품 항목');
  });

  it('날짜는 나왔는데 회차 조각이 없으면 확인 실패로 본다', async () => {
    const result = await run(fakeBrowser({ timeFragments: [], dateContainerHtml: '<div>달력</div>' }));
    expect(result.kind).toBe('CONTRACT_BROKEN');
    if (result.kind !== 'CONTRACT_BROKEN') return;
    expect(result.reason).toContain('회차 조각을 받지 못했습니다');
  });

  it('흐름이 아예 진행되지 않은 경우를 구분해서 알려준다', async () => {
    const result = await run(fakeBrowser({ timeFragments: [], dateContainerHtml: '' }));
    if (result.kind !== 'CONTRACT_BROKEN') throw new Error('CONTRACT_BROKEN이어야 한다');
    expect(result.reason).toContain('날짜 단계까지 진행되지 않았습니다');
  });
});

describe('일시적 오류', () => {
  it('접속 실패는 계약 파손이 아니라 일시 오류다', async () => {
    // 이 구분이 중요하다. 일시 오류는 기다리면 낫지만, 계약 파손은 사람이 고쳐야 한다.
    const result = await run(fakeBrowser({ gotoFails: true }));
    expect(result.kind).toBe('TRANSIENT_ERROR');
  });
});
