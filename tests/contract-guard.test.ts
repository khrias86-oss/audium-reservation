import { describe, expect, it } from 'vitest';
import { CONTRACT, assertContractReady, type AudeumContract } from '../src/adapters/audeum/contract.js';

const filled: AudeumContract = {
  rendering: 'SPA',
  monthEndpoint: 'https://example.invalid/month',
  slotEndpoint: 'https://example.invalid/slots',
  submitEndpoint: 'https://example.invalid/submit',
  soldOutSignal: 'remain === 0',
};

describe('계약 준비 가드', () => {
  it('정찰 전에는 어댑터 실행을 거부한다', () => {
    // M1이 끝나기 전에 추측한 셀렉터로 예약을 제출하는 것이 최악의 시나리오다.
    expect(() => assertContractReady(CONTRACT)).toThrow(/계약이 아직 확정되지 않았습니다/);
  });

  it('미확인 항목을 이름으로 알려준다', () => {
    expect(() => assertContractReady(CONTRACT)).toThrow(/monthEndpoint/);
  });

  it('일부만 채워져도 거부한다', () => {
    expect(() => assertContractReady({ ...filled, submitEndpoint: null })).toThrow(/submitEndpoint/);
  });

  it('전부 채워지면 통과한다', () => {
    expect(() => assertContractReady(filled)).not.toThrow();
  });

  it('현재 저장소의 계약은 아직 비어 있다 — M1 미완료 상태를 명시적으로 고정한다', () => {
    expect(CONTRACT.rendering).toBeNull();
  });
});
