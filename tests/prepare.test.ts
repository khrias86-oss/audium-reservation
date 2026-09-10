import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { prepareBooking } from '../src/booking/prepare.js';
import type { Slot } from '../src/core/types.js';

const partial = readFileSync(new URL('./fixtures/time-partially-available.html', import.meta.url), 'utf8');
const soldOut = readFileSync(new URL('./fixtures/time-all-sold-out.html', import.meta.url), 'utf8');

function stubFetch(handler: (body: string) => Response): typeof fetch {
  return ((_url: string, init?: RequestInit) =>
    Promise.resolve(handler(String(init?.body ?? '')))) as unknown as typeof fetch;
}

/** 픽스처에서 여석이 있는 회차를 골라 온다 — 값을 손으로 적으면 픽스처와 어긋난다. */
function availableSlotFromFixture(html: string): Slot {
  const dates = [...html.matchAll(/<spectate_date[^>]*>([^<]+)</g)].map((m) => m[1]!.trim());
  const times = [...html.matchAll(/<spectate_time[^>]*>([^<]+)</g)].map((m) => m[1]!.trim());
  const blocks = html.split('time-slots');
  for (let i = 0; i < times.length; i++) {
    if (!blocks[i + 1]?.includes('disabled-time-slots')) {
      return {
        date: dates[i]!, time: times[i]!, status: 'AVAILABLE',
        remain: null, capacity: null, bookUrl: 'https://audeum.org/booking',
      };
    }
  }
  throw new Error('픽스처에 여석 회차가 없습니다');
}

const target = availableSlotFromFixture(partial);

describe('예약 준비', () => {
  it('여석이 그대로면 예약에 필요한 것을 챙겨 준다', async () => {
    const result = await prepareBooking(target, 'exhibition', {
      fetchImpl: stubFetch(() => new Response(partial, { status: 200 })),
    });
    expect(result.kind).toBe('READY');
    if (result.kind !== 'READY') return;
    expect(result.plan.slot.time).toBe(target.time);
    // seq_reserve는 사이트가 그 회차에 붙인 식별자다. 예약 화면을 여는 열쇠다.
    expect(result.plan.reserveSeq).toMatch(/^\d+$/);
  });

  it('사이에 매진되면 알리지 않도록 GONE으로 돌려준다', async () => {
    // 이 구분이 없으면 사용자를 뛰게 만들어 놓고 배신하는 알림이 나간다.
    const result = await prepareBooking(target, 'exhibition', {
      fetchImpl: stubFetch(() => new Response(soldOut, { status: 200 })),
    });
    expect(result.kind).toBe('GONE');
  });

  it('회차가 목록에서 사라져도 GONE이다', async () => {
    const result = await prepareBooking(target, 'exhibition', {
      fetchImpl: stubFetch(() => new Response('<html><div class="x">회차 없음</div></html>', { status: 200 })),
    });
    expect(result.kind).toBe('GONE');
  });

  it('대기열이면 확인 못 한 것이지 없는 것이 아니다', async () => {
    const result = await prepareBooking(target, 'exhibition', {
      fetchImpl: stubFetch(() => new Response('동시접속자가 많아', { status: 200 })),
    });
    expect(result.kind).toBe('UNVERIFIED');
  });

  it('재확인 요청이 실패해도 예외를 던지지 않는다', async () => {
    const result = await prepareBooking(target, 'exhibition', {
      fetchImpl: (() => Promise.reject(new Error('ECONNRESET'))) as unknown as typeof fetch,
    });
    expect(result.kind).toBe('UNVERIFIED');
  });

  it('여석은 확인됐는데 식별자만 못 읽으면, 알림은 살리고 seq를 비운다', async () => {
    // 알림을 통째로 버리면 잡을 수 있었던 자리를 놓친다. 링크만 일반 주소로 준다.
    let call = 0;
    const result = await prepareBooking(target, 'exhibition', {
      fetchImpl: (() => {
        call++;
        return Promise.resolve(
          call === 1 ? new Response(partial, { status: 200 }) : new Response('', { status: 503 }),
        );
      }) as unknown as typeof fetch,
    });
    expect(result.kind).toBe('READY');
    if (result.kind !== 'READY') return;
    expect(result.plan.reserveSeq).toBe('');
    expect(result.plan.bookingUrl).toBe('https://audeum.org/booking');
  });
});
