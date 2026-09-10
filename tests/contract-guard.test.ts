import { describe, expect, it } from 'vitest';
import {
  CONTRACT, FLOW, FORM_FIELDS, ITEM_CLICK_COOLDOWN_MS, QUEUE_MARKERS,
  assertContractReady, isQueuePage, type AudeumContract,
} from '../src/adapters/audeum/contract.js';

const filled: AudeumContract = {
  entryUrl: 'https://example.invalid/booking',
  rendering: 'SPA',
  slotPageUrl: 'https://example.invalid/slots',
  submitEndpoint: 'https://example.invalid/submit',
  soldOutSignal: 'remain === 0',
  queueRetriesNeeded: 2,
};

describe('계약 준비 가드', () => {
  it('정찰 전에는 어댑터 실행을 거부한다', () => {
    // M1이 끝나기 전에 추측한 셀렉터로 예약을 제출하는 것이 최악의 시나리오다.
    expect(() => assertContractReady(CONTRACT)).toThrow(/계약이 아직 확정되지 않았습니다/);
  });

  it('미확인 항목을 이름으로 알려준다', () => {
    // 8차 정찰로 대부분이 확정됐고, 지금 남은 것은 대기열 통과 비용뿐이다.
    expect(() => assertContractReady(CONTRACT)).toThrow(/queueRetriesNeeded/);
  });

  it('일부만 채워져도 거부한다', () => {
    expect(() => assertContractReady({ ...filled, submitEndpoint: null })).toThrow(/submitEndpoint/);
  });

  it('전부 채워지면 통과한다', () => {
    expect(() => assertContractReady(filled)).not.toThrow();
  });

  it('대기열 통과 비용은 아직 미확정이다 — M1이 끝나지 않았음을 고정한다', () => {
    // 6·8차는 1회 만에 통과했지만 혼잡 시간대 표본이 없어 폴링 예산의 근거로는 부족하다.
    expect(CONTRACT.queueRetriesNeeded).toBeNull();
  });

  it('실측으로 확인된 항목은 이미 채워져 있다', () => {
    expect(CONTRACT.entryUrl).toBe('https://audeum.org/booking');
    expect(CONTRACT.slotPageUrl).toBe('/booking/date');
    expect(CONTRACT.soldOutSignal).toBe('예약가능한 시간이 아닙니다');
  });
});

describe('대기열 판별', () => {
  // 5차 정찰에서 실제로 받은 페이지의 문구다.
  const realQueuePage =
    '동시접속자가 많아 잠시 대기 중입니다.\n' +
    'We are currently experiencing a high volume of traffic.\n' +
    'Please give us a moment.\n새로고침\n(Refresh)';

  it('실제로 관측한 대기열 페이지를 인식한다', () => {
    expect(isQueuePage(realQueuePage)).toBe(true);
  });

  it('한국어 문구만 있어도 인식한다', () => {
    expect(isQueuePage('동시접속자가 많아 잠시 대기 중입니다.')).toBe(true);
  });

  it('영어 문구만 있어도 인식한다', () => {
    // 사이트는 EN/KR을 전환할 수 있다. 한쪽만 봐서는 안 된다.
    expect(isQueuePage('We are currently experiencing a high volume of traffic.')).toBe(true);
  });

  it('정상 예약 페이지를 대기열로 오판하지 않는다', () => {
    expect(isQueuePage('Reserve\nSelect ticket\nEXHIBITIONS\nFREE')).toBe(false);
  });

  it('빈 문자열을 대기열로 보지 않는다', () => {
    // 빈 응답은 대기열이 아니라 파싱 실패다. 둘은 다르게 처리돼야 한다.
    expect(isQueuePage('')).toBe(false);
  });

  it('지문이 비어 있지 않다 — 판별이 항상 false가 되는 사고를 막는다', () => {
    expect(QUEUE_MARKERS.length).toBeGreaterThan(0);
  });
});

describe('예약 플로우 계약', () => {
  it('전시와 렉처가 대칭 구조다', () => {
    // 8차 정찰에서 확인: 두 상품이 같은 단계를 다른 경로로 밟는다.
    expect(FLOW.exhibition.age).toBe('/booking/age');
    expect(FLOW.lecture.age).toBe('/programs/age');
    expect(FLOW.exhibition.date).toBe('/booking/date');
    expect(FLOW.lecture.date).toBe('/programs/date');
  });

  it('제출 엔드포인트가 날짜 조회와 분리되어 있다', () => {
    // 여석 확인은 date로 끝난다. payment를 건드리지 않고도 감시가 가능하다는 뜻이고,
    // 이것이 DRY_RUN 게이트를 실효성 있게 만든다.
    expect(FLOW.exhibition.date).not.toBe(FLOW.exhibition.payment);
  });

  it('상품 클릭 쿨다운이 사이트 구현과 일치한다', () => {
    // 사이트가 setTimeout(...,3000)으로 3초간 재클릭을 무시한다.
    expect(ITEM_CLICK_COOLDOWN_MS).toBe(3_000);
  });

  it('제출 버튼 셀렉터가 기록되어 있다 — 클릭 금지 대상을 특정하기 위해서다', () => {
    expect(FORM_FIELDS.submitButton).toBe('#btn_reserve');
  });
});
