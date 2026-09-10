import { z } from 'zod';

/**
 * 감시 요청을 GitHub 이슈에서 읽어낸다.
 *
 * 사용자는 폰에서 이슈 양식(`.github/ISSUE_TEMPLATE/watch.yml`)을 작성한다.
 * GitHub은 그 양식을 마크다운 본문으로 저장하는데, 형태가 이렇다:
 *
 *   ### 관람 희망 날짜
 *
 *   2026-03-14
 *
 *   ### 희망 회차
 *
 *   10:00
 *
 * 파일이 아니라 이슈를 쓰는 이유: 폰에서 JSON을 편집하는 것보다 양식을 채우는 편이
 * 훨씬 쉽고, 이슈를 닫는 것만으로 감시를 끌 수 있으며, 알림도 같은 이슈에 달린다.
 */

const Issue = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.string(),
});

export interface WatchRequest {
  readonly issueNumber: number;
  readonly date: string;
  readonly time: string;
  readonly product: 'exhibition' | 'lecture';
  readonly priority: number;
}

/** 이슈 본문에서 `### 제목` 다음에 오는 값을 꺼낸다. */
function fieldValue(body: string, heading: string): string | null {
  const pattern = new RegExp(`###\\s*${heading}\\s*\\n+([^\\n#]+)`, 'i');
  const match = body.match(pattern);
  const value = match?.[1]?.trim();
  return value && value !== '_No response_' ? value : null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * 열린 이슈 목록을 감시 요청으로 변환한다.
 *
 * 형식이 잘못된 이슈는 **전체를 실패시키지 않고 건너뛴다.** 사람이 손으로 쓴
 * 이슈 하나 때문에 나머지 감시가 멈추면 안 된다. 대신 무엇을 왜 건너뛰었는지
 * 돌려주어 사용자가 고칠 수 있게 한다.
 */
export function parseWatchRequests(
  rawIssues: unknown,
): { requests: readonly WatchRequest[]; problems: readonly string[] } {
  const issues = z.array(Issue).safeParse(rawIssues);
  if (!issues.success) {
    return { requests: [], problems: ['이슈 목록을 읽지 못했습니다'] };
  }

  const requests: WatchRequest[] = [];
  const problems: string[] = [];

  for (const issue of issues.data) {
    if (issue.state !== 'open') continue;

    const body = issue.body ?? '';
    const date = fieldValue(body, '관람 희망 날짜');
    const time = fieldValue(body, '희망 회차');

    if (!date || !time) {
      problems.push(`#${issue.number} — 날짜나 회차를 읽지 못했습니다 (양식으로 다시 등록해 주세요)`);
      continue;
    }
    if (!DATE.test(date)) {
      problems.push(`#${issue.number} — 날짜 형식이 잘못됐습니다: "${date}" (예: 2026-03-14)`);
      continue;
    }
    if (!TIME.test(time)) {
      problems.push(`#${issue.number} — 회차 형식이 잘못됐습니다: "${time}" (예: 10:00)`);
      continue;
    }

    const productText = fieldValue(body, '관람 종류') ?? '';
    const priorityText = fieldValue(body, '우선순위') ?? '';

    requests.push({
      issueNumber: issue.number,
      date,
      time,
      product: productText.includes('렉처') ? 'lecture' : 'exhibition',
      // "1 (가장 원함)" 같은 표기에서 앞의 숫자만 쓴다. 못 읽으면 뒤로 미룬다.
      priority: Number.parseInt(priorityText, 10) || 99,
    });
  }

  // 우선순위가 낮은 숫자부터. 1인 1매이므로 순서가 곧 어느 것을 잡느냐를 결정한다.
  requests.sort((a, b) => a.priority - b.priority);

  return { requests, problems };
}
