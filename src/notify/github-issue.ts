import type { Notification, Notifier } from './types.js';
import { subjectFor } from './types.js';

/**
 * GitHub Issue를 여는 방식의 알림.
 *
 * 왜 이메일 서비스(Resend/SMTP) 대신 이것인가:
 * GitHub는 저장소를 Watch 중인 사용자에게 이슈가 열리면 이메일과 모바일 앱
 * 푸시를 자동으로 보낸다. 저장소 소유자는 기본적으로 알림 대상이므로,
 * **설정할 것도 발급받을 API 키도 없다.** 모바일만 쓰는 상황에서 이게 결정적이다.
 *
 * 부수 효과로 중복 알림 방지가 공짜로 따라온다 — 같은 슬롯에 대해 열린 이슈가
 * 있으면 그 자체가 "이미 알렸다"는 상태다. 별도 저장소가 필요 없다.
 */
export interface GitHubIssueConfig {
  readonly owner: string;
  readonly repo: string;
  /** Actions가 주입하는 GITHUB_TOKEN */
  readonly token: string;
  /** 사용 중인 API 베이스. 테스트에서 갈아끼운다. */
  readonly apiBase?: string;
}

/** 슬롯 하나에 이슈 하나. 이 라벨이 중복 판정의 기준이 된다. */
export function slotLabel(n: Notification): string | null {
  if (n.kind === 'SYSTEM_WARNING') return null;
  return `slot:${n.slot.date}T${n.slot.time}`;
}

export function createGitHubIssueNotifier(config: GitHubIssueConfig): Notifier {
  const base = config.apiBase ?? 'https://api.github.com';
  const headers = {
    authorization: `Bearer ${config.token}`,
    accept: 'application/vnd.github+json',
    'content-type': 'application/json',
  };

  async function hasOpenIssueWithLabel(label: string): Promise<boolean> {
    const url = `${base}/repos/${config.owner}/${config.repo}/issues`
      + `?state=open&labels=${encodeURIComponent(label)}&per_page=1`;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      // 조회 실패를 "없음"으로 해석하면 알림이 폭주한다. 있다고 보고 넘어간다.
      throw new Error(`이슈 조회 실패 (HTTP ${res.status}) — 중복 알림을 막기 위해 발송하지 않습니다`);
    }
    const issues = (await res.json()) as unknown[];
    return issues.length > 0;
  }

  return {
    async send(notification) {
      const label = slotLabel(notification);

      if (label !== null && (await hasOpenIssueWithLabel(label))) {
        return; // 이미 알린 슬롯이다.
      }

      const res = await fetch(`${base}/repos/${config.owner}/${config.repo}/issues`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          title: subjectFor(notification),
          body: bodyFor(notification),
          labels: label === null ? ['audeum-alert'] : ['audeum-alert', label],
        }),
      });

      if (!res.ok) {
        throw new Error(`이슈 생성 실패 (HTTP ${res.status})`);
      }
    },
  };
}

/**
 * 모바일 알림에서 제목 다음으로 보이는 첫 줄이 가장 중요하다.
 * 조치가 필요한 경우 링크를 맨 위에 둔다.
 */
function bodyFor(n: Notification): string {
  switch (n.kind) {
    case 'BOOKED':
      return [
        `**${n.slot.date} ${n.slot.time} 예약이 확정되었습니다.**`,
        '',
        n.confirmationId ? `예약번호: \`${n.confirmationId}\`` : '_확인번호를 받지 못했습니다 — 아래 안내를 확인하세요._',
        '',
        '- 오디움이 보내는 QR 티켓 메일이 5분 내 도착하는지 확인하세요.',
        '- 입장 시 신분증이 필요합니다. 본인 명의 예약만 유효합니다.',
        '- **가지 못하게 되면 즉시 취소하세요.** 사전 통보 없는 불참은 향후 예약이 제한될 수 있습니다.',
        '  취소는 예약 확인 메일의 취소 링크로만 가능합니다.',
        '',
        '처리가 끝나면 이 이슈를 닫아 주세요. 닫힌 이슈는 같은 슬롯의 재알림을 막는 기록으로 남습니다.',
      ].join('\n');

    case 'NEEDS_ACTION':
      return [
        n.resumeUrl ? `## 👉 [지금 직접 예약하기](${n.resumeUrl})` : '## 직접 예약이 필요합니다',
        '',
        `**${n.slot.date} ${n.slot.time}** 자리를 찾았지만 자동 예약을 끝내지 못했습니다.`,
        '',
        `사유: ${n.reason}`,
        '',
        '감시는 계속됩니다 — 이번에 놓쳐도 다음 취소표를 계속 노립니다.',
      ].join('\n');

    case 'SYSTEM_WARNING':
      return [
        '## 감시 시스템에 문제가 생겼습니다',
        '',
        n.reason,
        '',
        '대응 절차는 `docs/runbook.md`를 참고하세요.',
        '',
        '⚠️ **이 이슈가 열려 있는 동안 빈자리를 놓치고 있을 수 있습니다.**',
      ].join('\n');
  }
}
