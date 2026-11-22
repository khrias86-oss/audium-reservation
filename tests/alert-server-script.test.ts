import { beforeEach, describe, expect, it } from 'vitest';
import { loadAppsScript, SERVICE_URL, type AppsScriptWorld } from './helpers/apps-script.js';

const KEY = 'test-key';
const kst = (s: string) => Date.parse(`${s}+09:00`);
const NOW = kst('2026-11-24T09:00:00');
const MIN = 60_000;

let w: AppsScriptWorld;

beforeEach(() => {
  w = loadAppsScript();
  w.ctx['setup']();
  w.props.set('NOTIFY_KEY', KEY);
  w.mails.length = 0;
});

const subscribe = (email: string, slots: Array<{ date: string; time: string }>, now = NOW) =>
  w.post({ action: 'subscribe', email, product: 'exhibition', slots }, now);
const observe = (available: boolean, now: number, date = '2026-12-04', time = '10:00') =>
  w.post({
    action: 'report', key: KEY,
    observations: [{ product: 'exhibition', date, time, available, subject: '자리 났어요', text: '지금 예약하세요', click: 'https://audeum.org/booking' }],
  }, now);

describe('처음 설정 (setup)', () => {
  it('시트와 열쇠를 만들고 그 값을 주인에게 메일로 보낸다', () => {
    const fresh = loadAppsScript();
    fresh.ctx['setup']();
    expect(fresh.props.get('SHEET_ID')).toBe('SHEET');
    expect(fresh.props.get('NOTIFY_KEY')).toMatch(/^[0-9a-f]{64}$/);
    expect(fresh.mails[0]?.to).toBe('owner@example.com');
    expect(fresh.mails[0]?.body).toContain(fresh.props.get('NOTIFY_KEY')!);
    expect(fresh.sheetValues()[0]).toEqual(expect.arrayContaining(['id', 'email', 'topic']));
  });

  it('다시 실행해도 열쇠를 바꾸지 않는다 — GitHub 시크릿과 어긋나지 않게', () => {
    const before = w.props.get('NOTIFY_KEY');
    w.ctx['setup']();
    expect(w.props.get('NOTIFY_KEY')).toBe(before);
  });
});

describe('신청', () => {
  it('회차마다 한 줄씩 저장하고, 신청 하나에 푸시 채널 하나를 준다', () => {
    const r = subscribe('A@Example.com ', [{ date: '2026-12-04', time: '10:00' }, { date: '2026-12-05', time: '13:30' }]);
    expect(r.ok).toBe(true);
    expect(r.topic).toMatch(/^audeum-[0-9a-f]{20}$/);
    expect(r.items).toHaveLength(2);
    const rows = w.sheetValues().slice(1);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.includes('a@example.com') && row.includes(r.topic))).toBe(true);
  });

  it('확인 메일에 회차별 "그만 받기" 링크와 푸시 채널 이름이 들어 있다', () => {
    const r = subscribe('a@example.com', [{ date: '2026-12-04', time: '10:00' }]);
    const mail = w.mails[0]!;
    expect(mail.to).toBe('a@example.com');
    expect(mail.body).toContain('12/4(금) 10:00');
    expect(mail.body).toContain(`${SERVICE_URL}?a=cancel&id=${r.items[0].id}&t=${r.items[0].token}`);
    expect(mail.body).toContain(r.topic);
    expect(r.mailed).toBe(true);
  });

  it('신청마다 다른 메일 주소를 쓸 수 있다', () => {
    subscribe('a@example.com', [{ date: '2026-12-04', time: '10:00' }]);
    subscribe('b@example.com', [{ date: '2026-12-04', time: '10:00' }]);
    expect(w.sheetValues().slice(1).map((row) => row[6])).toEqual(['a@example.com', 'b@example.com']);
  });

  it('같은 사람이 같은 회차를 다시 신청하면 새 신청으로 바꾼다 — 알림이 두 번 오지 않게', () => {
    subscribe('a@example.com', [{ date: '2026-12-04', time: '10:00' }]);
    const second = subscribe('a@example.com', [{ date: '2026-12-04', time: '10:00' }]);
    const rows = w.sheetValues().slice(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain(second.topic);
  });

  it('잘못된 메일·날짜, 곧 시작하는 회차는 받지 않는다', () => {
    expect(subscribe('not-an-email', [{ date: '2026-12-04', time: '10:00' }]).ok).toBe(false);
    expect(subscribe('a@example.com', [{ date: '12/4', time: '10:00' }]).ok).toBe(false);
    expect(subscribe('a@example.com', []).ok).toBe(false);
    // 회차 시작 30분 전 — 이미 감시가 끝나는 구간이다
    expect(subscribe('a@example.com', [{ date: '2026-11-24', time: '09:30' }]).ok).toBe(false);
    expect(w.sheetValues().slice(1)).toHaveLength(0);
  });

  it('남은 발송 한도가 적으면 확인 메일을 건너뛴다 — 실제 알림에 한도를 남긴다', () => {
    w.quota = 20;
    const r = subscribe('a@example.com', [{ date: '2026-12-04', time: '10:00' }]);
    expect(r.ok).toBe(true);
    expect(r.mailed).toBe(false);
    expect(w.mails).toHaveLength(0);
  });

  it('오픈 알림은 회차 없이 신청한다', () => {
    const r = w.post({ action: 'subscribe', email: 'a@example.com', product: 'exhibition', kind: 'open' }, NOW);
    expect(r.ok).toBe(true);
    expect(w.mails[0]!.body).toContain('다음 예약이 열리면');
  });
});

