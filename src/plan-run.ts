/**
 * 워크플로 맨 앞에서 이번 실행의 계획을 정한다 (`src/core/run-plan.ts`).
 *
 * 예전에는 bash에서 `issues?per_page=100 | grep -c '관람 희망 날짜'`로 신청을 셌다.
 * 그 방식은 (1) 100건 넘는 이슈에서 신청을 놓쳤고, (2) 이미 지난 신청도 세어서
 * 감시 루프가 끝없이 이어졌다. 이제 감시와 똑같은 규칙(`parseWatchRequests`,
 * `isExpired`)으로 센다.
 *
 * `--count`: 지나지 않은 신청 수만 출력한다 (다음 실행을 이어 걸지 정할 때 쓴다).
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { isExpired, parseWatchRequests } from './config/watch-requests.js';
import { listOpenIssues } from './github/issues.js';
import { planRun } from './core/run-plan.js';

const token = process.env['GITHUB_TOKEN'];
const [owner, repo] = (process.env['GITHUB_REPOSITORY'] ?? '').split('/');
if (!token || !owner || !repo) {
  console.error('GITHUB_TOKEN과 GITHUB_REPOSITORY가 필요합니다.');
  process.exit(1);
}

const now = new Date();
const { requests } = parseWatchRequests(await listOpenIssues({ owner, repo, token }));
const active = requests.filter((r) => !isExpired(r, now)).length;

if (process.argv.includes('--count')) {
  console.log(active);
  process.exit(0);
}

const guesses: string[] = [];
const snapshotPath = 'docs-site/data/availability.json';
if (existsSync(snapshotPath)) {
  try {
    const snap = JSON.parse(readFileSync(snapshotPath, 'utf8')) as { products?: Array<{ nextOpenGuess?: string | null }> };
    for (const p of snap.products ?? []) if (p.nextOpenGuess) guesses.push(p.nextOpenGuess);
  } catch {
    // 스냅샷이 깨졌으면 추정 없이 간다 — 화요일 기본 시간대로 떨어진다.
  }
}

const requested = Number.parseInt(process.env['LOOP_MINUTES'] ?? '', 10);
const plan = planRun({
  now, activeRequests: active, openingGuesses: guesses,
  ...(Number.isFinite(requested) ? { requestedLoopMinutes: requested } : {}),
});

console.log(`감시 신청 ${active}건 (지난 신청 ${requests.length - active}건 제외)`);
console.log(`오픈 예상: ${guesses.join(', ') || '모름 — 화요일 13~15시를 본다'}`);
console.log(`계획: 신청 확인 ${plan.watch ? '함' : '안 함'}, 오픈 시간대 ${plan.openingWindow ? '맞음' : '아님'}, 루프 ${plan.loopMinutes}분`);

const out = process.env['GITHUB_OUTPUT'];
if (out) {
  appendFileSync(out, [
    `count=${active}`,
    `watch=${plan.watch}`,
    `window=${plan.openingWindow}`,
    `loop=${plan.loopMinutes}`,
    `run=${plan.watch || plan.openingWindow}`,
  ].join('\n') + '\n');
}
