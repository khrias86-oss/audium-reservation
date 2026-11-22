import { describe, expect, it } from 'vitest';
import { alertServerFromEnv, createAlertServer } from '../src/notify/alert-server.js';
import { openingEventFor } from '../src/snapshot.js';

function fakeFetch(reply: (body: any) => { status?: number; text: string }) {
  const calls: any[] = [];
  const impl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ body, headers: init.headers });
    const r = reply(body);
    return new Response(r.text, { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('알림 서버 클라이언트', () => {
  it('열쇠를 붙여 text/plain으로 보낸다 (Apps Script가 그대로 받는 형식)', async () => {
    const f = fakeFetch(() => ({ text: JSON.stringify({ ok: true, slots: [{ product: 'exhibition', date: '2026-12-04', time: '10:00' }], opens: [] }) }));
    const server = createAlertServer({ url: 'https://script.google.com/macros/s/X/exec', key: 'K', fetchImpl: f.impl });
    const wants = await server.wants();
    expect(wants.slots).toEqual([{ product: 'exhibition', date: '2026-12-04', time: '10:00' }]);
    expect(f.calls[0].body).toEqual({ action: 'wants', key: 'K' });
    expect(f.calls[0].headers['content-type']).toContain('text/plain');
  });

  it('서버가 거절하면 이유와 함께 실패한다', async () => {
    const f = fakeFetch(() => ({ text: JSON.stringify({ ok: false, error: '열쇠가 맞지 않습니다' }) }));
    const server = createAlertServer({ url: 'u', key: 'bad', fetchImpl: f.impl });
    await expect(server.wants()).rejects.toThrow('열쇠가 맞지 않습니다');
  });

  it('로그인 화면(HTML)이 오면 웹 앱 액세스 설정을 짚어 준다', async () => {
    const f = fakeFetch(() => ({ text: '<!DOCTYPE html><html>Sign in</html>' }));
    const server = createAlertServer({ url: 'u', key: 'K', fetchImpl: f.impl });
    await expect(server.wants()).rejects.toThrow('모든 사용자');
  });

  it('결과를 넘기고 발송 집계를 받는다', async () => {
    const f = fakeFetch(() => ({ text: JSON.stringify({ ok: true, alerted: 2, mailed: 2, pushed: 1, failed: 0 }) }));
    const server = createAlertServer({ url: 'u', key: 'K', fetchImpl: f.impl });
    const d = await server.report([{ product: 'exhibition', date: '2026-12-04', time: '10:00', available: false }]);
    expect(d).toEqual({ alerted: 2, mailed: 2, pushed: 1, failed: 0 });
    expect(f.calls[0].body.observations).toHaveLength(1);
  });

  it('설정이 하나라도 없으면 없는 것으로 본다', () => {
    expect(alertServerFromEnv({ MAILER_URL: 'u' })).toBeNull();
    expect(alertServerFromEnv({ MAILER_URL: 'u', MAILER_KEY: ' ' })).toBeNull();
    expect(alertServerFromEnv({ MAILER_URL: 'u', MAILER_KEY: 'k' })).not.toBeNull();
  });
});

describe('오픈 알림 → 알림 서버 형식', () => {
  it('예고에는 예상 시각을 붙인다 — 서버가 같은 시각 예고를 한 번만 보낸다', () => {
    const e = openingEventFor({ kind: 'OPENING_SOON', product: 'exhibition', at: '2026-11-24T14:00:00' });
    expect(e).toMatchObject({ event: 'soon', product: 'exhibition', at: '2026-11-24T14:00:00' });
    expect(e!.subject).toContain('14:00');
  });

  it('열림에는 열린 날짜를 적는다', () => {
    const e = openingEventFor({ kind: 'OPENED', product: 'exhibition', dates: ['2026-12-03'] });
    expect(e).toMatchObject({ event: 'opened', product: 'exhibition' });
    expect(e!.subject).toContain('12/3(목)');
  });

  it('시스템 경고는 신청자에게 가지 않는다', () => {
    expect(openingEventFor({ kind: 'SYSTEM_WARNING', reason: 'x' })).toBeNull();
  });
});
