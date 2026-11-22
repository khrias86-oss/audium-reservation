/**
 * 당월 가용성 스냅샷 — GitHub Actions가 매 틱마다 돌려서 공개 페이지에 반영한다.
 *
 * 감시 요청이 하나도 없어도 이건 돈다. 사용자가 "무엇을 감시할지 고르는 화면"
 * 자체가 이 스냅샷으로 그려지기 때문이다 — 감시를 시작하기 전에 먼저 지금
 * 상황을 보여줘야 하므로, 감시 요청의 존재 여부와 이 스크립트는 무관하다.
 *
 * 결과는 `docs-site/data/availability.json`에 커밋된다. `docs-site/`는 GitHub
 * Pages가 그대로 서빙하므로, 프론트엔드는 별도 서버나 인증 없이 같은 출처
 * (same-origin)로 이 파일을 그냥 fetch하면 된다 — CORS도, 토큰도 필요 없다.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fetchOpenDates, fetchSlotsForDates } from './adapters/audeum/http-flow.js';
import { ACTIVE_PRODUCTS } from './adapters/audeum/contract.js';
import { buildProductSnapshot, newlyOpenedDates, wrapSnapshot, toKstDateString } from './adapters/audeum/build-snapshot.js';
import type { FullSnapshot, ProductSnapshot } from './adapters/audeum/build-snapshot.js';
import { createGitHubIssueNotifier } from './notify/github-issue.js';
import { createFamilyNotifier, familyConfigFromEnv, fanOut } from './notify/family.js';
import type { Notification } from './notify/types.js';
import type { Slot } from './core/types.js';

const OUT_PATH = 'docs-site/data/availability.json';

/** 한 프로그램의 스냅샷을 실제로 조회해 만든다. 실패해도 예외를 던지지 않는다. */
async function snapshotFor(product: 'exhibition' | 'lecture', today: string): Promise<ProductSnapshot> {
  const open = await fetchOpenDates(product);

  if (open.kind !== 'OK') {
    // 열린 날짜조차 못 받았다. 빈 스냅샷보다는 "지금 이 페이지가 낡았을 수
    // 있다"는 신호가 낫지만, 스키마를 어지럽히지 않기 위해 빈 목록으로
    // 처리하고 generatedAt으로 낡음을 드러낸다 (호출부가 갱신 시각을 본다).
    const why = open.kind === 'QUEUED' ? open.message : open.reason;
    console.error(`[${product}] 날짜 목록을 못 받았습니다: ${why}`);
    // 예전에는 빈 목록으로 그려서 실패가 "아직 안 열림"으로 보였다 (렉처가 두 달간 그랬다).
    return buildProductSnapshot(product, today, [], new Map(), { error: why });
  }

  const { result, perDate } = await fetchSlotsForDates(open.dates.map((d) => d.date), product);
  if (result.kind === 'CONTRACT_BROKEN') {
    // 계약이 깨졌다는 것은 사이트가 개편됐다는 뜻이다. 조용히 넘기면 페이지가
    // 계속 "매진"만 보여주며 사실은 정보가 없다는 것을 숨기게 된다.
    console.error(`[${product}] 계약 파손: ${result.reason}`);
  }

  const slotsByDate = new Map<string, readonly Slot[]>();
  for (const [date, r] of perDate) {
    if (r.kind === 'OK') slotsByDate.set(date, r.slots);
    // QUEUED/TRANSIENT_ERROR/CONTRACT_BROKEN인 날짜는 맵에서 빠진다 —
    // buildProductSnapshot이 이걸 "아직 확인 못 함"으로 안전하게 NOT_OPEN 취급한다.
  }

  return buildProductSnapshot(product, today, open.dates, slotsByDate);
}

/**
 * 파일이 바뀌었을 때만 커밋한다. 매번 커밋하면 히스토리가 늘어난다.
 *
 * 커밋 메시지에 `[skip ci]`를 넣지 않는다. 이 커밋이 `docs-site/data/`를
 * 건드리므로 `pages.yml`의 push 트리거가 새 데이터를 배포에 반영해야 하고,
 * `[skip ci]`는 그 배포까지 막아버린다.
 */
