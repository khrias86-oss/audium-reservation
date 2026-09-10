import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  buildTimeRequestBody,
  fetchOpenDates,
  fetchSlotsForDate,
  fetchSlotsForDates,
} from '../src/adapters/audeum/http-flow.js';

const soldOut = readFileSync(new URL('./fixtures/time-all-sold-out.html', import.meta.url), 'utf8');
const partial = readFileSync(new URL('./fixtures/time-partially-available.html', import.meta.url), 'utf8');

/** 사이트가 준 것처럼 응답하는 가짜 fetch. 실제 사이트는 건드리지 않는다. */
function stubFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response> | never,
): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(handler(String(url), init ?? {}))) as unknown as typeof fetch;
}

const ok = (body: string) => new Response(body, { status: 200 });

describe('요청 본문', () => {
  it('11차 정찰에서 캡처한 형태와 같다', () => {
    expect(buildTimeRequestBody('2026-09-10', 'exhibition')).toBe(
      'locale=ko&spectateDate=2026-09-10&seqExhibition=1&language=ko',
    );
  });

  it('렉처는 seqProgram을 쓴다', () => {
    expect(buildTimeRequestBody('2026-09-10', 'lecture')).toContain('seqProgram=7');
  });
});

describe('한 날짜 조회', () => {
  it('사이트가 쓰는 그대로 폼 POST를 보낸다', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    await fetchSlotsForDate('2026-09-10', 'exhibition', {
      fetchImpl: stubFetch((url, init) => { seen = { url, init }; return ok(soldOut); }),
    });

    const call = seen as unknown as { url: string; init: RequestInit };
    expect(call.url).toBe('https://audeum.org/booking/time');
    expect(call.init.method).toBe('POST');
    expect(call.init.body).toBe('locale=ko&spectateDate=2026-09-10&seqExhibition=1&language=ko');
    const headers = call.init.headers as Record<string, string>;
    expect(headers['content-type']).toContain('x-www-form-urlencoded');
  });

  it('실제로 캡처한 매진 응답을 매진으로 읽는다', async () => {
    const result = await fetchSlotsForDate('2026-09-10', 'exhibition', {
      fetchImpl: stubFetch(() => ok(soldOut)),
    });
    expect(result.kind).toBe('OK');
    if (result.kind !== 'OK') return;
    expect(result.slots.length).toBeGreaterThan(0);
    expect(result.slots.every((s) => s.status === 'SOLD_OUT')).toBe(true);
  });

  it('여석이 있으면 여석으로 읽는다', async () => {
    const result = await fetchSlotsForDate('2026-09-10', 'exhibition', {
      fetchImpl: stubFetch(() => ok(partial)),
    });
    expect(result.kind).toBe('OK');
    if (result.kind !== 'OK') return;
    expect(result.slots.some((s) => s.status === 'AVAILABLE')).toBe(true);
  });

  it('대기열 페이지는 여석 없음이 아니라 QUEUED다', async () => {
    const result = await fetchSlotsForDate('2026-09-10', 'exhibition', {
      fetchImpl: stubFetch(() => ok('<html>동시접속자가 많아 잠시 대기 중입니다.</html>')),
    });
    expect(result.kind).toBe('QUEUED');
  });

  it('5xx는 사이트 장애이므로 일시 오류다', async () => {
    const result = await fetchSlotsForDate('2026-09-10', 'exhibition', {
      fetchImpl: stubFetch(() => new Response('', { status: 503 })),
    });
    expect(result.kind).toBe('TRANSIENT_ERROR');
  });

  it('4xx는 우리 요청이 틀렸다는 뜻이므로 계약 파손이다', async () => {
    // 상품 번호가 바뀌면 여기로 온다. "자리 없음"으로 넘기면 개편을 놓친다.
    const result = await fetchSlotsForDate('2026-09-10', 'exhibition', {
      fetchImpl: stubFetch(() => new Response('', { status: 404 })),
    });
    expect(result.kind).toBe('CONTRACT_BROKEN');
  });

  it('네트워크 실패는 일시 오류로 감싼다 — 예외를 밖으로 던지지 않는다', async () => {
    const result = await fetchSlotsForDate('2026-09-10', 'exhibition', {
      fetchImpl: stubFetch(() => { throw new Error('ECONNRESET'); }),
    });
    expect(result.kind).toBe('TRANSIENT_ERROR');
    if (result.kind !== 'TRANSIENT_ERROR') return;
    expect(result.reason).toContain('ECONNRESET');
  });
});

