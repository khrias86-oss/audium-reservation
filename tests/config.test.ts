import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = { MODE: 'server' } as NodeJS.ProcessEnv;

describe('DRY_RUN 게이트', () => {
  it("정확히 'false'일 때만 실제 예약이 켜진다", () => {
    expect(loadConfig({ ...base, DRY_RUN: 'false' }).liveBooking).toBe(true);
  });

  it('미설정이면 안전한 쪽으로 해석한다', () => {
    expect(loadConfig(base).liveBooking).toBe(false);
  });

  it('오타나 유사값은 실제 예약을 켜지 않는다', () => {
    // 'False', '0', 'no' 같은 값이 게이트를 열면 원치 않는 실제 예약이 나간다.
    for (const v of ['False', 'FALSE', '0', 'no', 'off', '', ' false']) {
      expect(loadConfig({ ...base, DRY_RUN: v }).liveBooking).toBe(false);
    }
  });
});

describe('폴링 설정', () => {
  it('하한 미만은 기동 시점에 거부한다', () => {
    // 런타임에 조용히 보정하는 대신 죽는다. 잘못된 설정으로 도는 것보다 낫다.
    expect(() => loadConfig({ ...base, POLL_INTERVAL_MINUTES: '1' })).toThrow();
  });

  it('기본값은 10분이다', () => {
    expect(loadConfig(base).pollIntervalMinutes).toBe(10);
  });

  it('적응형은 기본 꺼짐이다', () => {
    expect(loadConfig(base).adaptivePolling).toBe(false);
  });
});

describe('모드', () => {
  it('server와 tick만 허용한다', () => {
    expect(loadConfig({ MODE: 'tick' }).mode).toBe('tick');
    expect(() => loadConfig({ MODE: 'daemon' })).toThrow();
  });

  it('기본 모드는 server다', () => {
    expect(loadConfig({}).mode).toBe('server');
  });
});

describe('알림 설정', () => {
  it('잘못된 이메일 주소는 거부한다', () => {
    expect(() => loadConfig({ ...base, NOTIFY_EMAIL_TO: 'not-an-email' })).toThrow();
  });
});
