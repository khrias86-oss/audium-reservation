/**
 * 3틱 시뮬레이터 — `PROMPT.md` §2.5의 "실제 실행 관찰"용.
 *
 * 픽스처를 주입해 폴링 루프를 돌리고 상태 전이를 눈으로 확인한다.
 * 단위 테스트가 각 함수를 따로 검증한다면, 이건 조합된 흐름을 검증한다.
 *
 *   npx tsx scripts/simulate.ts   (또는 node --experimental-strip-types)
 */
import { readFileSync } from 'node:fs';
import { selectClaimTarget, newlyAvailable } from '../src/core/matcher.js';
import { applyEvent, shouldPoll } from '../src/core/state-machine.js';
import { computePollInterval } from '../src/core/scheduler.js';
import { checkHeartbeat } from '../src/core/heartbeat.js';
import type { Slot, Watch } from '../src/core/types.js';

const load = (name: string): Slot[] =>
  JSON.parse(readFileSync(new URL(`../tests/fixtures/${name}.json`, import.meta.url), 'utf8'));

// 사용자가 대시보드에서 3/14 10:00(1순위)과 3/12 10:00(2순위)을 골랐다고 가정한다.
let watches: Watch[] = [
  { id: 'w-sat10', userId: 'u1', date: '2026-03-14', time: '10:00', priority: 0, state: 'WATCHING' },
  { id: 'w-thu10', userId: 'u1', date: '2026-03-12', time: '10:00', priority: 1, state: 'WATCHING' },
];

// 틱 1·2는 전 회차 매진, 틱 3에서 3/14 10:00에 취소표가 뜬다.
const ticks = ['synthetic-fully-sold-out', 'synthetic-fully-sold-out', 'synthetic-partially-sold'];

let previous: Slot[] = [];
let lastHeartbeat: Date | null = null;
const now = new Date('2026-03-10T00:00:00Z');

for (const [i, fixture] of ticks.entries()) {
  const tickTime = new Date(now.getTime() + i * 10 * 60_000);
  console.log(`\n━━━ TICK ${i + 1} (${fixture}) ━━━`);

  const active = watches.filter((w) => shouldPoll(w.state));
  if (active.length === 0) {
    console.log('  폴링할 감시 없음 — 루프 종료');
    break;
  }

  const hb = checkHeartbeat(lastHeartbeat, tickTime);
  console.log(`  하트비트: ${hb.message}`);

  const slots = load(fixture);
  lastHeartbeat = tickTime;

  const opened = newlyAvailable(previous, slots);
  console.log(`  새로 열린 슬롯: ${opened.length === 0 ? '없음' : opened.map((s) => `${s.date} ${s.time}`).join(', ')}`);
  previous = slots;

  for (const w of active) {
    const plan = computePollInterval(tickTime, w.date, { baseMinutes: 10, adaptive: true, jitterSeconds: 60 });
    console.log(`  [${w.id}] ${w.state} · 다음 확인 ${plan.intervalMinutes}분 후 (${plan.reason})`);
  }

  const target = selectClaimTarget(watches, slots);
  if (!target) continue;

  console.log(`  ▶ 여석 감지: ${target.slot.date} ${target.slot.time} (감시 ${target.watch.id}, 우선순위 ${target.watch.priority})`);

  const transition = (id: string, event: Parameters<typeof applyEvent>[1]) => {
    watches = watches.map((w) => {
      if (w.id !== id) return w;
      const r = applyEvent(w, event);
      if (r.changed) console.log(`     ${w.state} → ${r.watch.state}  (${event.type})`);
      else if (r.rejected) console.log(`     전이 거부: ${r.rejected}`);
      return r.watch;
    });
  };

  transition(target.watch.id, { type: 'SLOT_DETECTED' });
  transition(target.watch.id, { type: 'CLAIM_STARTED' });
  transition(target.watch.id, { type: 'CLAIM_SUCCEEDED' });

  // 1인 1매: 성공한 사용자의 나머지 감시를 전부 종료한다.
  for (const w of watches) {
    if (w.userId === target.watch.userId && w.id !== target.watch.id && shouldPoll(w.state)) {
      transition(w.id, { type: 'SUPERSEDED' });
    }
  }
}

console.log('\n━━━ 최종 상태 ━━━');
for (const w of watches) console.log(`  ${w.id.padEnd(10)} ${w.state}`);
