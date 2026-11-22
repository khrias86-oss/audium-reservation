import type { Notification, Notifier } from './types.js';
import { PRODUCT_NAME, dowName, shortDate, subjectFor } from './types.js';

/**
 * GitHub Issue를 여는 방식의 알림.
 *
 * 왜 이메일 서비스(Resend/SMTP) 대신 이것인가:
 * GitHub는 저장소를 Watch 중인 사용자에게 이슈가 열리면 이메일과 모바일 앱
 * 푸시를 자동으로 보낸다. 저장소 소유자는 기본적으로 알림 대상이므로,
 * **설정할 것도 발급받을 API 키도 없다.** 모바일만 쓰는 상황에서 이게 결정적이다.
 *
 * 부수 효과로 중복 알림 방지가 공짜로 따라온다 — 같은 대상에 대해 열린 이슈가
 * 있으면 그 자체가 "이미 알렸다"는 상태다. 별도 저장소가 필요 없다. 가족 알림
 * (메일·푸시)도 이 판정을 그대로 따른다 (`send`가 true일 때만 보낸다).
 */
export interface GitHubIssueConfig {
  readonly owner: string;
  readonly repo: string;
  /** Actions가 주입하는 GITHUB_TOKEN */
  readonly token: string;
  /** 사용 중인 API 베이스. 테스트에서 갈아끼운다. */
  readonly apiBase?: string;
}

/**
 * 알림 하나에 이슈 하나. 이 라벨이 중복 판정의 기준이 된다.
 *
 * 시스템 경고에도 라벨이 있다. 예전에는 없었고, 그래서 2026-09-19 저녁 같은 경고가
 * 5분마다 새 이슈로 99건 쌓였다. 이제 같은 문제는 이슈 하나에 모인다.
 */
export function alertLabel(n: Notification): string {
  switch (n.kind) {
    case 'BOOKED':
    case 'NEEDS_ACTION':
      return `slot:${n.slot.date}T${n.slot.time}`;
    case 'SYSTEM_WARNING':
      return `system:${n.key ?? 'general'}`;
    case 'SYSTEM_RECOVERED':
      return `system:${n.key}`;
    case 'OPENED':
      return `opened:${n.product}:${n.dates[0] ?? 'unknown'}`;
    case 'OPENING_SOON':
      return `opening-soon:${n.at.slice(0, 10)}`;
  }
}

/**
 * 같은 대상을 다시 알리기까지 기다리는 시간.
 *
 * 자리(slot): 짧으면 자리가 계속 열려 있는 동안 5분마다 댓글이 달려 알림이 무의미해지고,
 * 길면 사라졌다 다시 난 자리를 놓친다. 오디움 취소표는 5분에서 몇 시간까지
 * 남아 있으므로 30분이면 양쪽을 다 지킨다.
 */
export const RENOTIFY_COOLDOWN_MS = 30 * 60_000;

/** 시스템 경고: 사람이 볼 때까지 한 번이면 충분하다. 반나절마다 "아직이다"만 덧붙인다. */
export const SYSTEM_RENOTIFY_COOLDOWN_MS = 6 * 60 * 60_000;

function cooldownFor(n: Notification): number {
  switch (n.kind) {
    case 'SYSTEM_WARNING': return SYSTEM_RENOTIFY_COOLDOWN_MS;
    // 예약 오픈은 한 번 알리면 끝이다. 같은 오픈을 두 번 알릴 이유가 없다.
    case 'OPENED':
    case 'OPENING_SOON': return Number.POSITIVE_INFINITY;
    default: return RENOTIFY_COOLDOWN_MS;
  }
}

