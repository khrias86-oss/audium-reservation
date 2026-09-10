import { describe, expect, it } from 'vitest';
import { HEARTBEAT_STALE_MINUTES, checkHeartbeat } from '../src/core/heartbeat.js';

const now = new Date('2026-03-10T00:00:00Z');
const ago = (min: number) => new Date(now.getTime() - min * 60_000);

describe('checkHeartbeat', () => {
  it('한 번도 실행되지 않았으면 중단으로 본다', () => {
    const s = checkHeartbeat(null, now);
    expect(s.stale).toBe(true);
    expect(s.ageMinutes).toBeNull();
  });

  it('최근 하트비트는 정상이다', () => {
    expect(checkHeartbeat(ago(3), now).stale).toBe(false);
  });

  it('10분 주기에서 1틱 누락은 아직 정상이다', () => {
    expect(checkHeartbeat(ago(12), now).stale).toBe(false);
  });

  it('2틱 이상 누락되면 중단으로 판정한다', () => {
    const s = checkHeartbeat(ago(HEARTBEAT_STALE_MINUTES), now);
    expect(s.stale).toBe(true);
    expect(s.message).toContain('중단');
  });

  it('미래 타임스탬프는 시계 문제로 드러내되 중단으로 오판하지 않는다', () => {
    const s = checkHeartbeat(new Date(now.getTime() + 60_000), now);
    expect(s.stale).toBe(false);
    expect(s.message).toContain('시계');
  });

  it('메시지에 경과 시간을 담아 사용자가 판단할 수 있게 한다', () => {
    expect(checkHeartbeat(ago(40), now).message).toContain('40분');
  });
});
