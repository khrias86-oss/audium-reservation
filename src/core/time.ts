/** 오디움은 한국 시설이므로 모든 날짜/회차는 KST 기준으로 해석한다. */
export const KST_OFFSET_MINUTES = 9 * 60;

/** UTC 시각을 KST 기준 YYYY-MM-DD로 변환한다. */
export function toKstDateString(instant: Date): string {
  const shifted = new Date(instant.getTime() + KST_OFFSET_MINUTES * 60_000);
  return shifted.toISOString().slice(0, 10);
}

/** KST 기준 날짜/시각 문자열을 절대 시각(Date)으로 변환한다. */
export function kstToInstant(date: string, time: string): Date {
  return new Date(`${date}T${time}:00+09:00`);
}

/**
 * 기준 시각에서 대상 회차까지 남은 일수. 같은 날이면 0, 이미 지났으면 음수.
 * KST 달력일 기준으로 세므로 자정 직전/직후에도 사람의 직관과 어긋나지 않는다.
 */
export function daysUntil(now: Date, targetDate: string): number {
  const today = toKstDateString(now);
  const msPerDay = 86_400_000;
  const a = Date.parse(`${today}T00:00:00Z`);
  const b = Date.parse(`${targetDate}T00:00:00Z`);
  return Math.round((b - a) / msPerDay);
}
