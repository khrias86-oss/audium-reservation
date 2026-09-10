import { describe, expect, it } from 'vitest';
import { applyEvent, shouldPoll } from '../src/core/state-machine.js';
import type { Watch, WatchState } from '../src/core/types.js';

const watch = (state: WatchState): Watch => ({
  id: 'w1', userId: 'u1', date: '2026-03-14', time: '10:00', priority: 0, state,
});

describe('정상 예약 경로', () => {
  it('WATCHING → DETECTED → CLAIMING → BOOKED', () => {
    let w = watch('WATCHING');
    w = applyEvent(w, { type: 'SLOT_DETECTED' }).watch;
    expect(w.state).toBe('DETECTED');
    w = applyEvent(w, { type: 'CLAIM_STARTED' }).watch;
    expect(w.state).toBe('CLAIMING');
    w = applyEvent(w, { type: 'CLAIM_SUCCEEDED' }).watch;
    expect(w.state).toBe('BOOKED');
  });
});

describe('재시도', () => {
  it('재시도가 남아 있으면 CLAIMING을 유지한다', () => {
    const r = applyEvent(watch('CLAIMING'), { type: 'CLAIM_FAILED', retriesLeft: 1 });
    expect(r.watch.state).toBe('CLAIMING');
  });

  it('재시도를 소진하면 사람에게 넘긴다', () => {
    const r = applyEvent(watch('CLAIMING'), { type: 'CLAIM_FAILED', retriesLeft: 0 });
    expect(r.watch.state).toBe('FAILED_NEEDS_HUMAN');
  });

  it('예약 실패 후에도 감시는 계속된다 — 다음 취소표를 노린다', () => {
    expect(shouldPoll('FAILED_NEEDS_HUMAN')).toBe(true);
  });
});

describe('서킷 브레이커', () => {
  it('열렸다가 닫히면 감시로 복귀한다', () => {
    let w = applyEvent(watch('WATCHING'), { type: 'CIRCUIT_OPENED' }).watch;
    expect(w.state).toBe('CIRCUIT_OPEN');
    w = applyEvent(w, { type: 'CIRCUIT_CLOSED' }).watch;
    expect(w.state).toBe('WATCHING');
  });

  it('회로가 열린 동안에는 폴링하지 않는다', () => {
    expect(shouldPoll('CIRCUIT_OPEN')).toBe(false);
  });
});

describe('계약 드리프트', () => {
  it('파싱이 깨지면 CONTRACT_BROKEN으로 간다', () => {
    const r = applyEvent(watch('WATCHING'), { type: 'CONTRACT_DRIFT', reason: '스키마 불일치' });
    expect(r.watch.state).toBe('CONTRACT_BROKEN');
  });

  it('계약이 깨진 상태는 자동 복귀하지 않는다 — 사람이 고쳐야 한다', () => {
    // 사이트 개편은 파싱뿐 아니라 예약 절차 자체가 바뀌었을 수 있다.
    // 자동으로 WATCHING에 돌아가면 잘못된 예약을 제출할 위험이 있다.
    const r = applyEvent(watch('CONTRACT_BROKEN'), { type: 'CIRCUIT_CLOSED' });
    expect(r.changed).toBe(false);
    expect(r.rejected).toBeDefined();
    expect(shouldPoll('CONTRACT_BROKEN')).toBe(false);
  });
});

describe('종료 상태', () => {
  it('예약이 확정되면 어떤 이벤트로도 되돌아가지 않는다', () => {
    for (const event of [
      { type: 'SLOT_DETECTED' }, { type: 'CIRCUIT_OPENED' }, { type: 'PAUSED_BY_USER' },
    ] as const) {
      const r = applyEvent(watch('BOOKED'), event);
      expect(r.changed).toBe(false);
      expect(r.watch.state).toBe('BOOKED');
    }
  });

  it('같은 사용자의 다른 감시가 성공하면 STOPPED로 종료된다', () => {
    expect(applyEvent(watch('WATCHING'), { type: 'SUPERSEDED' }).watch.state).toBe('STOPPED');
  });

  it('관람일이 지나면 EXPIRED로 끝난다', () => {
    expect(applyEvent(watch('WATCHING'), { type: 'DATE_PASSED' }).watch.state).toBe('EXPIRED');
  });
});

describe('킬스위치', () => {
  it('일시정지와 재개가 왕복한다', () => {
    let w = applyEvent(watch('WATCHING'), { type: 'PAUSED_BY_USER' }).watch;
    expect(w.state).toBe('PAUSED');
    expect(shouldPoll('PAUSED')).toBe(false);
    w = applyEvent(w, { type: 'RESUMED_BY_USER' }).watch;
    expect(w.state).toBe('WATCHING');
  });

  it('예약 시도 중에도 사용자가 멈출 수 있다', () => {
    expect(applyEvent(watch('DETECTED'), { type: 'PAUSED_BY_USER' }).watch.state).toBe('PAUSED');
  });
});

describe('허용되지 않은 전이', () => {
  it('무시하되 이유를 남긴다 — 조용히 삼키지 않는다', () => {
    const r = applyEvent(watch('WATCHING'), { type: 'CLAIM_SUCCEEDED' });
    expect(r.changed).toBe(false);
    expect(r.rejected).toContain('허용되지 않는다');
  });

  it('CLAIMING이 아닌 상태의 실패 보고는 거부된다', () => {
    const r = applyEvent(watch('WATCHING'), { type: 'CLAIM_FAILED', retriesLeft: 0 });
    expect(r.changed).toBe(false);
    expect(r.rejected).toBeDefined();
  });
});
