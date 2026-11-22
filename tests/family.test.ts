import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFamilyNotifier, familyConfigFromEnv, familyMessage, fanOut } from '../src/notify/family.js';
import type { Notification, Notifier } from '../src/notify/types.js';
import type { Slot, Watch } from '../src/core/types.js';

const slot: Slot = {
  date: '2026-12-03', time: '14:30', status: 'AVAILABLE',
  remain: null, capacity: null, bookUrl: 'https://audeum.org/booking',
};
const watch: Watch = { id: 'w', userId: 'u', date: slot.date, time: slot.time, priority: 0, state: 'DETECTED' };
const needsAction: Notification = {
  kind: 'NEEDS_ACTION', watch, slot, reason: '재확인함', resumeUrl: 'https://audeum.org/booking', product: 'exhibition',
};
const PAGE = 'https://example.github.io/page/';

afterEach(() => vi.unstubAllGlobals());

describe('가족 알림 문구', () => {
  it('자리 알림은 날짜·요일·회차와 예약 링크를 담고, 마크다운 기호는 뺀다', () => {
    const m = familyMessage(needsAction, PAGE)!;
    expect(m.title).toContain('12/3(목) 14:30');
    expect(m.text).toContain('https://audeum.org/booking');
    expect(m.text).toContain('인증번호 발송');
    expect(m.text).not.toContain('**');
    expect(m.text).toContain('1인 1매');
    expect(m.priority).toBe(5);
  });

  it('예약 오픈과 오픈 예고도 보낸다', () => {
    expect(familyMessage({ kind: 'OPENED', product: 'exhibition', dates: ['2026-12-03', '2026-12-04'] }, PAGE)!.title)
      .toContain('12/3(목), 12/4(금)');
    expect(familyMessage({ kind: 'OPENING_SOON', product: 'exhibition', at: '2026-11-24T14:00:00' }, PAGE)!.title)
      .toContain('14:00');
  });

  it('시스템 경고 같은 운영 알림은 가족에게 보내지 않는다', () => {
    expect(familyMessage({ kind: 'SYSTEM_WARNING', reason: 'x' }, PAGE)).toBeNull();
    expect(familyMessage({ kind: 'SYSTEM_RECOVERED', key: 'k', note: 'n' }, PAGE)).toBeNull();
  });
});

describe('가족 알림 발송', () => {
  const capture = () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(String(url).includes('script') ? '{"ok":true,"sent":2}' : '{}', { status: 200 });
    }) as typeof fetch);
    return calls;
  };

  it('메일(Apps Script)과 푸시(ntfy)로 각각 보낸다', async () => {
    const calls = capture();
    const n = createFamilyNotifier({
      mailerUrl: 'https://script.google.com/macros/s/X/exec', mailerKey: 'K', ntfyTopic: 'secret-topic', pageUrl: PAGE, log: () => {},
    });
    expect(await n.send(needsAction)).toBe(true);

    const mail = calls.find((c) => c.url.includes('script.google.com'))!;
    expect(mail.body).toMatchObject({ action: 'notify', key: 'K' });
    expect(String(mail.body['subject'])).toContain('14:30');

    const push = calls.find((c) => c.url === 'https://ntfy.sh')!;
    expect(push.body).toMatchObject({ topic: 'secret-topic', click: 'https://audeum.org/booking', priority: 5 });
  });

  it('설정이 없는 길은 건너뛴다', async () => {
    const calls = capture();
    const n = createFamilyNotifier({ ntfyTopic: 't', pageUrl: PAGE, log: () => {} });
    await n.send(needsAction);
    expect(calls.map((c) => c.url)).toEqual(['https://ntfy.sh']);
  });

  it('한쪽이 실패해도 다른 쪽은 보내고, 실패를 기록한다', async () => {
    const lines: string[] = [];
    vi.stubGlobal('fetch', (async (url: string | URL | Request) =>
      String(url).includes('script')
        ? new Response('{"ok":false,"error":"bad key"}', { status: 200 })
        : new Response('{}', { status: 200 })) as typeof fetch);
    const n = createFamilyNotifier({
      mailerUrl: 'https://script.google.com/x', mailerKey: 'K', ntfyTopic: 't', pageUrl: PAGE, log: (l) => lines.push(l),
    });
    expect(await n.send(needsAction)).toBe(true);
    expect(lines.some((l) => l.includes('메일 발송 실패'))).toBe(true);
  });

  it('모든 길이 실패하면 밖으로 알린다', async () => {
    vi.stubGlobal('fetch', (async () => new Response('nope', { status: 500 })) as typeof fetch);
    const n = createFamilyNotifier({ mailerUrl: 'https://script.google.com/x', mailerKey: 'K', ntfyTopic: 't', pageUrl: PAGE, log: () => {} });
    await expect(n.send(needsAction)).rejects.toThrow(/하나도 보내지 못했습니다/);
  });

  it('가족에게 보낼 알림이 아니면 아무것도 하지 않는다', async () => {
    const calls = capture();
    const n = createFamilyNotifier({ ntfyTopic: 't', pageUrl: PAGE, log: () => {} });
    expect(await n.send({ kind: 'SYSTEM_WARNING', reason: 'x' })).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('이슈 알림 → 가족 알림 연결', () => {
  const recorder = (result: boolean | void, fail = false) => {
    const sent: Notification[] = [];
    const n: Notifier = { send: async (x) => { if (fail) throw new Error('boom'); sent.push(x); return result; } };
    return { n, sent };
  };

  it('이슈 쪽이 실제로 알렸을 때만 가족에게 보낸다 — 중복 판정은 한 곳에서', async () => {
    const primary = recorder(false);
    const family = recorder(true);
    expect(await fanOut(primary.n, [family.n]).send(needsAction)).toBe(false);
    expect(family.sent).toHaveLength(0);

    const primary2 = recorder(true);
    await fanOut(primary2.n, [family.n]).send(needsAction);
    expect(family.sent).toHaveLength(1);
  });

  it('가족 알림이 실패해도 감시를 멈추지 않는다', async () => {
    const lines: string[] = [];
    const out = fanOut(recorder(true).n, [recorder(true, true).n], (l) => lines.push(l));
    await expect(out.send(needsAction)).resolves.toBe(true);
    expect(lines[0]).toContain('가족 알림 실패');
  });
});

describe('설정 읽기', () => {
  it('빈 값은 없는 것으로 본다', () => {
    const c = familyConfigFromEnv({ MAILER_URL: ' ', MAILER_KEY: '', NTFY_TOPIC: 'abc' } as NodeJS.ProcessEnv);
    expect(c.mailerUrl).toBeUndefined();
    expect(c.mailerKey).toBeUndefined();
    expect(c.ntfyTopic).toBe('abc');
    expect(c.pageUrl).toContain('github.io');
  });
});