describe('취소', () => {
  it('맞는 토큰이어야 지운다', () => {
    const r = subscribe('a@example.com', [{ date: '2026-12-04', time: '10:00' }]);
    const { id, token } = r.items[0];
    expect(w.post({ action: 'cancel', id, token: 'wrong' }).ok).toBe(false);
    expect(w.sheetValues().slice(1)).toHaveLength(1);
    expect(w.post({ action: 'cancel', id, token }).ok).toBe(true);
    expect(w.sheetValues().slice(1)).toHaveLength(0);
  });

  it('메일의 "그만 받기" 링크(GET)로도 끈다', () => {
    const r = subscribe('a@example.com', [{ date: '2026-12-04', time: '10:00' }]);
    const page = w.get({ a: 'cancel', id: r.items[0].id, t: r.items[0].token });
    expect(page.title).toBe('알림을 껐습니다');
    expect(w.sheetValues().slice(1)).toHaveLength(0);
    expect(w.get({ a: 'cancel', id: r.items[0].id, t: r.items[0].token }).title).toBe('이미 꺼진 알림입니다');
  });
});

describe('감시 시스템 전용 요청', () => {
  it('열쇠가 없으면 거절한다 — 가짜 "자리 났다"로 메일을 뿌리지 못하게', () => {
    subscribe('a@example.com', [{ date: '2026-12-04', time: '10:00' }]);
    w.mails.length = 0;
    expect(w.post({ action: 'wants' }).ok).toBe(false);
    expect(w.post({ action: 'report', key: 'nope', observations: [{ product: 'exhibition', date: '2026-12-04', time: '10:00', available: true }] }).ok).toBe(false);
    expect(w.mails).toHaveLength(0);
  });

  it('wants는 볼 회차만 중복 없이 주고, 메일 주소는 주지 않는다', () => {
    subscribe('a@example.com', [{ date: '2026-12-04', time: '10:00' }]);
    subscribe('b@example.com', [{ date: '2026-12-04', time: '10:00' }, { date: '2026-12-05', time: '13:30' }]);
    w.post({ action: 'subscribe', email: 'c@example.com', product: 'exhibition', kind: 'open' }, NOW);
    const r = w.post({ action: 'wants', key: KEY }, NOW);
    expect(r.slots).toEqual([
      { product: 'exhibition', date: '2026-12-04', time: '10:00' },
      { product: 'exhibition', date: '2026-12-05', time: '13:30' },
    ]);
    expect(r.opens).toEqual(['exhibition']);
    expect(JSON.stringify(r)).not.toContain('@example.com');
  });

  it('회차 시작 1시간 전이 되면 신청을 지운다 — 메일 주소를 오래 들고 있지 않는다', () => {
    subscribe('a@example.com', [{ date: '2026-12-04', time: '10:00' }]);
    expect(w.post({ action: 'wants', key: KEY }, kst('2026-12-04T08:59:00')).slots).toHaveLength(1);
    expect(w.post({ action: 'wants', key: KEY }, kst('2026-12-04T09:00:00')).slots).toHaveLength(0);
    expect(w.sheetValues().slice(1)).toHaveLength(0);
  });
});

