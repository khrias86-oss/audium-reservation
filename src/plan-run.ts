/**
 * 워크플로 맨 앞에서 이번 실행의 계획을 정한다 (`src/core/run-plan.ts`).
 *
 * 볼 회차 수는 알림 서버에 묻는다 — 서버가 끝난 신청(회차 1시간 전)을 먼저 지우고
 * 남은 것만 주므로, 모든 신청이 끝나면 감시 루프가 저절로 멈춘다.
 *
 * `--count`: 볼 회차 수만 출력한다 (다음 실행을 이어 걸지 정할 때 쓴다).
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { alertServerFromEnv } from './notify/alert-server.js';
import { planRun } from './core/run-plan.js';

const now = new Date();
const server = alertServerFromEnv(process.env);

let active = 0;
let serverError: string | null = null;
if (server) {
  try {
    active = (await server.wants()).slots.length;
  } catch (error) {
    serverError = error instanceof Error ? error.message : String(error);
  }
}

if (process.argv.includes('--count')) {
  // 서버에 닿지 못하면 0 — 장애 중에 105분짜리 실행을 끝없이 이어 걸지 않는다.
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
const plan = serverError
  // 서버 장애: 한 번만 확인해서 watch-once가 주인에게 경고 이슈를 올리게 한다.
  ? { ...planRun({ now, activeRequests: 1, openingGuesses: guesses, requestedLoopMinutes: 0 }) }
  : planRun({
    now, activeRequests: active, openingGuesses: guesses,
    ...(Number.isFinite(requested) ? { requestedLoopMinutes: requested } : {}),
  });

if (!server) console.log('알림 서버 설정 전입니다 (MAILER_URL, MAILER_KEY) — 달력만 갱신합니다.');
if (serverError) console.log(`알림 서버에 닿지 못했습니다: ${serverError}`);
console.log(`볼 회차 ${active}개`);
console.log(`오픈 예상: ${guesses.join(', ') || '모름 — 화요일 13~15시를 본다'}`);
console.log(`계획: 회차 확인 ${plan.watch ? '함' : '안 함'}, 오픈 시간대 ${plan.openingWindow ? '맞음' : '아님'}, 루프 ${plan.loopMinutes}분`);

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
