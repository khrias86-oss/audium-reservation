import { describe, expect, it, vi } from 'vitest';
import { runTick, type TickDeps } from '../src/runtime/tick.js';
import { createMemoryStore } from '../src/store/memory.js';
import type { Applicant, BookingOutcome, SiteAdapter } from '../src/adapters/types.js';
import type { Notification, Notifier } from '../src/notify/types.js';
import type { ParseResult, Slot, Watch } from '../src/core/types.js';

const NOW = new Date('2026-03-10T00:00:00Z');

const slot = (date: string, time: string, status: Slot['status']): Slot => ({
  date, time, status, remain: status === 'AVAILABLE' ? 1 : 0, capacity: 20,
  bookUrl: 'https://audeum.org/booking',
});

const watch = (over: Partial<Watch> = {}): Watch => ({
  id: 'w1', userId: 'u1', date: '2026-03-14', time: '10:00',
  priority: 0, state: 'WATCHING', ...over,
});

const applicant: Applicant = { name: '홍길동', phone: '010-0000-0000', email: 'a@b.co' };

function harness(opts: {
  fetch: ParseResult | ParseResult[];
  submit?: BookingOutcome;
  watches?: Watch[];
}) {
  const sent: Notification[] = [];
  const queue = Array.isArray(opts.fetch) ? [...opts.fetch] : null;
  const submit = vi.fn(async (): Promise<BookingOutcome> => opts.submit ?? { kind: 'BOOKED', confirmationId: 'C1' });

  const adapter: SiteAdapter = {
    name: 'fake',
    fetchSlots: async () => (queue ? (queue.shift() ?? { kind: 'OK', slots: [] }) : (opts.fetch as ParseResult)),
    submitBooking: submit,
  };
  const notifier: Notifier = { send: async (n) => void sent.push(n) };
  const store = createMemoryStore(opts.watches ?? [watch()]);

  const deps: TickDeps = { adapter, store, notifier, applicant, now: () => NOW };
  return { deps, store, sent, submit };
}

describe('정상 경로', () => {
  it('여석이 없으면 폴링만 하고 끝난다', async () => {
    const { deps, submit } = harness({ fetch: { kind: 'OK', slots: [slot('2026-03-14', '10:00', 'SOLD_OUT')] } });
    const r = await runTick(deps);
    expect(r.outcome).toBe('POLLED');
    expect(submit).not.toHaveBeenCalled();
  });

  it('여석을 감지하면 예약하고 알린다', async () => {
    const { deps, sent } = harness({ fetch: { kind: 'OK', slots: [slot('2026-03-14', '10:00', 'AVAILABLE')] } });
    const r = await runTick(deps);
    expect(r.outcome).toBe('BOOKED');
    expect(sent[0]?.kind).toBe('BOOKED');
  });

  it('예약 성공 시 같은 사용자의 다른 감시를 종료한다 (1인 1매)', async () => {
    const { deps, store } = harness({
      fetch: { kind: 'OK', slots: [slot('2026-03-14', '10:00', 'AVAILABLE')] },
      watches: [watch({ id: 'w1', priority: 0 }), watch({ id: 'w2', date: '2026-03-21', priority: 1 })],
    });
    await runTick(deps);
    const after = await store.listWatches();
    expect(after.find((w) => w.id === 'w1')?.state).toBe('BOOKED');
    expect(after.find((w) => w.id === 'w2')?.state).toBe('STOPPED');
  });

  it('매 틱마다 하트비트를 남긴다', async () => {
    const { deps, store } = harness({ fetch: { kind: 'OK', slots: [] } });
    await runTick(deps);
    expect(await store.getHeartbeat()).toEqual(NOW);
  });

  it('조회가 실패해도 하트비트는 남긴다 — 워커 생존과 조회 성공은 다른 신호다', async () => {
    const { deps, store } = harness({ fetch: { kind: 'TRANSIENT_ERROR', reason: 'timeout' } });
    await runTick(deps);
    expect(await store.getHeartbeat()).toEqual(NOW);
  });
});

describe('멱등성', () => {
  it('같은 슬롯에 두 번 제출하지 않는다', async () => {
    const { deps, submit } = harness({ fetch: { kind: 'OK', slots: [slot('2026-03-14', '10:00', 'AVAILABLE')] } });
    await runTick(deps);
    // 두 번째 틱: 감시는 BOOKED라 후보가 아니지만, 멱등성 키가 최후 방어선이다.
    await runTick(deps);
    expect(submit).toHaveBeenCalledTimes(1);
  });
});

