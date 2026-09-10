import {
  DEFAULT_CIRCUIT, isOpen, markAlerted, recordFailure, recordSuccess, tryReset,
} from '../core/circuit-breaker.js';
import { newlyAvailable, selectClaimTarget } from '../core/matcher.js';
import { applyEvent, shouldPoll } from '../core/state-machine.js';
import { daysUntil } from '../core/time.js';
import { slotKey, type Watch } from '../core/types.js';
import type { Applicant, SiteAdapter } from '../adapters/types.js';
import type { Notifier } from '../notify/types.js';
import type { Store } from '../store/types.js';

export interface TickDeps {
  readonly adapter: SiteAdapter;
  readonly store: Store;
  readonly notifier: Notifier;
  readonly applicant: Applicant;
  readonly now: () => Date;
}

export interface TickResult {
  readonly outcome:
    | 'POLLED'
    | 'QUEUED'
    | 'BOOKED'
    | 'NEEDS_HUMAN'
    | 'CIRCUIT_OPEN'
    | 'CONTRACT_BROKEN'
    | 'NOTHING_TO_WATCH';
  readonly log: readonly string[];
}

const MAX_CLAIM_RETRIES = 2;

/**
 * 폴링 1회. `PROMPT.md` §2.1의 파이프라인을 그대로 따른다:
 * fetch → parse → normalize → validate → diff → match → decide → act → persist → notify
 *
 * 이 함수는 부수효과를 전부 주입받는다. 그래서 실제 사이트도 DB도 메일도 없이 테스트된다.
 */
export async function runTick(deps: TickDeps): Promise<TickResult> {
  const { adapter, store, notifier, applicant } = deps;
  const now = deps.now();
  const log: string[] = [];

  // --- 만료 처리: 지난 회차는 더 볼 필요가 없다 ---
  const all = await store.listWatches();
  for (const w of all) {
    if ((shouldPoll(w.state) || w.state === 'CIRCUIT_OPEN') && daysUntil(now, w.date) < 0) {
      const r = applyEvent(w, { type: 'DATE_PASSED' });
      if (r.changed) {
        await store.saveWatch(r.watch);
        log.push(`[${w.id}] 관람일 경과 → EXPIRED`);
      }
    }
  }

  // --- 서킷 확인 ---
  //
  // 감시 상태를 거르기 **전에** 처리해야 한다. CIRCUIT_OPEN 상태의 감시는
  // shouldPoll이 false이므로, 활성 감시부터 걸러내면 회로를 닫을 기회가
  // 영영 오지 않아 시스템이 그대로 멈춰버린다.
  const before = await store.getCircuit();
  let circuit = tryReset(before, now);

  if (before.openedAt !== null && circuit.openedAt === null) {
    // 쿨다운이 끝났다. 회로 때문에 멈춰 있던 감시를 되살린다.
    for (const w of await store.listWatches()) {
      if (w.state === 'CIRCUIT_OPEN') {
        const r = applyEvent(w, { type: 'CIRCUIT_CLOSED' });
        if (r.changed) {
          await store.saveWatch(r.watch);
          log.push(`[${w.id}] 쿨다운 종료 → 감시 재개`);
        }
      }
    }
  }

  if (isOpen(circuit, now)) {
    await store.saveCircuit(circuit);
    return { outcome: 'CIRCUIT_OPEN', log: [...log, '서킷 개방 상태 — 이번 틱은 건너뜀'] };
  }
  await store.saveCircuit(circuit);

  const active = (await store.listWatches()).filter((w) => shouldPoll(w.state));
  if (active.length === 0) {
    return { outcome: 'NOTHING_TO_WATCH', log: [...log, '감시 중인 항목 없음'] };
  }

  // --- fetch + parse ---
  const month = now.toISOString().slice(0, 7);
  const result = await adapter.fetchSlots(month);

  // 하트비트는 조회 성공 여부와 무관하게 남긴다. "워커가 살아 있다"와
  // "조회가 성공했다"는 다른 신호이고, 둘을 섞으면 장애 원인을 못 가린다.
  await store.saveHeartbeat(now);

  // 대기열은 "자리가 없다"도 "우리가 깨졌다"도 아니다. 확인 자체를 못 한 상태다.
  // 스냅샷을 건드리지 않고 물러난다 — 대기열 응답으로 직전 관측을 덮으면
  // 다음 틱에서 없던 슬롯이 "새로 열렸다"고 잘못 잡힌다.
  if (result.kind === 'QUEUED') {
    return { outcome: 'QUEUED', log: [...log, `대기열: ${result.message} — 이번 틱은 확인하지 못했습니다`] };
  }

  if (result.kind === 'CONTRACT_BROKEN') {
    for (const w of active) {
      const r = applyEvent(w, { type: 'CONTRACT_DRIFT', reason: result.reason });
      if (r.changed) await store.saveWatch(r.watch);
    }
    await notifier.send({ kind: 'SYSTEM_WARNING', reason: `사이트 구조가 바뀐 것으로 보입니다: ${result.reason}` });
    return { outcome: 'CONTRACT_BROKEN', log: [...log, `계약 드리프트: ${result.reason}`] };
  }

  if (result.kind === 'TRANSIENT_ERROR') {
    circuit = recordFailure(circuit, now);
    if (isOpen(circuit, now) && !circuit.alerted) {
      await notifier.send({ kind: 'SYSTEM_WARNING', reason: `조회가 연속 실패해 감시를 일시 중단합니다: ${result.reason}` });
      circuit = markAlerted(circuit);
      for (const w of active) {
        const r = applyEvent(w, { type: 'CIRCUIT_OPENED' });
        if (r.changed) await store.saveWatch(r.watch);
      }
    }
    await store.saveCircuit(circuit);
    return { outcome: 'POLLED', log: [...log, `조회 실패(${circuit.consecutiveFailures}회 연속): ${result.reason}`] };
  }

  await store.saveCircuit(recordSuccess());

  // --- diff ---
  const previous = await store.getSnapshot();
  const opened = newlyAvailable(previous, result.slots);
  await store.saveSnapshot(result.slots);
  log.push(opened.length > 0
    ? `새로 열린 슬롯: ${opened.map((s) => `${s.date} ${s.time}`).join(', ')}`
    : '새로 열린 슬롯 없음');

  // --- match + act ---
  const target = selectClaimTarget(await store.listWatches(), result.slots);
  if (!target) return { outcome: 'POLLED', log };

  const key = `${target.watch.userId}:${slotKey(target.slot)}`;
  if (!(await store.claimBookingKey(key))) {
    // 다른 워커 인스턴스가 이미 이 슬롯을 집었다. 이중 제출을 막는다.
    return { outcome: 'POLLED', log: [...log, `이미 처리 중인 슬롯: ${key}`] };
  }

  return await claim(deps, target.watch, target.slot, applicant, log);
}