function commitIfChanged(path: string): void {
  const status = execFileSync('git', ['status', '--porcelain', '--', path], { encoding: 'utf8' });
  if (status.trim() === '') {
    console.log('스냅샷 내용이 그대로라 커밋하지 않습니다.');
    return;
  }

  execFileSync('git', ['config', 'user.name', 'audeum-watch-bot']);
  execFileSync('git', ['config', 'user.email', 'actions@users.noreply.github.com']);
  execFileSync('git', ['add', path]);
  execFileSync('git', ['commit', '-m', '자동: 당월 가용성 스냅샷 갱신']);

  // 감시 루프가 105분 동안 도는 사이 다른 워크플로가 같은 브랜치를 밀 수 있다.
  // rebase 후 재시도 한 번으로 대부분의 충돌을 흡수한다 — 그래도 실패하면
  // 이번 틱만 건너뛴다. 스냅샷 하나 놓치는 것은 다음 틱(5분 뒤)이 메운다.
  try {
    execFileSync('git', ['pull', '--rebase', 'origin', 'main']);
    execFileSync('git', ['push', 'origin', 'HEAD:main']);
    console.log('스냅샷을 커밋했습니다.');
  } catch (error) {
    console.error('스냅샷 푸시에 실패했습니다 — 다음 틱에서 다시 시도합니다.',
      error instanceof Error ? error.message : String(error));
  }
}

/**
 * 직전 스냅샷과 비교해 알릴 것을 고른다 — 새로 열린 날짜, 곧 열릴 것 같은 오픈.
 *
 * 오픈 예고는 예상 시각 90분 전부터 그 시각까지만 보낸다. 같은 날 두 번 보내지
 * 않는 것은 이슈 라벨(`opening-soon:날짜`)이 맡는다.
 */
export function notificationsFor(previous: FullSnapshot | null, next: FullSnapshot, now: Date): Notification[] {
  const out: Notification[] = [];
  for (const product of next.products) {
    const before = previous?.products.find((p) => p.product === product.product);
    // 예전 스키마(한 달짜리)의 스냅샷도 날짜별 상태는 같으므로 그대로 비교한다.
    const opened = newlyOpenedDates(before, product);
    if (opened.length > 0) out.push({ kind: 'OPENED', product: product.product, dates: opened });

    const guess = product.nextOpenGuess;
    if (guess) {
      const at = Date.parse(`${guess.slice(0, 19)}+09:00`);
      const t = now.getTime();
      if (at - 90 * 60_000 <= t && t < at) out.push({ kind: 'OPENING_SOON', product: product.product, at: guess });
    }
  }
  return out;
}

async function notify(list: readonly Notification[]): Promise<void> {
  if (list.length === 0) return;
  const token = process.env['GITHUB_TOKEN'];
  const [owner, repo] = (process.env['GITHUB_REPOSITORY'] ?? '').split('/');
  if (!token || !owner || !repo) {
    console.log(`알릴 것이 ${list.length}건 있지만 GITHUB_TOKEN이 없어 보내지 않습니다 (로컬 실행).`);
    return;
  }
  const log = (line: string) => console.log(line);
  const notifier = fanOut(
    createGitHubIssueNotifier({ owner, repo, token }),
    [createFamilyNotifier(familyConfigFromEnv(process.env, log))],
    log,
  );
  for (const n of list) {
    try {
      const sent = await notifier.send(n);
      console.log(`${n.kind}: ${sent === false ? '이미 알림 — 건너뜀' : '알림 보냄'}`);
    } catch (error) {
      // 알림 실패가 스냅샷 커밋을 막으면 안 된다. 달력은 그것대로 갱신돼야 한다.
      console.error(`${n.kind} 알림 실패:`, error instanceof Error ? error.message : String(error));
    }
  }
}

export async function main(): Promise<void> {
  const now = new Date();
  const today = toKstDateString(now);
  const products = await Promise.all(ACTIVE_PRODUCTS.map((product) => snapshotFor(product, today)));

  const snapshot = wrapSnapshot(now, products);
  const json = JSON.stringify(snapshot, null, 2) + '\n';

  mkdirSync('docs-site/data', { recursive: true });

  const previousText = existsSync(OUT_PATH) ? readFileSync(OUT_PATH, 'utf8') : null;
  let previous: FullSnapshot | null = null;
  try {
    previous = previousText ? (JSON.parse(previousText) as FullSnapshot) : null;
  } catch {
    previous = null; // 깨진 파일과 비교해 거짓 "오픈" 알림을 내느니 이번엔 비교하지 않는다.
  }

  // 내용이 진짜 바뀌었는지는 generatedAt을 뺀 내용으로 판단한다. generatedAt은
  // 매번 바뀌므로 그것만으로 커밋하면 히스토리가 쓸모없이 늘어난다.
  const withoutStamp = (text: string) => text.replace(/"generatedAt":\s*"[^"]*"/, '');
  if (previousText !== null && withoutStamp(previousText) === withoutStamp(json)) {
    console.log('가용성에 실질적인 변화가 없어 파일을 갱신하지 않습니다.');
  } else {
    writeFileSync(OUT_PATH, json);
    commitIfChanged(OUT_PATH);
  }

  await notify(notificationsFor(previous, snapshot, now));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error('스냅샷 생성 중 오류:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
