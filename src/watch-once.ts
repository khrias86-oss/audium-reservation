/**
 * 감시 1회 실행 — GitHub Actions가 5분마다 이 파일을 실행한다.
 *
 *   1. 알림 서버(Apps Script)에 "지금 볼 회차"를 묻는다 — 메일 주소는 받지 않는다
 *   2. 오디움에서 그 회차들을 확인한다 — 전시와 렉처는 완전히 따로
 *   3. 본 결과를 알림 서버에 넘긴다 — 누구에게 언제 보낼지는 서버가 정한다
 *
 * GitHub 이슈는 이제 **주인에게 가는 시스템 경고**(사이트 구조 변경, 알림 서버 장애)에만
 * 쓴다. 감시 신청은 공개 페이지 → 알림 서버로 간다. 신청자는 GitHub을 몰라도 된다.
 *
 * 이 경로는 예약을 제출하지 않는다. 오디움 예약은 휴대폰 인증과 Turnstile이 막고
 * 있고(`docs/auto-booking.md`), 그것을 뚫지 않는다.
 */
import { fetchOpenDates, fetchSlotsForDates } from './adapters/audeum/http-flow.js';
import { ACTIVE_PRODUCTS } from './adapters/audeum/contract.js';
import { prepareBooking } from './booking/prepare.js';
import { alertServerFromEnv, type Observation } from './notify/alert-server.js';
import { createGitHubIssueNotifier } from './notify/github-issue.js';
import type { Notification, Notifier } from './notify/types.js';
import { observeProduct } from './watch/observe.js';

const summary: string[] = [];
const say = (line: string) => { console.log(line); summary.push(line); };

const PRODUCT_LABEL = { exhibition: '전시', lecture: '렉처' } as const;

/** 주인에게 가는 시스템 경고. 토큰이 없으면(로컬 실행) 로그로만 남긴다. */
function ownerNotifier(): Notifier {
  const token = process.env['GITHUB_TOKEN'];
  const [owner, repo] = (process.env['GITHUB_REPOSITORY'] ?? '').split('/');
  if (!token || !owner || !repo) {
    return { async send(n: Notification) { say(`(경고 이슈 생략 — GITHUB_TOKEN 없음) ${n.kind}`); return false; } };
  }
  return createGitHubIssueNotifier({ owner, repo, token });
}

/** 경고·복구 알림이 실패해도 감시는 계속한다. 표시일 뿐이다. */
async function tell(notifier: Notifier, n: Notification): Promise<void> {
  try {
    await notifier.send(n);
  } catch (error) {
    say(`- ⚠️ 경고 이슈 처리 실패: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main(): Promise<void> {
  say(`## 오디움 빈자리 확인 — ${new Date().toISOString()}`);
  const owner = ownerNotifier();

  const server = alertServerFromEnv(process.env);
  if (!server) {
    say('알림 서버가 아직 설정되지 않았습니다 (MAILER_URL 변수, MAILER_KEY 시크릿). `mailer/설정방법.md`를 보세요.');
    return;
  }

  let wants;
  try {
    wants = await server.wants();
  } catch (error) {
    // 알림 서버에 닿지 못하면 무엇을 볼지조차 모른다. 조용히 넘기면 감시가 죽은 줄 모른다.
    const why = error instanceof Error ? error.message : String(error);
    say(`🚨 알림 서버에 닿지 못했습니다: ${why}`);
    await tell(owner, { kind: 'SYSTEM_WARNING', key: 'alert-server', reason: `알림 서버(Apps Script)에 닿지 못했습니다.\n\n${why}` });
    process.exitCode = 1;
    return;
  }
  await tell(owner, { kind: 'SYSTEM_RECOVERED', key: 'alert-server', note: `알림 서버가 다시 응답합니다 (${new Date().toISOString()}).` });

  say(`볼 회차 ${wants.slots.length}개: ${wants.slots.map((s) => `${PRODUCT_LABEL[s.product]} ${s.date} ${s.time}`).join(', ') || '없음'}`);
  if (wants.slots.length === 0) return;

  const observations: Observation[] = [];
  const deps = { fetchOpenDates, fetchSlotsForDates, prepareBooking };

  for (const product of ACTIVE_PRODUCTS) {
    const wanted = wants.slots.filter((s) => s.product === product);
    if (wanted.length === 0) continue; // 신청이 없는 상품은 사이트에 묻지 않는다
    const label = PRODUCT_LABEL[product];
    say(`\n### ${label}`);
    const check = await observeProduct(product, wanted, deps, say);
    observations.push(...check.observations);

    if (check.kind === 'BROKEN') {
      // 사이트가 바뀌었는데 모르고 "자리 없음"을 반복하는 것이 이 시스템의 가장 위험한
      // 실패다. 이 상품만 경고하고(같은 문제는 이슈 하나로 묶인다), 다른 상품은 계속 본다.
      say(`🚨 **${label} 사이트 구조가 바뀐 것으로 보입니다:** ${check.reason}`);
      if (check.raw !== undefined) say(`받은 조각(앞부분): \`${String(check.raw).slice(0, 300).replace(/\s+/g, ' ')}\``);
      await tell(owner, {
        kind: 'SYSTEM_WARNING', key: `contract:${product}`,
        reason: `${label} 빈자리를 확인할 수 없습니다. ${check.reason}\n\n확인이 멈춘 동안 빈자리를 놓치고 있을 수 있습니다.`,
      });
      process.exitCode = 1;
    } else if (check.kind === 'SKIPPED') {
      say(`${label} — 이번 확인은 건너뜁니다 (${check.reason})`);
    } else {
      await tell(owner, { kind: 'SYSTEM_RECOVERED', key: `contract:${product}`, note: `${label} 회차를 다시 정상적으로 읽고 있습니다 (${new Date().toISOString()}).` });
    }
  }

  for (const s of wants.slots.filter((x) => !ACTIVE_PRODUCTS.includes(x.product))) {
    say(`- ${PRODUCT_LABEL[s.product]} ${s.date} ${s.time}: 이 프로그램 감시는 꺼져 있습니다`);
  }

  const found = observations.filter((o) => o.available).length;
  say(`\n확인 ${observations.length}개 회차 중 자리 있음 ${found}개`);

  try {
    const d = await server.report(observations);
    say(`알림 서버: 이번에 알림 ${d.alerted}건 (메일 ${d.mailed}, 푸시 ${d.pushed}, 실패 ${d.failed})`);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    say(`🚨 결과를 알림 서버에 넘기지 못했습니다: ${why}`);
    await tell(owner, { kind: 'SYSTEM_WARNING', key: 'alert-server', reason: `확인 결과를 알림 서버에 넘기지 못했습니다 — 신청자에게 알림이 가지 않습니다.\n\n${why}` });
    process.exitCode = 1;
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