async function claim(
  deps: TickDeps,
  watch: Watch,
  slot: import('../core/types.js').Slot,
  applicant: Applicant,
  log: string[],
): Promise<TickResult> {
  const { adapter, store, notifier } = deps;

  let current = applyEvent(watch, { type: 'SLOT_DETECTED' }).watch;
  current = applyEvent(current, { type: 'CLAIM_STARTED' }).watch;
  await store.saveWatch(current);
  log.push(`[${watch.id}] 여석 감지 → 예약 시도 ${slot.date} ${slot.time}`);

  for (let attempt = 0; attempt <= MAX_CLAIM_RETRIES; attempt++) {
    const outcome = await adapter.submitBooking(slot, applicant);

    if (outcome.kind === 'BOOKED' || outcome.kind === 'SIMULATED') {
      const confirmationId = outcome.kind === 'BOOKED' ? outcome.confirmationId : null;
      current = applyEvent(current, { type: 'CLAIM_SUCCEEDED' }).watch;
      await store.saveWatch(current);
      log.push(outcome.kind === 'SIMULATED'
        ? `[${watch.id}] DRY_RUN — 실제 제출하지 않음`
        : `[${watch.id}] 예약 확정 (${confirmationId ?? '확인번호 없음'})`);

      // 1인 1매: 같은 사용자의 나머지 감시를 종료한다.
      for (const other of await store.listWatches()) {
        if (other.userId === watch.userId && other.id !== watch.id && shouldPoll(other.state)) {
          const r = applyEvent(other, { type: 'SUPERSEDED' });
          if (r.changed) {
            await store.saveWatch(r.watch);
            log.push(`[${other.id}] 다른 예약 성공으로 감시 종료`);
          }
        }
      }

      await notifier.send({ kind: 'BOOKED', watch: current, slot, confirmationId });
      return { outcome: 'BOOKED', log };
    }

    if (outcome.kind === 'NEEDS_HUMAN') {
      // CAPTCHA·본인인증은 자동화 대상이 아니다 (§2.6). 즉시 사람에게 넘긴다.
      current = applyEvent(current, { type: 'CLAIM_FAILED', retriesLeft: 0 }).watch;
      await store.saveWatch(current);
      await notifier.send({ kind: 'NEEDS_ACTION', watch: current, slot, reason: outcome.reason, resumeUrl: outcome.resumeUrl });
      return { outcome: 'NEEDS_HUMAN', log: [...log, `[${watch.id}] 사람 개입 필요: ${outcome.reason}`] };
    }

    if (outcome.kind === 'SLOT_TAKEN') {
      // 남이 먼저 채갔다. 재시도해도 의미 없으므로 감시로 되돌린다.
      current = applyEvent(current, { type: 'CLAIM_FAILED', retriesLeft: 0 }).watch;
      current = applyEvent(current, { type: 'RESUMED_BY_USER' }).watch;
      await store.saveWatch(current);
      return { outcome: 'POLLED', log: [...log, `[${watch.id}] 그 사이 마감됨 — 감시 계속`] };
    }

    const retriesLeft = MAX_CLAIM_RETRIES - attempt;
    log.push(`[${watch.id}] 제출 실패(${outcome.reason}) — 남은 재시도 ${retriesLeft}`);
    current = applyEvent(current, { type: 'CLAIM_FAILED', retriesLeft }).watch;
    await store.saveWatch(current);

    if (retriesLeft === 0) {
      await notifier.send({
        kind: 'NEEDS_ACTION', watch: current, slot,
        reason: `자동 예약에 실패했습니다: ${outcome.reason}`,
        resumeUrl: slot.bookUrl,
      });
      return { outcome: 'NEEDS_HUMAN', log };
    }
  }

  return { outcome: 'NEEDS_HUMAN', log };
}
