import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractReserveSeq, parseTimeFragment } from '../src/adapters/audeum/parse-time-fragment.js';

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');

describe('실측 HTML — 전 회차 매진 (2026-09-10 정찰에서 실제로 받은 응답)', () => {
  const result = parseTimeFragment(fixture('time-all-sold-out'));

  it('회차 3개를 읽는다', () => {
    expect(result.kind).toBe('OK');
    if (result.kind !== 'OK') return;
    expect(result.slots).toHaveLength(3);
  });

  it('세 회차 모두 매진으로 판정한다', () => {
    if (result.kind !== 'OK') throw new Error('OK여야 한다');
    expect(result.slots.every((s) => s.status === 'SOLD_OUT')).toBe(true);
  });

  it('날짜와 회차 시각을 정확히 읽는다', () => {
    if (result.kind !== 'OK') throw new Error('OK여야 한다');
    expect(result.slots.map((s) => s.time)).toEqual(['13:30', '14:30', '15:30']);
    expect(result.slots.every((s) => s.date === '2026-09-10')).toBe(true);
  });

  it('잔여 좌석 수를 0으로 지어내지 않는다', () => {
    // 사이트가 잔여수를 노출하지 않는다. 0으로 채우면 "자리 없음"으로 오해되고,
    // 나중에 그 값을 근거로 판단하는 코드가 생기면 조용히 틀린다.
    if (result.kind !== 'OK') throw new Error('OK여야 한다');
    expect(result.slots.every((s) => s.remain === null)).toBe(true);
  });
});

describe('일부 여석', () => {
  const result = parseTimeFragment(fixture('time-partially-available'));

  it('여석 있는 회차와 매진 회차를 구분한다', () => {
    if (result.kind !== 'OK') throw new Error('OK여야 한다');
    expect(result.slots.find((s) => s.time === '10:00')?.status).toBe('AVAILABLE');
    expect(result.slots.find((s) => s.time === '11:00')?.status).toBe('SOLD_OUT');
  });

  it('disabled-time-slots 클래스가 매진 판별 기준이다', () => {
    // 사이트 자신의 클릭 핸들러가 이 클래스를 보고 클릭을 거부한다.
    // 우리 판별과 사이트 판별이 같은 근거를 쓴다는 뜻이다.
    if (result.kind !== 'OK') throw new Error('OK여야 한다');
    const available = result.slots.filter((s) => s.status === 'AVAILABLE');
    expect(available).toHaveLength(1);
  });
});

describe('예약 식별자 추출', () => {
  it('날짜·회차로 seq_reserve를 찾는다', () => {
    expect(extractReserveSeq(fixture('time-all-sold-out'), '2026-09-10', '14:30')).toBe('2059');
  });

  it('없는 회차면 null을 준다 — 아무 값이나 돌려주지 않는다', () => {
    expect(extractReserveSeq(fixture('time-all-sold-out'), '2026-09-10', '09:00')).toBeNull();
  });
});

describe('비정상 응답', () => {
  it('빈 응답은 여석 없음이 아니라 계약 파손이다', () => {
    // 이 구분이 이 시스템의 핵심이다. 빈 응답을 "자리 없음"으로 읽으면
    // 사이트가 바뀐 뒤에도 겉보기엔 정상인 채로 영원히 아무것도 못 잡는다.
    const result = parseTimeFragment(fixture('time-empty'));
    expect(result.kind).toBe('CONTRACT_BROKEN');
  });

  it('대기열 페이지를 회차 목록으로 오해하지 않는다', () => {
    const result = parseTimeFragment('<html><body>동시접속자가 많아 잠시 대기 중입니다.</body></html>');
    expect(result.kind).toBe('QUEUED');
  });

  it('회차는 있는데 날짜를 못 읽으면 계약 파손으로 본다', () => {
    // 그 회차만 조용히 버리면 있는 자리를 놓친다.
    const broken = '<div class="time-slots"><span>10:00</span></div>';
    const result = parseTimeFragment(broken);
    expect(result.kind).toBe('CONTRACT_BROKEN');
    if (result.kind !== 'CONTRACT_BROKEN') return;
    expect(result.reason).toContain('spectate_date');
  });
});