export function createGitHubIssueNotifier(config: GitHubIssueConfig): Notifier {
  const base = config.apiBase ?? 'https://api.github.com';
  const repoUrl = `${base}/repos/${config.owner}/${config.repo}`;
  const headers = {
    authorization: `Bearer ${config.token}`,
    accept: 'application/vnd.github+json',
    'content-type': 'application/json',
  };

  /**
   * 이 라벨로 이미 열려 있는 알림 이슈.
   *
   * `updated_at`을 함께 돌려준다. 댓글이 달리면 갱신되므로, 마지막으로 이
   * 대상을 알린 시각이 된다.
   */
  async function openAlertFor(label: string): Promise<{ number: number; updatedAt: number } | null> {
    const res = await fetch(
      `${repoUrl}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=1`,
      { headers },
    );
    if (!res.ok) {
      // 조회 실패를 "없음"으로 해석하면 알림이 폭주한다. 차라리 보내지 않는다.
      throw new Error(`이슈 조회 실패 (HTTP ${res.status}) — 중복 알림을 막기 위해 발송하지 않습니다`);
    }
    const issues = (await res.json()) as Array<{ number: number; updated_at: string }>;
    const first = issues[0];
    return first ? { number: first.number, updatedAt: Date.parse(first.updated_at) } : null;
  }

  async function post(path: string, body: unknown, method = 'POST'): Promise<void> {
    const res = await fetch(`${repoUrl}${path}`, { method, headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`GitHub ${method} ${path} 실패 (HTTP ${res.status})`);
  }

  return {
    async send(notification) {
      const label = alertLabel(notification);
      const existing = await openAlertFor(label);

      if (notification.kind === 'SYSTEM_RECOVERED') {
        // 복구는 경고 이슈가 있을 때만 의미가 있다. 없으면 조용히 넘어간다 —
        // 매 확인마다 불리므로 여기서 새 이슈를 만들면 안 된다.
        if (existing === null) return false;
        await post(`/issues/${existing.number}/comments`, { body: `## ✅ 복구되었습니다\n\n${notification.note}` });
        await post(`/issues/${existing.number}`, { state: 'closed', state_reason: 'completed' }, 'PATCH');
        return true;
      }

      if (existing !== null) {
        // 여기서 그냥 돌아가면 **같은 회차에 자리가 다시 나도 영원히 알리지 않는다.**
        //
        // 실제로 그 일이 일어날 뻔했다. 9월 19일 13:30 자리가 새벽 4시 20분에 5분간
        // 열렸고 시스템이 정확히 잡아 알렸지만, 사용자는 자고 있었다. 그 뒤로
        // 같은 회차에 자리가 나도 이슈가 열려 있다는 이유로 침묵했을 것이다.
        // 그래서 기존 이슈에 **댓글로** 다시 알린다.
        if (Date.now() - existing.updatedAt < cooldownFor(notification)) return false;
        const heading = notification.kind === 'SYSTEM_WARNING' ? '## ⚠️ 아직 해결되지 않았습니다' : '## 🔔 자리가 또 났습니다';
        await post(`/issues/${existing.number}/comments`, { body: `${heading}\n\n${bodyFor(notification)}` });
        return true;
      }

      await post('/issues', {
        title: subjectFor(notification),
        body: bodyFor(notification),
        labels: ['audeum-alert', label],
      });
      return true;
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

    case 'NEEDS_ACTION': {
      // 이 메시지는 사용자가 **폰에서 뛰면서** 읽는다. 설명이 아니라 순서표여야 한다.
      //
      // 오디움 예약 화면은 마지막에 휴대폰 인증번호와 Cloudflare Turnstile을
      // 요구한다(`docs/auto-booking.md`). 그 둘은 사람만 통과할 수 있으므로
      // 시스템이 대신 눌러 줄 수 없다. 대신 **무엇을 어떤 순서로 누를지**를
      // 미리 적어 두면 화면에서 헤매는 시간이 사라진다.
      const card = n.product === 'lecture' ? '렉처 프로그램' : '전시';
      return [
        `# 👉 [오디움 예약 페이지 열기](${n.resumeUrl ?? 'https://audeum.org/booking'})`,
        '',
        `## ${n.slot.date} (${dowName(n.slot.date)}) **${n.slot.time}**`,
        n.reserveSeq ? `\`회차 ${n.reserveSeq}\`` : '',
        '',
        '### 순서대로 누르세요 (약 1분)',
        '',
        ...bookingSteps(card, n.slot.date, n.slot.time),
        '',
        '> 5번과 6번은 오디움이 사람만 통과하도록 만든 관문이라 자동으로 할 수 없습니다.',
        '> 그 앞은 전부 시스템이 처리했습니다 — 감시, 감지, 사라졌는지 재확인까지.',
        '',
        '---',
        '',
        `_${n.reason}_`,
        '',
        '**자리가 없다고 나오면** 그 사이에 다른 사람이 가져간 것입니다.',
        '이 이슈를 닫지 마세요 — 감시는 계속되고 다음 취소표를 다시 잡습니다.',
        '',
        '예약에 성공했다면 **감시 신청 이슈를 닫아** 주세요. 그래야 확인이 멈춥니다.',
      ].filter((line, i, all) => !(line === '' && all[i - 1] === '')).join('\n');
    }

    case 'OPENED':
      return [
        '# 👉 [오디움 예약 페이지 열기](https://audeum.org/booking)',
        '',
        `## ${PRODUCT_NAME[n.product]} 예약이 방금 열렸습니다`,
        '',
        `새로 열린 날짜: **${n.dates.map(shortDate).join(', ')}**`,
        '',
        '열린 직후가 자리가 가장 많을 때입니다. 함께 가실 분들은 **각자 본인 휴대폰으로 동시에** 예약하세요 (1인 1매).',
      ].join('\n');

    case 'OPENING_SOON':
      return [
        `## 오늘 ${n.at.slice(11, 16)}에 ${PRODUCT_NAME[n.product]} 예약이 열릴 것으로 보입니다`,
        '',
        '격주 오픈 규칙으로 **추정한** 시각입니다. 틀릴 수 있습니다.',
        '',
        `- ${n.at.slice(11, 16)} 조금 전에 [예약 페이지](https://audeum.org/booking)를 열어 두세요`,
        '- 휴대폰 자동완성에 이름·이메일·전화번호가 들어 있는지 확인하세요',
        '- 함께 가실 분들은 각자 본인 휴대폰으로 동시에 예약해야 합니다 (1인 1매)',
      ].join('\n');

    case 'SYSTEM_WARNING':
      return [
        '## 감시 시스템에 문제가 생겼습니다',
        '',
        n.reason,
        '',
        '대응 절차는 `docs/runbook.md`를 참고하세요. 문제가 풀리면 이 이슈는 자동으로 닫힙니다.',
        '',
        '⚠️ **이 이슈가 열려 있는 동안 빈자리를 놓치고 있을 수 있습니다.**',
      ].join('\n');

    case 'SYSTEM_RECOVERED':
      return n.note;
  }
}

/** 예약 화면 순서표 — 이슈와 가족 메일이 같은 문구를 쓴다. */
export function bookingSteps(card: string, date: string, time: string): string[] {
  return [
    `1. **${card}** 카드를 누릅니다`,
    '2. 인원에서 **＋** 를 눌러 1명으로 맞춥니다',
    `3. 달력에서 **${Number(date.slice(8))}일** → 회차 **${time}** 을 누릅니다`,
    '4. 이름·이메일을 넣고 **내국인**을 고릅니다',
    '5. 휴대폰 번호를 넣고 **인증번호 발송** → 문자로 온 **4자리**를 입력합니다',
    '6. **사람인지 확인** 체크 → **예약하기**',
  ];
}
