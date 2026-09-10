import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseDateFragment } from '../src/adapters/audeum/parse-date-fragment.js';

/** 15차 정찰에서 실제 사이트가 보낸 조각. */
const real = readFileSync(new URL('./fixtures/date-fragment.html', import.meta.url), 'utf8');

describe('예약이 열린 날짜 읽기', () => {
  it('사이트가 실어 보낸 목록을 그대로 읽는다', () => {
    const r = parseDateFragment(real);
    expect(r.kind).toBe('OK');
    if (r.kind !== 'OK') return;
    expect(r.dates.map((d) => d.date)).toEqual([
      '2026-09-10', '2026-09-11', '2026-09-12',
      '2026-09-17', '2026-09-18', '2026-09-19',
    ]);
    expect(r.dates[0]?.opensAt).toBe('2026-09-08T14:00:00');
  });

  it('실측 목록은 목·금·토 두 주치다 — 격주 오픈 규칙과 맞는다', () => {
    const r = parseDateFragment(real);
    if (r.kind !== 'OK') throw new Error('파싱 실패');
    const dows = r.dates.map((d) => new Date(`${d.date}T00:00:00Z`).getUTCDay());
    expect([...new Set(dows)].sort()).toEqual([4, 5, 6]);
  });

  it('예약이 다 찬 날은 빈 목록이 정상이다', () => {
    const r = parseDateFragment('<html><script>bookingDate.reserveList = [];</script></html>');
    expect(r.kind).toBe('OK');
    if (r.kind !== 'OK') return;
    expect(r.dates).toEqual([]);
  });

  it('목록 자체가 없으면 계약 파손이다 — 빈 목록으로 넘기면 감시가 조용히 멈춘다', () => {
    const r = parseDateFragment('<html><div>날짜 선택하기</div></html>');
    expect(r.kind).toBe('CONTRACT_BROKEN');
  });

  it('키 이름이 바뀌면 계약 파손이다 — 조용히 버리면 열린 날짜를 놓친다', () => {
    const r = parseDateFragment('<html><script>reserveList = [{"DATE":"2026-09-10"}];</script></html>');
    expect(r.kind).toBe('CONTRACT_BROKEN');
  });

  it('JSON이 깨져 있어도 예외를 던지지 않는다', () => {
    const r = parseDateFragment('<html><script>reserveList = [{"SPECTATE_DATE";};</script></html>');
    expect(r.kind).toBe('CONTRACT_BROKEN');
  });

  it('대기열은 계약 파손이 아니다', () => {
    const r = parseDateFragment('<html>동시접속자가 많아 잠시 대기 중입니다.</html>');
    expect(r.kind).toBe('QUEUED');
  });

  it('오픈 시각이 없어도 날짜는 살린다', () => {
    const r = parseDateFragment('<html><script>reserveList = [{"SPECTATE_DATE":"2026-10-01"}];</script></html>');
    expect(r.kind).toBe('OK');
    if (r.kind !== 'OK') return;
    expect(r.dates[0]).toEqual({ date: '2026-10-01', opensAt: null });
  });
});
