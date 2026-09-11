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

/** 열린 알림 이슈를 흉내낸다. `ago`는 마지막 활동이 몇 분 전인지. */
const openIssue = (ago: number) => [{
  number: 1,
  updated_at: new Date(Date.now() - ago * 60_000).toISOString(),
}];

describe('중복 알림 억제', () => {
  it('방금 알린 슬롯은 다시 알리지 않는다', async () => {
    const calls: string[] = [];
    const n = notifier((async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${String(url)}`);
      return ok(openIssue(3)); // 3분 전에 알렸다
    }) as typeof fetch);

    await n.send(booked);
    expect(calls.filter((c) => c.startsWith('POST'))).toHaveLength(0);
  });

  it('쿨다운이 지나면 기존 이슈에 댓글로 다시 알린다', async () => {
    // 이것이 없으면 같은 회차에 자리가 다시 나도 영원히 침묵한다.
    // 실제로 그 일이 일어났다 — 새벽에 5분간 열린 자리를 알린 뒤,
    // 이슈가 열려 있다는 이유로 그 뒤의 모든 기회를 놓칠 뻔했다.
    const posts: Array<{ url: string; body: string }> = [];
    const n = notifier((async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts.push({ url: String(url), body: String(init.body) });
        return ok({ id: 1 });
      }
      return ok(openIssue(45)); // 45분 전에 알렸다 — 쿨다운(30분)이 지났다
    }) as typeof fetch);

    await n.send(booked);
    expect(posts).toHaveLength(1);
    // 새 이슈가 아니라 기존 이슈의 댓글이어야 한다.
    expect(posts[0]?.url).toContain('/issues/1/comments');
    expect(JSON.parse(posts[0]!.body).body).toContain('자리가 또 났습니다');
  });

  it('재알림 댓글에도 예약 순서표가 그대로 들어간다', async () => {
    // 댓글만 보고도 바로 움직일 수 있어야 한다. "또 났습니다"만으로는 부족하다.
    const posts: string[] = [];
    const n = notifier((async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') { posts.push(String(init.body)); return ok({ id: 1 }); }
      return ok(openIssue(45));
    }) as typeof fetch);

    await n.send(needsAction);
    const body = JSON.parse(posts[0]!).body;
    expect(body).toContain('인증번호 발송');
    expect(body).toContain('10:00');
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

  it('시스템 경고는 슬롯 중복 검사를 거치지 않는다', async () => {
    // 경고에는 슬롯 라벨이 없다. 조회를 시도하면 엉뚱한 라벨로 묻게 된다.
    const calls: string[] = [];
    const n = notifier((async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${String(url)}`);
      if (init?.method === 'POST') return ok({ number: 9 });
      throw new Error('경고 알림은 이슈를 조회하면 안 된다');
    }) as typeof fetch);

    await n.send(warning);
    expect(calls.filter((c) => c.startsWith('POST'))).toHaveLength(1);
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
  });

  it('제목만 봐도 무엇을 잡았는지 알 수 있다', async () => {
    // 폰 잠금화면에서는 제목이 거의 전부다. 분류 딱지보다 날짜·회차가 먼저다.
    const body = await captureBody(needsAction);
    expect(body.title).toContain(needsAction.slot.date);
    expect(body.title).toContain(needsAction.slot.time);
  });

  it('사람이 눌러야 하는 관문을 순서대로 알려준다', async () => {
    // 오디움은 마지막에 휴대폰 인증번호와 Turnstile을 요구한다. 자동으로 통과할
    // 수 없으므로, 최소한 화면에서 헤매지는 않게 해야 한다.
    const body = await captureBody(needsAction);
    expect(body.body).toContain('인증번호 발송');
    expect(body.body).toContain('사람인지 확인');
    expect(body.body).toContain(needsAction.slot.time);
  });

  it('회차 식별자가 있으면 적고, 없으면 지어내지 않는다', async () => {
    const withSeq = await captureBody({ ...needsAction, reserveSeq: '2048' });
    expect(withSeq.body).toContain('2048');
    // 순서표에도 "회차"라는 말이 나오므로, 식별자를 감싼 코드 표기로 확인한다.
    const without = await captureBody({ ...needsAction, reserveSeq: null });
    expect(without.body).not.toMatch(/`회차 \d+`/);
  });

  it('확인번호가 없으면 지어내지 않는다', async () => {
    const body = await captureBody({ ...booked, confirmationId: null });
    expect(body.body).toContain('확인번호를 받지 못했습니다');
  });
});
