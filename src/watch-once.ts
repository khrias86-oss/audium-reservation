/**
 * 감시 1회 실행 — GitHub Actions가 10분마다 이 파일을 실행한다.
 *
 * 하는 일:
 *   1. 감시 요청(이슈)을 읽는다
 *   2. 오디움에서 회차 상황을 확인한다
 *   3. 요청한 날짜/회차에 자리가 있으면 알린다
 *
 * 실제 예약은 `DRY_RUN=false`가 명시적으로 설정될 때만 한다. 기본값은 확인만이다.
 */
import { chromium } from 'playwright';
import { fetchSlotsViaBrowser } from './adapters/audeum/browser-flow.js';
import { parseWatchRequests } from './config/watch-requests.js';
import { createGitHubIssueNotifier } from './notify/github-issue.js';
import { slotKey } from './core/types.js';
import { decideBookingMode } from './booking-gate.js';

const token = process.env['GITHUB_TOKEN'];
const repository = process.env['GITHUB_REPOSITORY'];
// 예약 모드 판정은 관문에 맡긴다. 워크플로 표현식 하나로 안전장치가 뒤집히는 일이
// 첫 시험 운전에서 실제로 일어났기 때문에, 프로그램 안에도 방어선을 둔다.
const gate = decideBookingMode({
  dryRunEnv: process.env['DRY_RUN'],
  applicantName: process.env['APPLICANT_NAME'],
  applicantEmail: process.env['APPLICANT_EMAIL'],
});
const liveBooking = gate.live;

if (!token || !repository) {
  console.error('GITHUB_TOKEN과 GITHUB_REPOSITORY가 필요합니다.');
  process.exit(1);
}

const [owner, repo] = repository.split('/');
if (!owner || !repo) {
  console.error(`GITHUB_REPOSITORY 형식이 올바르지 않습니다: ${repository}`);
  process.exit(1);
}

const gh = async (path: string) => {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`GitHub API 실패 (${res.status}): ${path}`);
  return res.json() as Promise<unknown>;
};

const summary: string[] = [];
const say = (line: string) => { console.log(line); summary.push(line); };

async function main(): Promise<void> {
  say(`## 오디움 빈자리 확인 — ${new Date().toISOString()}`);
  say(liveBooking
    ? '⚠️ **실제 예약 모드** — 자리를 찾으면 예약을 진행합니다'
    : `확인만 하는 모드 — ${gate.live ? '' : gate.reason}`);

  const issues = await gh('/issues?state=open&labels=watch-request&per_page=100');
  const { requests, problems } = parseWatchRequests(issues);

  for (const problem of problems) say(`- ⚠️ ${problem}`);

  if (requests.length === 0) {
    say('감시 중인 항목이 없습니다.');
    return;
  }
  say(`\n감시 중: ${requests.map((r) => `${r.date} ${r.time}`).join(', ')}`);

  const browser = await chromium.launch();
  try {
    const result = await fetchSlotsViaBrowser(browser, 'exhibition');

    if (result.kind === 'QUEUED') {
      // 대기열은 장애가 아니다. 이번 회차만 확인을 못 했을 뿐이므로 조용히 넘어간다.
      say(`\n대기열 상태입니다 — 이번 확인은 건너뜁니다. (${result.message})`);
      return;
    }

    if (result.kind === 'TRANSIENT_ERROR') {
      say(`\n일시적인 오류로 확인하지 못했습니다: ${result.reason}`);
      return;
    }

    if (result.kind === 'CONTRACT_BROKEN') {
      // 이건 조용히 넘어가면 안 된다. 사이트가 바뀌었는데 모르고 계속 "자리 없음"을
      // 반복하는 것이 이 시스템의 가장 위험한 실패 방식이다.
      say(`\n🚨 **사이트 구조가 바뀐 것으로 보입니다:** ${result.reason}`);
      const notifier = createGitHubIssueNotifier({ owner: owner!, repo: repo!, token: token! });
      await notifier.send({
        kind: 'SYSTEM_WARNING',
        reason: `빈자리를 확인할 수 없습니다. ${result.reason}\n\n확인이 멈춘 동안 빈자리를 놓치고 있을 수 있습니다.`,
      });
      process.exitCode = 1;
      return;
    }

    const openings = new Map(
      result.slots.filter((s) => s.status === 'AVAILABLE').map((s) => [slotKey(s), s]),
    );
    say(`\n확인한 회차 ${result.slots.length}개 중 여석 ${openings.size}개`);

    for (const slot of result.slots) {
      say(`- ${slot.date} ${slot.time} — ${slot.status === 'AVAILABLE' ? '✅ 여석' : '매진'}`);
    }

    const notifier = createGitHubIssueNotifier({ owner: owner!, repo: repo!, token: token! });
    let matched = 0;

    for (const request of requests) {
      const slot = openings.get(`${request.date}T${request.time}`);
      if (!slot) continue;
      matched++;

      say(`\n🎉 **${request.date} ${request.time} 자리가 났습니다** (신청 #${request.issueNumber})`);
      await notifier.send({
        kind: 'NEEDS_ACTION',
        watch: {
          id: `${request.date}T${request.time}`, userId: owner!,
          date: request.date, time: request.time, priority: request.priority, state: 'DETECTED',
        },
        slot,
        reason: liveBooking
          ? '자동 예약을 시도합니다.'
          : '지금은 확인만 하는 모드입니다. 아래 링크로 직접 예약하세요.',
        resumeUrl: slot.bookUrl,
      });
    }

    if (matched === 0) say('\n신청한 날짜·회차에는 아직 자리가 없습니다.');
  } finally {
    await browser.close().catch(() => { /* 정리 실패는 결과에 영향 없음 */ });
  }
}

main()
  .catch((error: unknown) => {
    say(`\n실행 중 오류: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(() => {
    const path = process.env['GITHUB_STEP_SUMMARY'];
    if (path) {
      void import('node:fs').then((fs) => fs.appendFileSync(path, summary.join('\n') + '\n'));
    }
  });