describe('빈자리 알림 규칙 — 즉시 1번, 10분 뒤 재확인해 남아 있으면 1번 더', () => {
  beforeEach(() => {
    subscribe('a@example.com', [{ date: '2026-12-04', time: '10:00' }]);
    w.mails.length = 0;
  });
  const t0 = kst('2026-11-26T14:00:00');

  it('자리가 보이면 즉시 메일과 푸시를 그 신청자에게만 보낸다', () => {
    subscribe('b@example.com', [{ date: '2026-12-05', time: '13:30' }]);
    w.mails.length = 0;
    const r = observe(true, t0);
    expect(r.alerted).toBe(1);
    expect(w.mails.map((m) => m.to)).toEqual(['a@example.com']);
    expect(w.mails[0]!.body).toContain('지금 예약하세요');
    expect(w.mails[0]!.body).toContain('?a=cancel&id=');
    expect(w.pushes).toHaveLength(1);
    expect(w.pushes[0]!.payload.priority).toBe(5);
  });

  it('5분 뒤 확인에서는 보내지 않고, 10분 뒤에도 남아 있으면 한 번 더 보낸다', () => {
    observe(true, t0);
    observe(true, t0 + 5 * MIN);
    expect(w.mails).toHaveLength(1);
    observe(true, t0 + 10 * MIN);
    expect(w.mails).toHaveLength(2);
    observe(true, t0 + 15 * MIN);
    expect(w.mails).toHaveLength(2);
    observe(true, t0 + 20 * MIN);
    expect(w.mails).toHaveLength(3);
  });

  it('5분 간격 확인이 몇 초 일찍 와도 10분째 확인으로 친다', () => {
    observe(true, t0);
    observe(true, t0 + 10 * MIN - 20_000);
    expect(w.mails).toHaveLength(2);
  });

  it('재확인 때 자리가 없으면 알림이 끝나고, 다음 취소표는 다시 즉시 알린다', () => {
    observe(true, t0);
    observe(false, t0 + 5 * MIN);
    observe(false, t0 + 10 * MIN);
    expect(w.mails).toHaveLength(1);
    observe(true, t0 + 12 * MIN);
    expect(w.mails).toHaveLength(2);
  });

  it('이번에 확인하지 못한 회차(결과에 없음)는 상태를 건드리지 않는다', () => {
    observe(true, t0);
    w.post({ action: 'report', key: KEY, observations: [] }, t0 + 5 * MIN);
    observe(true, t0 + 7 * MIN);
    expect(w.mails).toHaveLength(1);
  });

  it('메일 한도를 다 써도 푸시는 간다', () => {
    w.quota = 0;
    const r = observe(true, t0);
    expect(r.mailed).toBe(0);
    expect(r.pushed).toBe(1);
  });

  it('마지막 확인 시각을 남긴다 — 페이지가 "감시가 돌고 있나"를 보여준다', () => {
    observe(false, t0);
    expect(w.post({ action: 'status' }, t0).lastReportAt).toBe(new Date(t0).toISOString());
  });
});

describe('오픈 알림', () => {
  beforeEach(() => {
    w.post({ action: 'subscribe', email: 'a@example.com', product: 'exhibition', kind: 'open' }, NOW);
    subscribe('b@example.com', [{ date: '2026-12-04', time: '10:00' }]);
    w.mails.length = 0;
  });

  it('예고는 같은 예상 시각에 한 번만, 오픈 알림 신청자에게만 보낸다', () => {
    const soon = { action: 'opening', key: KEY, event: 'soon', product: 'exhibition', at: '2026-11-24T14:00:00', subject: '곧 열려요', text: '준비하세요' };
    w.post(soon, kst('2026-11-24T12:30:00'));
    w.post(soon, kst('2026-11-24T12:35:00'));
    expect(w.mails.map((m) => m.to)).toEqual(['a@example.com']);
  });

  it('열림을 알리면 그 신청은 끝난다', () => {
    w.post({ action: 'opening', key: KEY, event: 'opened', product: 'exhibition', subject: '열렸어요', text: '지금' }, kst('2026-11-24T14:05:00'));
    expect(w.mails.map((m) => m.to)).toEqual(['a@example.com']);
    expect(w.post({ action: 'wants', key: KEY }, kst('2026-11-24T14:06:00')).opens).toEqual([]);
  });
});

describe('지난 신청 (9/19 재발 방지)', () => {
  const isExpired = (row: object, at: Date) => w.ctx['isExpired']({ kind: 'slot', ...row }, at.getTime());

  it('회차 시작 1시간 전부터는 지난 것으로 본다', () => {
    const r = { date: '2026-09-19', time: '13:30' };
    expect(isExpired(r, new Date(kst('2026-09-19T12:29:00')))).toBe(false);
    expect(isExpired(r, new Date(kst('2026-09-19T12:30:00')))).toBe(true);
    // 9/19 저녁 경고가 쌓이던 시각 — 이 신청은 이미 감시 대상이 아니었어야 했다.
    expect(isExpired(r, new Date(kst('2026-09-19T22:06:00')))).toBe(true);
  });

  it('실행 환경 타임존과 무관하게 KST로 판단한다', () => {
    // 2026-11-26 10:00 KST = 2026-11-26 01:00 UTC.
    expect(isExpired({ date: '2026-11-26', time: '10:00' }, new Date('2026-11-25T23:59:00Z'))).toBe(false);
    expect(isExpired({ date: '2026-11-26', time: '10:00' }, new Date('2026-11-26T00:00:00Z'))).toBe(true);
  });
});

describe('시트가 날짜·시각을 바꿔 놓아도', () => {
  it('글자로 되돌려 읽는다', () => {
    expect(w.ctx['cellText'](new Date(2026, 11, 4))).toBe('2026-12-04');
    expect(w.ctx['cellText'](new Date(1899, 11, 30, 10, 0))).toBe('10:00');
  });
});
