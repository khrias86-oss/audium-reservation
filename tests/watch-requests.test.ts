import { describe, expect, it } from 'vitest';
import { parseWatchRequests } from '../src/config/watch-requests.js';

/** GitHub 이슈 양식이 실제로 저장하는 본문 형태다. */
const formBody = (date: string, time: string, product = '전시 도슨트 관람', priority = '1 (가장 원함)') =>
  `### 관람 희망 날짜\n\n${date}\n\n### 희망 회차\n\n${time}\n\n### 관람 종류\n\n${product}\n\n### 우선순위\n\n${priority}\n`;

const issue = (number: number, body: string | null, state = 'open') =>
  ({ number, title: '[감시] 테스트', body, state });

describe('이슈 양식 읽기', () => {
  it('양식에서 날짜와 회차를 꺼낸다', () => {
    const { requests } = parseWatchRequests([issue(1, formBody('2026-03-14', '10:00'))]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ date: '2026-03-14', time: '10:00', issueNumber: 1 });
  });

  it('관람 종류를 구분한다', () => {
    const { requests } = parseWatchRequests([
      issue(1, formBody('2026-03-14', '10:00', '전시 도슨트 관람')),
      issue(2, formBody('2026-03-14', '11:00', '렉처 프로그램')),
    ]);
    expect(requests.find((r) => r.issueNumber === 1)?.product).toBe('exhibition');
    expect(requests.find((r) => r.issueNumber === 2)?.product).toBe('lecture');
  });

  it('우선순위 숫자대로 정렬한다', () => {
    // 1인 1매라 순서가 곧 어느 것을 잡느냐를 결정한다.
    const { requests } = parseWatchRequests([
      issue(1, formBody('2026-03-14', '15:30', '전시 도슨트 관람', '3')),
      issue(2, formBody('2026-03-14', '10:00', '전시 도슨트 관람', '1 (가장 원함)')),
    ]);
    expect(requests.map((r) => r.issueNumber)).toEqual([2, 1]);
  });

  it('닫힌 이슈는 감시하지 않는다 — 이슈를 닫는 것이 감시 해제다', () => {
    const { requests } = parseWatchRequests([issue(1, formBody('2026-03-14', '10:00'), 'closed')]);
    expect(requests).toHaveLength(0);
  });
});

describe('잘못된 이슈 처리', () => {
  it('형식이 틀린 이슈 하나가 나머지를 멈추지 않는다', () => {
    // 사람이 손으로 쓴 이슈 하나 때문에 모든 감시가 멈추면 안 된다.
    const { requests, problems } = parseWatchRequests([
      issue(1, '그냥 자유롭게 쓴 글입니다'),
      issue(2, formBody('2026-03-14', '10:00')),
    ]);
    expect(requests).toHaveLength(1);
    expect(problems).toHaveLength(1);
  });

  it('무엇이 왜 잘못됐는지 이슈 번호와 함께 알려준다', () => {
    const { problems } = parseWatchRequests([issue(7, formBody('3월 14일', '10:00'))]);
    expect(problems[0]).toContain('#7');
    expect(problems[0]).toContain('3월 14일');
    expect(problems[0]).toContain('2026-03-14');
  });

  it('회차 형식 오류도 잡는다', () => {
    const { problems } = parseWatchRequests([issue(8, formBody('2026-03-14', '오전 10시'))]);
    expect(problems[0]).toContain('회차 형식');
  });

  it('본문이 비어 있어도 죽지 않는다', () => {
    const { requests, problems } = parseWatchRequests([issue(9, null)]);
    expect(requests).toHaveLength(0);
    expect(problems[0]).toContain('#9');
  });

  it('이슈 목록 자체가 이상하면 빈 결과와 함께 알린다', () => {
    const { requests, problems } = parseWatchRequests({ error: 'not an array' });
    expect(requests).toHaveLength(0);
    expect(problems).toHaveLength(1);
  });
});
