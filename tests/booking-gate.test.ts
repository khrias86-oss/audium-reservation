import { describe, expect, it } from 'vitest';
import { decideBookingMode } from '../src/booking-gate.js';

const applicant = { applicantName: '홍길동', applicantEmail: 'a@b.co' };

describe('실제 예약 관문', () => {
  it("DRY_RUN이 정확히 'false'이고 예약자 정보가 있을 때만 켜진다", () => {
    expect(decideBookingMode({ dryRunEnv: 'false', ...applicant }).live).toBe(true);
  });

  it('값이 없으면 확인 모드다', () => {
    // 첫 시험 운전에서 워크플로가 값을 안 넘겼는데 실제 예약 모드로 켜졌다.
    // 없는 값은 반드시 안전한 쪽으로 떨어져야 한다.
    expect(decideBookingMode({ dryRunEnv: undefined, ...applicant }).live).toBe(false);
  });

  it('비슷하지만 다른 값들은 전부 확인 모드다', () => {
    for (const v of ['False', 'FALSE', '0', 'no', 'off', '', ' false', 'true']) {
      expect(decideBookingMode({ dryRunEnv: v, ...applicant }).live).toBe(false);
    }
  });

  it('예약자 이름이 없으면 켜지지 않는다', () => {
    const d = decideBookingMode({ dryRunEnv: 'false', applicantName: '', applicantEmail: 'a@b.co' });
    expect(d.live).toBe(false);
    if (d.live) return;
    expect(d.reason).toContain('Secrets');
  });

  it('예약자 이메일이 없으면 켜지지 않는다', () => {
    const d = decideBookingMode({ dryRunEnv: 'false', applicantName: '홍길동', applicantEmail: undefined });
    expect(d.live).toBe(false);
  });

  it('공백만 있는 값은 없는 것으로 본다', () => {
    const d = decideBookingMode({ dryRunEnv: 'false', applicantName: '   ', applicantEmail: 'a@b.co' });
    expect(d.live).toBe(false);
  });

  it('이메일 형식이 틀리면 켜지지 않는다', () => {
    const d = decideBookingMode({ dryRunEnv: 'false', applicantName: '홍길동', applicantEmail: '전화번호' });
    expect(d.live).toBe(false);
    if (d.live) return;
    expect(d.reason).toContain('이메일 형식');
  });

  it('확인 모드일 때는 항상 이유를 설명한다', () => {
    // 로그만 보고도 왜 예약이 안 됐는지 알 수 있어야 한다.
    const d = decideBookingMode({ dryRunEnv: undefined, applicantName: undefined, applicantEmail: undefined });
    if (d.live) throw new Error('확인 모드여야 한다');
    expect(d.reason.length).toBeGreaterThan(10);
  });
});