describe('DRY_RUN', () => {
  it('시뮬레이션 결과도 성공으로 처리하되 확인번호를 만들어내지 않는다', async () => {
    const { deps, sent } = harness({
      fetch: { kind: 'OK', slots: [slot('2026-03-14', '10:00', 'AVAILABLE')] },
      submit: { kind: 'SIMULATED', payload: { fake: true } },
    });
    const r = await runTick(deps);
    expect(r.outcome).toBe('BOOKED');
    const n = sent[0];
    expect(n?.kind === 'BOOKED' && n.confirmationId).toBeNull();
  });
});

describe('실패 처리', () => {
  it('CAPTCHA·본인인증은 재시도하지 않고 즉시 사람에게 넘긴다', async () => {
    const { deps, sent, submit } = harness({
      fetch: { kind: 'OK', slots: [slot('2026-03-14', '10:00', 'AVAILABLE')] },
      submit: { kind: 'NEEDS_HUMAN', reason: '본인인증 요구', resumeUrl: 'https://audeum.org/booking' },
    });
    const r = await runTick(deps);
    expect(r.outcome).toBe('NEEDS_HUMAN');
    expect(submit).toHaveBeenCalledTimes(1);
    expect(sent[0]?.kind).toBe('NEEDS_ACTION');
  });

  it('남이 채간 경우 재시도하지 않고 감시로 돌아간다', async () => {
    const { deps, store, submit } = harness({
      fetch: { kind: 'OK', slots: [slot('2026-03-14', '10:00', 'AVAILABLE')] },
      submit: { kind: 'SLOT_TAKEN' },
    });
    const r = await runTick(deps);
    expect(r.outcome).toBe('POLLED');
    expect(submit).toHaveBeenCalledTimes(1);
    expect((await store.listWatches())[0]?.state).toBe('WATCHING');
  });

  it('일시적 오류는 재시도하고, 소진하면 조치필요 알림을 보낸다', async () => {
    const { deps, sent, submit } = harness({
      fetch: { kind: 'OK', slots: [slot('2026-03-14', '10:00', 'AVAILABLE')] },
      submit: { kind: 'RETRYABLE_ERROR', reason: '502' },
    });
    const r = await runTick(deps);
    expect(r.outcome).toBe('NEEDS_HUMAN');
    expect(submit).toHaveBeenCalledTimes(3); // 최초 1 + 재시도 2
    expect(sent[0]?.kind).toBe('NEEDS_ACTION');
  });
});

describe('계약 드리프트', () => {
  it('스키마가 깨지면 CONTRACT_BROKEN으로 전이하고 경고한다', async () => {
    const { deps, store, sent } = harness({ fetch: { kind: 'CONTRACT_BROKEN', reason: '스키마 불일치: remain 필드 없음' } });
    const r = await runTick(deps);
    expect(r.outcome).toBe('CONTRACT_BROKEN');
    expect((await store.listWatches())[0]?.state).toBe('CONTRACT_BROKEN');
    expect(sent[0]?.kind).toBe('SYSTEM_WARNING');
  });

  it('드리프트는 여석 없음과 다르게 처리된다', async () => {
    // 빈 슬롯 목록은 정상 폴링, 스키마 실패는 경고. 이 둘이 섞이면
    // 사이트 개편 후 시스템이 조용히 영원히 실패한다.
    const empty = await runTick(harness({ fetch: { kind: 'OK', slots: [] } }).deps);
    expect(empty.outcome).toBe('POLLED');
  });
});

