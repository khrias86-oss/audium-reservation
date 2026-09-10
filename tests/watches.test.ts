import { describe, expect, it } from 'vitest';
import { describeWatchFileError, parseWatchFile } from '../src/config/watches.js';

const TODAY = '2026-03-10';
const parse = (raw: unknown) => parseWatchFile(raw, 'u1', TODAY);

describe('감시 조건 파일 파싱', () => {
  it('기본 항목을 감시로 변환한다', () => {
    const { watches } = parse({ watches: [{ date: '2026-03-14', time: '10:00' }] });
    expect(watches).toHaveLength(1);
    expect(watches[0]).toMatchObject({
      date: '2026-03-14', time: '10:00', product: 'exhibition', state: 'WATCHING',
    });
  });

  it('product 기본값은 전시(도슨트)다', () => {
    // 사용자가 원하는 것이 도슨트 관람이므로 생략 시 그쪽이어야 한다.
    const { watches } = parse({ watches: [{ date: '2026-03-14', time: '10:00' }] });
    expect(watches[0]?.product).toBe('exhibition');
  });

  it('priority를 생략하면 파일에 적힌 순서를 쓴다', () => {
    const { watches } = parse({
      watches: [
        { date: '2026-03-14', time: '10:00' },
        { date: '2026-03-14', time: '11:00' },
      ],
    });
    expect(watches.map((w) => w.priority)).toEqual([0, 1]);
  });

  it('명시한 priority가 순서를 이긴다', () => {
    const { watches } = parse({
      watches: [
        { date: '2026-03-14', time: '10:00', priority: 5 },
        { date: '2026-03-14', time: '11:00', priority: 1 },
      ],
    });
    expect(watches.map((w) => w.priority)).toEqual([5, 1]);
  });
});

describe('지난 날짜와 중복', () => {
  it('지난 날짜는 오류가 아니라 건너뛴다', () => {
    // 관람을 마친 뒤 항목을 지우지 않는 것은 자연스럽다.
    // 그것 때문에 나머지 감시가 멈추면 안 된다.
    const { watches, skipped } = parse({
      watches: [
        { date: '2026-03-01', time: '10:00' },
        { date: '2026-03-14', time: '10:00' },
      ],
    });
    expect(watches).toHaveLength(1);
    expect(skipped[0]).toContain('이미 지난 날짜');
  });

  it('오늘 날짜는 건너뛰지 않는다 — 당일 오전에도 취소표가 난다', () => {
    const { watches } = parse({ watches: [{ date: TODAY, time: '15:30' }] });
    expect(watches).toHaveLength(1);
  });

  it('중복 항목은 건너뛰되 조용히 넘어가지 않는다', () => {
    const { watches, skipped } = parse({
      watches: [
        { date: '2026-03-14', time: '10:00' },
        { date: '2026-03-14', time: '10:00' },
      ],
    });
    expect(watches).toHaveLength(1);
    expect(skipped[0]).toContain('중복');
  });

  it('상품이 다르면 같은 날짜·시각이어도 중복이 아니다', () => {
    const { watches } = parse({
      watches: [
        { date: '2026-03-14', time: '10:00', product: 'exhibition' },
        { date: '2026-03-14', time: '10:00', product: 'lecture' },
      ],
    });
    expect(watches).toHaveLength(2);
  });
});

describe('입력 검증', () => {
  it('잘못된 날짜 형식을 거부한다', () => {
    expect(() => parse({ watches: [{ date: '3/14', time: '10:00' }] })).toThrow();
  });

  it('잘못된 회차 형식을 거부한다', () => {
    expect(() => parse({ watches: [{ date: '2026-03-14', time: '10시' }] })).toThrow();
  });

  it('알 수 없는 상품을 거부한다', () => {
    expect(() => parse({ watches: [{ date: '2026-03-14', time: '10:00', product: 'concert' }] })).toThrow();
  });

  it('감시 개수 상한이 있다', () => {
    const many = Array.from({ length: 21 }, (_, i) => ({
      date: `2026-04-${String(i + 1).padStart(2, '0')}`, time: '10:00',
    }));
    expect(() => parse({ watches: many })).toThrow(/최대 20건/);
  });
});

describe('오류 메시지', () => {
  it('몇 번째 항목의 어느 필드가 틀렸는지 알려준다', () => {
    // 폰에서 읽고 바로 고칠 수 있어야 한다. 경로만 나오면 쓸모가 없다.
    try {
      parse({ watches: [{ date: '2026-03-14', time: '10:00' }, { date: '엉망', time: '10:00' }] });
      expect.unreachable('검증이 통과해서는 안 된다');
    } catch (e) {
      const msg = describeWatchFileError(e);
      expect(msg).toContain('2번째 감시');
      expect(msg).toContain('date');
      expect(msg).toContain('YYYY-MM-DD');
    }
  });

  it('Zod 오류가 아닌 것도 사람이 읽을 수 있게 바꾼다', () => {
    expect(describeWatchFileError(new Error('파일 없음'))).toContain('파일 없음');
  });
});
