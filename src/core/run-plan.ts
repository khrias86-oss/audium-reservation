/**
 * 이번 실행에서 무엇을 얼마나 할지 정한다 — 감시 신청 확인, 예약 오픈 지켜보기.
 *
 * ## 예약 오픈 시간대
 *
 * 두 사람이 같은 회차를 잡으려면 취소표보다 **예약이 처음 열리는 순간**이 훨씬
 * 유리하다. 취소표는 보통 한 장씩 나오고 사이트는 남은 좌석 수를 알려주지 않는다.
 * 그래서 오픈 예상 시각 앞뒤로는 감시 신청이 없어도 5분마다 스냅샷을 다시 떠서
 * 새로 열린 날짜를 바로 알린다.
 *
 * 오픈 시각은 격주 규칙으로 추정한 값이다(`guessNextOpening`). 추정이 없으면
 * 사이트 공지("격주 화요일 오후 2시")대로 매주 화요일 13:00~15:00을 본다 —
 * 격주라서 절반은 헛걸음이지만, 놓치는 것보다 낫다.
 */
export interface RunPlanInput {
  readonly now: Date;
  /** 지나지 않은 감시 신청 수 */
  readonly activeRequests: number;
  /** 상품별 다음 오픈 예상 시각 (KST `YYYY-MM-DDTHH:MM:SS`) */
  readonly openingGuesses: readonly string[];
  /** 사람이 정한 감시 시간(분). 없으면 105. */
  readonly requestedLoopMinutes?: number;
}

export interface RunPlan {
  /** 감시 신청을 확인할지 */
  readonly watch: boolean;
  /** 예약 오픈 시간대인지 — 루프마다 스냅샷을 다시 뜬다 */
  readonly openingWindow: boolean;
  /** 5분 간격 루프를 몇 분 돌지 (0이면 한 번만) */
  readonly loopMinutes: number;
}

/** 잡(job)의 시간 제한이 115분이므로 루프는 105분을 넘기지 않는다. */
export const MAX_LOOP_MINUTES = 105;
/** 오픈 예상 시각보다 이만큼 먼저 지켜보기 시작한다 (예고 알림 포함). */
export const WINDOW_BEFORE_MS = 75 * 60_000;
/** 오픈 예상 시각 뒤로 이만큼 더 지켜본다 — 추정이 조금 늦거나, 늦게 열려도 잡게. */
export const WINDOW_AFTER_MS = 60 * 60_000;

const KST_MS = 9 * 3600_000;

/** KST `YYYY-MM-DDTHH:MM:SS`를 절대 시각(ms)으로. */
function kstMs(local: string): number {
  return Date.parse(`${local.slice(0, 19)}+09:00`);
}

/** 지금이 오픈 시간대면 그 끝 시각(ms), 아니면 null. */
export function openingWindowEnd(now: Date, guesses: readonly string[]): number | null {
  const t = now.getTime();
  const valid = guesses.filter((g) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(g)).map(kstMs);

  if (valid.length > 0) {
    const hit = valid.find((g) => g - WINDOW_BEFORE_MS <= t && t < g + WINDOW_AFTER_MS);
    return hit === undefined ? null : hit + WINDOW_AFTER_MS;
  }

  // 추정이 없으면 매주 화요일 13:00~15:00 KST.
  const kst = new Date(t + KST_MS);
  const minutes = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  if (kst.getUTCDay() !== 2 || minutes < 13 * 60 || minutes >= 15 * 60) return null;
  return t + (15 * 60 - minutes) * 60_000;
}

export function planRun(input: RunPlanInput): RunPlan {
  const watch = input.activeRequests > 0;
  const requested = Math.max(0, Math.min(MAX_LOOP_MINUTES, input.requestedLoopMinutes ?? MAX_LOOP_MINUTES));
  const end = openingWindowEnd(input.now, input.openingGuesses);

  let loop = watch ? requested : 0;
  if (end !== null) {
    const untilEnd = Math.ceil((end - input.now.getTime()) / 60_000);
    loop = Math.max(loop, Math.min(MAX_LOOP_MINUTES, untilEnd));
  }

  return { watch, openingWindow: end !== null, loopMinutes: loop };
}
