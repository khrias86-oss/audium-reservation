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

describe('라벨 없이 낸 신청서', () => {
  // 실제로 일어난 일이다. 사용자가 폰에서 신청서를 냈는데 라벨이 붙지 않았고,
  // 시스템은 그 신청을 영원히 못 봤다. 제목과 본문은 정상이라 사용자 눈에는
  // 아무 문제가 없어 보였다 — 가장 나쁜 종류의 실패다.
  const phoneIssue = {
    number: 6,
    title: '[감시] 2026-09-19 13:30',
    body: '### 관람 희망 날짜\n\n2026-09-19\n\n### 희망 회차\n\n13:30\n\n### 관람 종류\n\n전시 도슨트\n\n### 우선순위\n\n1',
    state: 'open',
  };

  it('라벨이 없어도 신청서로 인식한다', () => {
    const { requests } = parseWatchRequests([phoneIssue]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.date).toBe('2026-09-19');
    expect(requests[0]?.time).toBe('13:30');
  });

  it('라벨이 빠졌다는 사실을 표시해 나중에 붙일 수 있게 한다', () => {
    const { requests } = parseWatchRequests([phoneIssue]);
    expect(requests[0]?.missingLabel).toBe(true);

    const labelled = parseWatchRequests([{ ...phoneIssue, labels: [{ name: 'watch-request' }] }]);
    expect(labelled.requests[0]?.missingLabel).toBe(false);
  });

  it('라벨이 문자열 배열로 와도 읽는다', () => {
    const { requests } = parseWatchRequests([{ ...phoneIssue, labels: ['watch-request'] }]);
    expect(requests[0]?.missingLabel).toBe(false);
  });

  it('우리가 만든 알림 이슈를 신청서로 오해하지 않는다', () => {
    // 알림에도 날짜·회차가 적혀 있으므로, 제외하지 않으면 스스로를 감시하게 된다.
    const alert = {
      number: 7,
      title: '🎉 오디움 자리 났습니다 — 2026-09-19 13:30 (지금 예약하세요)',
      body: '## 2026-09-19 (토) 13:30\n\n### 관람 희망 날짜\n\n2026-09-19',
      state: 'open',
      labels: [{ name: 'audeum-alert' }, { name: 'slot:2026-09-19T13:30' }],
    };
    const { requests } = parseWatchRequests([alert]);
    expect(requests).toHaveLength(0);
  });

  it('신청서와 무관한 이슈는 조용히 넘긴다 — 문제로 보고하지 않는다', () => {
    // 이제 모든 열린 이슈를 받아오므로, 관계없는 이슈까지 경고를 띄우면
    // 진짜 문제가 그 소음에 묻힌다.
    const { requests, problems } = parseWatchRequests([
      { number: 8, title: 'README 오타', body: '고쳐주세요', state: 'open' },
    ]);
    expect(requests).toHaveLength(0);
    expect(problems).toHaveLength(0);
  });

  it('신청서 모양인데 내용이 잘못됐으면 문제로 보고한다', () => {
    const { requests, problems } = parseWatchRequests([
      { number: 9, title: '[감시] 잘못됨', body: '### 관람 희망 날짜\n\n내일\n\n### 희망 회차\n\n오전', state: 'open' },
    ]);
    expect(requests).toHaveLength(0);
    expect(problems[0]).toContain('#9');
  });
});