describe('여러 날짜 조회', () => {
  it('날짜별로 각각 요청하고 결과를 합친다', async () => {
    const asked: string[] = [];
    const { result, perDate } = await fetchSlotsForDates(['2026-09-10', '2026-09-11'], 'exhibition', {
      fetchImpl: stubFetch((_url, init) => {
        asked.push(String(init.body));
        return ok(soldOut);
      }),
    });
    expect(asked).toHaveLength(2);
    expect(perDate.size).toBe(2);
    expect(result.kind).toBe('OK');
  });

  it('중복 날짜는 한 번만 요청한다', async () => {
    let calls = 0;
    await fetchSlotsForDates(['2026-09-10', '2026-09-10'], 'exhibition', {
      fetchImpl: stubFetch(() => { calls++; return ok(soldOut); }),
    });
    expect(calls).toBe(1);
  });

  it('한 날짜라도 계약이 깨지면 전체를 신뢰하지 않는다', async () => {
    const { result } = await fetchSlotsForDates(['2026-09-10', '2026-09-11'], 'exhibition', {
      fetchImpl: stubFetch((_url, init) =>
        String(init.body).includes('09-11') ? new Response('', { status: 404 }) : ok(soldOut),
      ),
    });
    expect(result.kind).toBe('CONTRACT_BROKEN');
  });

  it('한 날짜가 일시 오류여도 성공한 날짜의 결과는 살린다', async () => {
    const { result } = await fetchSlotsForDates(['2026-09-10', '2026-09-11'], 'exhibition', {
      fetchImpl: stubFetch((_url, init) =>
        String(init.body).includes('09-11') ? new Response('', { status: 503 }) : ok(partial),
      ),
    });
    expect(result.kind).toBe('OK');
    if (result.kind !== 'OK') return;
    expect(result.slots.some((s) => s.status === 'AVAILABLE')).toBe(true);
  });

  it('전부 실패하면 대기열을 일시 오류보다 먼저 보고한다', async () => {
    const { result } = await fetchSlotsForDates(['2026-09-10', '2026-09-11'], 'exhibition', {
      fetchImpl: stubFetch((_url, init) =>
        String(init.body).includes('09-11')
          ? ok('동시접속자가 많아')
          : new Response('', { status: 503 }),
      ),
    });
    expect(result.kind).toBe('QUEUED');
  });

  it('요청을 병렬로 보내 10초 예산 안에 끝낸다', async () => {
    const dates = ['2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13', '2026-09-14'];
    const { elapsedMs } = await fetchSlotsForDates(dates, 'exhibition', {
      fetchImpl: stubFetch(
        () => new Promise<Response>((r) => setTimeout(() => r(ok(soldOut)), 60)) as never,
      ),
    });
    // 순차라면 300ms 이상이다. 병렬이면 가장 느린 요청 하나에 수렴한다.
    expect(elapsedMs).toBeLessThan(200);
  });
});

describe('예약이 열린 날짜 조회', () => {
  it('사이트가 쓰는 폼으로 /booking/date를 물어본다', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    await fetchOpenDates('exhibition', {
      fetchImpl: stubFetch((url, init) => {
        seen = { url, init };
        return ok('<script>reserveList = [{"SPECTATE_DATE":"2026-09-10"}];</script>');
      }),
    });
    const call = seen as unknown as { url: string; init: RequestInit };
    expect(call.url).toBe('https://audeum.org/booking/date');
    expect(call.init.body).toBe('locale=ko&seqExhibition=1&language=ko');
  });

  it('열린 날짜를 그대로 돌려준다', async () => {
    const r = await fetchOpenDates('exhibition', {
      fetchImpl: stubFetch(() =>
        ok('<script>reserveList = [{"SPECTATE_DATE":"2026-09-10","RESERVE_OPEN_DATETIME":"2026-09-08T14:00:00"}];</script>'),
      ),
    });
    expect(r.kind).toBe('OK');
    if (r.kind !== 'OK') return;
    expect(r.dates).toEqual([{ date: '2026-09-10', opensAt: '2026-09-08T14:00:00' }]);
  });

  it('요청이 실패해도 예외를 던지지 않는다 — 걸러내기는 최적화일 뿐이다', async () => {
    const r = await fetchOpenDates('exhibition', {
      fetchImpl: stubFetch(() => { throw new Error('ECONNRESET'); }),
    });
    expect(r.kind).toBe('CONTRACT_BROKEN');
  });

  it('4xx·5xx도 예외 없이 사유와 함께 돌려준다', async () => {
    const r = await fetchOpenDates('exhibition', {
      fetchImpl: stubFetch(() => new Response('', { status: 500 })),
    });
    expect(r.kind).toBe('CONTRACT_BROKEN');
    if (r.kind !== 'CONTRACT_BROKEN') return;
    expect(r.reason).toContain('500');
  });
});
