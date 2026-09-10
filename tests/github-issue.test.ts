import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createGitHubIssueNotifier, slotLabel } from '../src/notify/github-issue.js';
import type { Notification } from '../src/notify/types.js';
import type { Slot, Watch } from '../src/core/types.js';

const slot: Slot = {
  date: '2026-03-14', time: '10:00', status: 'AVAILABLE',
  remain: 1, capacity: 20, bookUrl: 'https://audeum.org/booking',
};
const watch: Watch = {
  id: 'w1', userId: 'u1', date: '2026-03-14', time: '10:00', priority: 0, state: 'CLAIMING',
};

const booked: Notification = { kind: 'BOOKED', watch, slot, confirmationId: 'C1' };
const needsAction: Notification = {
  kind: 'NEEDS_ACTION', watch, slot, reason: '본인인증 요구', resumeUrl: 'https://audeum.org/booking',
};
const warning: Notification = { kind: 'SYSTEM_WARNING', reason: '사이트 구조 변경' };

const notifier = (fetchImpl: typeof fetch) => {
  vi.stubGlobal('fetch', fetchImpl);
  return createGitHubIssueNotifier({ owner: 'o', repo: 'r', token: 't' });
};

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

afterEach(() => vi.unstubAllGlobals());

describe('슬롯 라벨', () => {
  it('슬롯 알림은 날짜·시각으로 고유 라벨을 만든다', () => {
    expect(slotLabel(booked)).toBe('slot:2026-03-14T10:00');
    expect(slotLabel(needsAction)).toBe('slot:2026-03-14T10:00');
  });

  it('시스템 경고는 슬롯에 묶이지 않는다', () => {
    expect(slotLabel(warning)).toBeNull();
  });
});

describe('중복 알림 억제', () => {
  it('같은 슬롯에 열린 이슈가 있으면 새로 만들지 않는다', async () => {
    const calls: string[] = [];
    const n = notifier((async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${String(url)}`);
      return ok([{ number: 1 }]); // 이미 열린 이슈가 있다
    }) as typeof fetch);

    await n.send(booked);
    expect(calls.filter((c) => c.startsWith('POST'))).toHaveLength(0);
  });

  it('열린 이슈가 없으면 생성한다', async () => {
    const posts: RequestInit[] = [];
    const n = notifier((async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') { posts.push(init); return ok({ number: 2 }); }
      return ok([]); // 열린 이슈 없음
    }) as typeof fetch);

    await n.send(booked);
    expect(posts).toHaveLength(1);
    const body = JSON.parse(String(posts[0]?.body));
    expect(body.labels).toContain('slot:2026-03-14T10:00');
  });

  it('이슈 조회가 실패하면 발송하지 않고 오류를 낸다', async () => {
    // 조회 실패를 "없음"으로 해석하면 매 틱마다 이슈가 쌓여 알림이 폭주한다.
    const n = notifier((async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') throw new Error('여기 오면 안 된다');
      return new Response('nope', { status: 500 });
    }) as typeof fetch);

    await expect(n.send(booked)).rejects.toThrow(/중복 알림을 막기 위해/);
  });

  it('시스템 경고는 중복 검사 없이 항상 발송된다', async () => {
    const posts: RequestInit[] = [];
    const n = notifier((async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') { posts.push(init); return ok({ number: 3 }); }
      throw new Error('경고는 이슈를 조회하지 않아야 한다');
    }) as typeof fetch);

    await n.send(warning);
    expect(posts).toHaveLength(1);
  });
});

describe('알림 본문', () => {
  const captureBody = async (notification: Notification) => {
    let captured = '';
    const n = notifier((async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') { captured = String(init.body); return ok({ number: 1 }); }
      return ok([]);
    }) as typeof fetch);
    await n.send(notification);
    return JSON.parse(captured);
  };

  it('예약 완료는 취소 안내를 포함한다', async () => {
    // 노쇼는 향후 예약 제한 사유다. 성공 알림에 반드시 붙어야 한다.
    const body = await captureBody(booked);
    expect(body.body).toContain('취소');
    expect(body.title).toContain('[예약완료]');
  });

  it('조치 필요는 예약 링크를 맨 위에 둔다', async () => {
    // 모바일에서 알림을 열자마자 탭할 수 있어야 한다.
    const body = await captureBody(needsAction);
    expect(body.body.split('\n')[0]).toContain('https://audeum.org/booking');
    expect(body.title).toContain('[조치필요]');
  });

  it('확인번호가 없으면 지어내지 않는다', async () => {
    const body = await captureBody({ ...booked, confirmationId: null });
    expect(body.body).toContain('확인번호를 받지 못했습니다');
  });
});
