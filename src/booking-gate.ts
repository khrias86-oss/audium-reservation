/**
 * 실제 예약을 켤지 결정하는 관문.
 *
 * 첫 시험 운전에서 워크플로 표현식 하나 때문에 실제 예약 모드로 돌았다.
 * 그때는 자리가 없어서 아무 일도 없었지만, 그건 설계가 막은 게 아니라 운이었다.
 * 그래서 판정을 워크플로 밖으로 꺼내 프로그램 안에도 방어선을 둔다.
 *
 * 원칙: **위험한 쪽은 모든 조건이 명시적으로 갖춰졌을 때만 선택된다.**
 * 값이 없거나 모르는 값이면 전부 안전한 쪽으로 떨어진다.
 */

export interface GateInput {
  /** 'false'라는 문자열일 때만 실제 예약 의사로 읽는다 */
  readonly dryRunEnv: string | undefined;
  readonly applicantName: string | undefined;
  readonly applicantEmail: string | undefined;
}

export type GateDecision =
  | { readonly live: true }
  | { readonly live: false; readonly reason: string };

export function decideBookingMode(input: GateInput): GateDecision {
  if (input.dryRunEnv !== 'false') {
    return { live: false, reason: '확인만 하는 모드입니다 (실제 예약을 켜려면 명시적으로 설정해야 합니다)' };
  }

  // 실제 예약을 켰더라도 예약자 정보가 없으면 예약할 수 없다.
  // 이 경우 "켜졌다"고 보고하고 실패하는 것보다, 확인 모드로 내려가는 편이 낫다.
  const name = input.applicantName?.trim();
  const email = input.applicantEmail?.trim();

  if (!name || !email) {
    return {
      live: false,
      reason: '실제 예약이 켜져 있지만 예약자 이름·이메일이 없어 확인만 합니다 '
        + '(저장소 Settings > Secrets 에 APPLICANT_NAME, APPLICANT_EMAIL 을 등록하세요)',
    };
  }

  if (!email.includes('@')) {
    return { live: false, reason: `예약자 이메일 형식이 올바르지 않습니다: ${email}` };
  }

  return { live: true };
}