describe('서킷 브레이커', () => {
  it('연속 5회 실패 후 개방되고, 이후 틱은 조회를 건너뛴다', async () => {
    const fail: ParseResult = { kind: 'TRANSIENT_ERROR', reason: 'ECONNRESET' };
    const { deps, sent } = harness({ fetch: [fail, fail, fail, fail, fail, fail] });

    for (let i = 0; i < 5; i++) {
      expect((await runTick(deps)).outcome).toBe('POLLED');
    }
    expect(sent.filter((n) => n.kind === 'SYSTEM_WARNING')).toHaveLength(1);

    expect((await runTick(deps)).outcome).toBe('CIRCUIT_OPEN');
  });

  it('쿨다운이 끝나면 감시가 되살아난다 — 회로가 영구 교착되지 않는다', async () => {
    // 회귀 테스트: 활성 감시를 먼저 거르면 CIRCUIT_OPEN 상태의 감시가
    // shouldPoll=false라 조기 종료되고, 회로를 닫을 기회가 영영 오지 않았다.
    const fail: ParseResult = { kind: 'TRANSIENT_ERROR', reason: 'ECONNRESET' };
    const ok: ParseResult = { kind: 'OK', slots: [slot('2026-03-14', '10:00', 'SOLD_OUT')] };
    const { deps, store } = harness({ fetch: [fail, fail, fail, fail, fail, ok] });

    let clock = new Date(NOW);
    const timed: TickDeps = { ...deps, now: () => clock };

    for (let i = 0; i < 5; i++) await runTick(timed);
    expect((await store.listWatches())[0]?.state).toBe('CIRCUIT_OPEN');

    clock = new Date(NOW.getTime() + 31 * 60_000);
    const resumed = await runTick(timed);

    expect(resumed.outcome).toBe('POLLED');
    expect((await store.listWatches())[0]?.state).toBe('WATCHING');
  });
});

describe('만료', () => {
  it('관람일이 지난 감시는 EXPIRED로 정리된다', async () => {
    const { deps, store } = harness({
      fetch: { kind: 'OK', slots: [] },
      watches: [watch({ date: '2026-03-01' })],
    });
    const r = await runTick(deps);
    expect(r.outcome).toBe('NOTHING_TO_WATCH');
    expect((await store.listWatches())[0]?.state).toBe('EXPIRED');
  });
});

describe('가상 대기열', () => {
  // 오디움은 혼잡 시 "동시접속자가 많아 잠시 대기 중입니다"를 HTTP 200으로 준다.
  // 이 응답을 어떻게 분류하느냐가 시스템의 성패를 가른다 (5차 정찰에서 발견).
  const queued: ParseResult = { kind: 'QUEUED', message: '동시접속자가 많아 잠시 대기 중입니다' };

  it('대기열은 예약을 시도하지 않는다 — 자리 상황을 본 적이 없다', async () => {
    const { deps, submit } = harness({ fetch: queued });
    const r = await runTick(deps);
    expect(r.outcome).toBe('QUEUED');
    expect(submit).not.toHaveBeenCalled();
  });

  it('대기열은 서킷 브레이커를 열지 않는다 — 장애가 아니라 정상 상황이다', async () => {
    // 오류로 취급하면 혼잡할수록 감시가 멈춘다. 정확히 반대로 동작해야 한다.
    const { deps } = harness({ fetch: [queued, queued, queued, queued, queued, queued] });
    for (let i = 0; i < 6; i++) {
      expect((await runTick(deps)).outcome).toBe('QUEUED');
    }
  });

  it('대기열은 계약 파손 경고를 보내지 않는다', async () => {
    const { deps, sent } = harness({ fetch: queued });
    await runTick(deps);
    expect(sent).toHaveLength(0);
  });

  it('대기열이 직전 스냅샷을 덮어쓰지 않는다', async () => {
    // 덮어쓰면 다음 정상 조회에서 원래 열려 있던 슬롯이 "새로 열렸다"로 잘못 잡힌다.
    const open: ParseResult = { kind: 'OK', slots: [slot('2026-03-14', '11:00', 'AVAILABLE')] };
    const { deps, store } = harness({
      fetch: [open, queued],
      watches: [watch({ time: '15:30' })], // 예약으로 이어지지 않는 조건
    });

    await runTick(deps);
    const afterFirst = await store.getSnapshot();
    await runTick(deps);
    expect(await store.getSnapshot()).toEqual(afterFirst);
  });

  it('대기열에서도 하트비트는 남는다 — 워커는 살아 있다', async () => {
    const { deps, store } = harness({ fetch: queued });
    await runTick(deps);
    expect(await store.getHeartbeat()).toEqual(NOW);
  });

  it('대기열이 풀리면 정상적으로 예약을 잡는다', async () => {
    const { deps, submit } = harness({
      fetch: [queued, { kind: 'OK', slots: [slot('2026-03-14', '10:00', 'AVAILABLE')] }],
    });
    expect((await runTick(deps)).outcome).toBe('QUEUED');
    expect((await runTick(deps)).outcome).toBe('BOOKED');
    expect(submit).toHaveBeenCalledTimes(1);
  });
});
