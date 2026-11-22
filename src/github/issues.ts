/**
 * 감시가 쓰는 GitHub 이슈 API 몇 가지.
 *
 * ## 왜 모든 페이지를 읽는가
 *
 * 예전에는 `per_page=100` 한 장만 읽었다. 2026-09-19에 경고 이슈가 99개 쌓이자
 * 진짜 감시 신청(#5, #6)이 가장 오래된 쪽이라 101·102번째로 밀려났고, 그 뒤로
 * 감시는 "신청 0건"이라고 보고했다. 경고가 신청을 가린 것이다.
 */
export interface GitHubRepo {
  readonly owner: string;
  readonly repo: string;
  readonly token: string;
  readonly apiBase?: string;
}

const headers = (token: string) => ({
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'content-type': 'application/json',
});

/** 열린 이슈 전부. 안전장치로 10페이지(1,000건)에서 멈춘다. */
export async function listOpenIssues(r: GitHubRepo, maxPages = 10): Promise<unknown[]> {
  const base = r.apiBase ?? 'https://api.github.com';
  const all: unknown[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await fetch(`${base}/repos/${r.owner}/${r.repo}/issues?state=open&per_page=100&page=${page}`, {
      headers: headers(r.token),
    });
    if (!res.ok) throw new Error(`이슈 목록 조회 실패 (HTTP ${res.status}, ${page}페이지)`);
    const batch = (await res.json()) as unknown[];
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

/** 댓글을 남기고 이슈를 닫는다. */
export async function closeWithComment(r: GitHubRepo, issueNumber: number, comment: string): Promise<void> {
  const base = `${r.apiBase ?? 'https://api.github.com'}/repos/${r.owner}/${r.repo}/issues/${issueNumber}`;
  const c = await fetch(`${base}/comments`, { method: 'POST', headers: headers(r.token), body: JSON.stringify({ body: comment }) });
  if (!c.ok) throw new Error(`#${issueNumber} 댓글 실패 (HTTP ${c.status})`);
  const p = await fetch(base, {
    method: 'PATCH', headers: headers(r.token), body: JSON.stringify({ state: 'closed', state_reason: 'completed' }),
  });
  if (!p.ok) throw new Error(`#${issueNumber} 닫기 실패 (HTTP ${p.status})`);
}
