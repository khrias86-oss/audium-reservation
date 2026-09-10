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
import { fetchOpenDates, fetchSlotsForDates } from './adapters/audeum/http-flow.js';
import { prepareBooking } from './booking/prepare.js';
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

/** 라벨 하나를 붙인다. 실패해도 감시를 멈추지 않는다 — 표시일 뿐이다. */
async function addLabel(issueNumber: number, label: string): Promise<boolean> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/labels`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ labels: [label] }),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}

const summary: string[] = [];
const say = (line: string) => { console.log(line); summary.push(line); };

async function main(): Promise<void> {
  say(`## 오디움 빈자리 확인 — ${new Date().toISOString()}`);
  say(gate.live
    ? '⚠️ **실제 예약 모드** — 자리를 찾으면 예약을 진행합니다'
    : gate.reason);

  // 라벨로 걸러 받지 않는다. 폰에서 낸 신청서에는 라벨이 붙지 않기 때문이다
  // (GitHub 모바일 웹이 `?labels=`를 조용히 버린다). 전부 받아 모양으로 판별한다.
  const issues = await gh('/issues?state=open&per_page=100');
  const { requests, problems } = parseWatchRequests(issues);

  for (const problem of problems) say(`- ⚠️ ${problem}`);

  if (requests.length === 0) {
    say('감시 중인 항목이 없습니다.');
    return;
  }
  say(`\n감시 중: ${requests.map((r) => `${r.date} ${r.time}`).join(', ')}`);

  // 라벨이 빠진 신청서에 뒤늦게 붙여 준다. 감시 자체는 라벨 없이도 되지만,
  // 라벨이 있어야 사용자가 "내가 감시 중인 목록"을 한 번에 볼 수 있다.
  for (const request of requests.filter((r) => r.missingLabel)) {
    const added = await addLabel(request.issueNumber, 'watch-request');
    say(`- #${request.issueNumber}: watch-request 라벨을 ${added ? '붙였습니다' : '붙이지 못했습니다'}`
      + ' (폰에서 신청하면 GitHub이 라벨을 빠뜨립니다 — 감시에는 영향 없습니다)');
  }

  // 사이트가 주는 날짜를 전부 훑지 않고, **신청한 날짜만** 물어본다.
  // 요청 수가 감시 항목 수에 비례해 늘어나지, 사이트 사정에 좌우되지 않는다.
  let dates = [...new Set(requests.map((r) => r.date))];

  // 그 중에서도 **예약이 열린 날짜만** 남긴다. 예약은 격주로 열리므로 달력상
  // 목·금·토라도 아직 안 열린 날이 대부분이고, 그런 날의 회차를 묻는 것은
  // 매번 헛도는 요청이다. 사이트가 열린 날짜를 직접 알려주므로 어림할 필요가 없다.
  const open = await fetchOpenDates('exhibition');
  if (open.kind === 'OK') {
    const openSet = new Set(open.dates.map((d) => d.date));
    const closed = dates.filter((d) => !openSet.has(d));
    dates = dates.filter((d) => openSet.has(d));

    say(`\n사이트가 연 날짜: ${open.dates.map((d) => d.date).join(', ') || '없음'}`);
    for (const d of closed) {
      // "자리 없음"이 아니다. 아직 예약이 시작되지 않았다는 뜻이고, 사용자가
      // 이 둘을 구분하지 못하면 잘못된 날짜를 계속 걸어둔 채 기다리게 된다.
      say(`- ⏳ ${d}: 아직 예약이 열리지 않았습니다 (전시 예약은 격주 화요일 14시 오픈)`);
    }
  } else {
    // 날짜 목록을 못 받았다고 감시를 멈추지는 않는다. 걸러내기는 최적화일 뿐이고,
    // 최적화가 실패했다고 본래 일까지 못 하게 되면 안 된다.
    const why = open.kind === 'QUEUED' ? open.message : open.reason;
    say(`\n열린 날짜 목록을 못 받아 신청한 날짜를 그대로 확인합니다 (${why})`);
  }

  if (dates.length === 0) {
    say('\n확인할 날짜가 없습니다.');
    return;
  }
  const { result, perDate, elapsedMs } = await fetchSlotsForDates(dates, 'exhibition');
  say(`요청 ${dates.length}건 / ${(elapsedMs / 1000).toFixed(1)}초`);

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

  for (const [date, one] of perDate) {
    if (one.kind === 'OK') continue;
    // 전체는 성공했지만 이 날짜만 못 봤다는 뜻이다. 묻히지 않게 남긴다.
    say(`- ⚠️ ${date}: ${one.kind === 'QUEUED' ? one.message : one.reason}`);
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

    // 목록에서 여석으로 보였다고 예약이 되는 것은 아니다. 사이트 자신도 회차를
    // 고른 뒤 서버에 매진을 한 번 더 물어본다(`rsMsg.message == "soldout"`).
    // 재확인 비용은 1초이고, 그 값으로 사용자를 뛰게 만들어 놓고 배신하는
    // 알림을 막는다.
    const prepared = await prepareBooking(slot, 'exhibition');

    if (prepared.kind === 'GONE') {
      say(`\n- ${request.date} ${request.time}: 목록엔 있었지만 ${prepared.reason} — 알리지 않습니다`);
      continue;
    }
    matched++;

    const seq = prepared.kind === 'READY' ? prepared.plan.reserveSeq : '';
    say(`\n🎉 **${request.date} ${request.time} 자리가 났습니다** (신청 #${request.issueNumber})`
      + (prepared.kind === 'UNVERIFIED' ? ` — 재확인은 못 했습니다: ${prepared.reason}` : '')
      + (seq ? ` [회차 ${seq}]` : ''));

    await notifier.send({
      kind: 'NEEDS_ACTION',
      watch: {
        id: `${request.date}T${request.time}`, userId: owner!,
        date: request.date, time: request.time, priority: request.priority, state: 'DETECTED',
      },
      slot,
      reason: prepared.kind === 'UNVERIFIED'
        ? `여석을 봤지만 재확인은 하지 못했습니다: ${prepared.reason}`
        : '방금 다시 확인했고, 자리가 남아 있습니다.',
      resumeUrl: slot.bookUrl,
      reserveSeq: seq || null,
    });
  }

  if (matched === 0) say('\n신청한 날짜·회차에는 아직 자리가 없습니다.');
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
