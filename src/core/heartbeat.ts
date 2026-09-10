/**
 * 데드맨 스위치.
 *
 * 이 시스템의 최악의 실패 모드는 "돌아가는 줄 알았는데 몇 주째 멈춰 있었다"이다.
 * 워커는 매 틱 하트비트를 남기고, 대시보드는 하트비트가 끊기면 크게 경고한다.
 * 기본 임계값은 10분 주기 기준 2틱 이상 누락에 해당하는 25분이다.
 */
export const HEARTBEAT_STALE_MINUTES = 25;

export interface HeartbeatStatus {
  readonly stale: boolean;
  readonly ageMinutes: number | null;
  readonly message: string;
}

export function checkHeartbeat(
  lastHeartbeat: Date | null,
  now: Date,
  staleMinutes: number = HEARTBEAT_STALE_MINUTES,
): HeartbeatStatus {
  if (lastHeartbeat === null) {
    return { stale: true, ageMinutes: null, message: '워커가 아직 한 번도 실행되지 않았습니다' };
  }

  const ageMinutes = (now.getTime() - lastHeartbeat.getTime()) / 60_000;

  // 미래 타임스탬프는 시계 불일치를 뜻한다. 정상으로 간주하되 드러낸다.
  if (ageMinutes < 0) {
    return {
      stale: false,
      ageMinutes,
      message: '하트비트가 미래 시각입니다 — 워커와 대시보드의 시계를 확인하세요',
    };
  }

  if (ageMinutes >= staleMinutes) {
    return {
      stale: true,
      ageMinutes,
      message: `감시가 중단된 것으로 보입니다 (마지막 확인 ${Math.round(ageMinutes)}분 전)`,
    };
  }

  return {
    stale: false,
    ageMinutes,
    message: `정상 — 마지막 확인 ${Math.round(ageMinutes)}분 전`,
  };
}
