import type { Notification, Notifier } from './types.js';
import { PRODUCT_NAME, shortDate } from './types.js';
import { bookingSteps } from './github-issue.js';

/**
 * 가족 알림 — 메일과 휴대폰 푸시(ntfy).
 *
 * 가족은 GitHub을 쓰지 않는다. 그래서 이슈 알림과 별도로 두 길로 보낸다.
 *
 * - **메일:** 저장소 주인의 Google 계정에 올린 Apps Script(`mailer/Code.gs`)가
 *   받아서, 그 계정의 Gmail로 등록된 가족 주소에 보낸다. 가족 주소는 Apps Script
 *   안에만 있고 이 저장소(public)에는 남지 않는다. 보내는 주소도 주인의 Gmail이라
 *   비밀번호를 어디에도 적을 필요가 없다.
 * - **푸시:** ntfy.sh의 비밀 채널로 보낸다. 초대 링크로 구독한 사람만 받는다.
 *
 * 둘 다 선택이다. 설정(시크릿)이 없으면 그 길은 조용히 건너뛴다.
 *
 * 무엇을 보낼지는 정하지 않는다 — 그건 이슈 알림이 정한다. `fanOut`이 이슈 쪽이
 * "실제로 알렸다"고 할 때만 여기로 넘기므로, 중복 판정이 한 곳에만 있다.
 */
export interface FamilyConfig {
  /** Apps Script 웹 앱 주소 (`https://script.google.com/macros/s/…/exec`). */
  readonly mailerUrl?: string;
  /** Apps Script의 NOTIFY_KEY. 이게 있어야 메일 발송을 요청할 수 있다. */
  readonly mailerKey?: string;
  /** ntfy 채널 이름. 추측할 수 없는 값이어야 한다 — 아는 사람은 누구나 받는다. */
  readonly ntfyTopic?: string;
  readonly ntfyServer?: string;
  /** 가족용 공개 페이지. 알림 끝에 붙인다. */
  readonly pageUrl: string;
  readonly log?: (line: string) => void;
}

interface Message {
  readonly title: string;
  readonly text: string;
  readonly click: string;
  /** ntfy 우선순위 1~5. 5는 방해 금지도 뚫는다. */
  readonly priority: number;
  readonly tags: readonly string[];
}

const BOOKING_URL = 'https://audeum.org/booking';

/** 가족에게 보낼 알림만 골라 문구를 만든다. 시스템 경고 같은 운영 알림은 보내지 않는다. */
export function familyMessage(n: Notification, pageUrl: string): Message | null {
  const footer = `\n\n— 오디움 빈자리 알림 (${pageUrl})`;
  switch (n.kind) {
    case 'NEEDS_ACTION': {
      const card = n.product === 'lecture' ? '렉처 프로그램' : '전시';
      return {
        title: `🎉 오디움 자리 났어요 — ${shortDate(n.slot.date)} ${n.slot.time}`,
        text: [
          `${PRODUCT_NAME[n.product]} ${shortDate(n.slot.date)} ${n.slot.time} 자리가 났습니다. 지금 예약하세요.`,
          `예약 페이지: ${n.resumeUrl ?? BOOKING_URL}`,
          '',
          ...bookingSteps(card, n.slot.date, n.slot.time).map((s) => s.replaceAll('**', '')),
          '',
          '오디움은 1인 1매입니다. 함께 가실 분은 각자 본인 휴대폰으로 예약하세요.',
          '취소표는 몇 분 만에 사라지기도 합니다.',
        ].join('\n') + footer,
        click: n.resumeUrl ?? BOOKING_URL,
        priority: 5,
        tags: ['tada'],
      };
    }
    case 'OPENED':
      return {
        title: `📢 오디움 예약이 열렸어요 — ${n.dates.map(shortDate).join(', ')}`,
        text: [
          `${PRODUCT_NAME[n.product]} 예약이 방금 열렸습니다: ${n.dates.map(shortDate).join(', ')}`,
          `예약 페이지: ${BOOKING_URL}`,
          '',
          '열린 직후가 자리가 가장 많을 때입니다. 함께 가실 분은 각자 본인 휴대폰으로 동시에 예약하세요 (1인 1매).',
        ].join('\n') + footer,
        click: BOOKING_URL,
        priority: 5,
        tags: ['loudspeaker'],
      };
    case 'OPENING_SOON':
      return {
        title: `⏰ 오늘 ${n.at.slice(11, 16)} 오디움 예약 오픈 예상`,
        text: [
          `오늘 ${n.at.slice(11, 16)}에 ${PRODUCT_NAME[n.product]} 예약이 열릴 것으로 보입니다 (격주 규칙으로 추정한 시각이라 틀릴 수 있어요).`,
          '',
          `- ${n.at.slice(11, 16)} 조금 전에 예약 페이지를 열어 두세요: ${BOOKING_URL}`,
          '- 휴대폰 자동완성에 이름·이메일·전화번호가 들어 있는지 확인하세요',
          '- 함께 가실 분은 각자 본인 휴대폰으로 동시에 예약하세요 (1인 1매)',
        ].join('\n') + footer,
        click: BOOKING_URL,
        priority: 4,
        tags: ['alarm_clock'],
      };
    default:
      return null;
  }
}

export function createFamilyNotifier(config: FamilyConfig): Notifier {
  const log = config.log ?? ((line: string) => console.log(line));
  const ntfyServer = config.ntfyServer ?? 'https://ntfy.sh';

  async function mail(m: Message): Promise<void> {
    if (!config.mailerUrl || !config.mailerKey) return;
    // text/plain으로 보낸다 — Apps Script 웹 앱이 그대로 받고, 브라우저와 같은 방식이다.
    const res = await fetch(config.mailerUrl, {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'notify', key: config.mailerKey, subject: m.title, text: m.text }),
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    });
    const body = await res.text();
    if (!res.ok || !body.includes('"ok":true')) throw new Error(`메일 발송 실패 (HTTP ${res.status}): ${body.slice(0, 200)}`);
    log(`- 📧 가족 메일 발송: ${body.slice(0, 120)}`);
  }

  async function push(m: Message): Promise<void> {
    if (!config.ntfyTopic) return;
    // JSON으로 보내면 제목에 한글을 넣어도 헤더 인코딩 문제가 없다.
    const res = await fetch(ntfyServer, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        topic: config.ntfyTopic, title: m.title, message: m.text,
        click: m.click, priority: m.priority, tags: m.tags,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`푸시 발송 실패 (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
    log('- 📱 가족 푸시 발송');
  }

  return {
    async send(notification) {
      const m = familyMessage(notification, config.pageUrl);
      if (!m) return false;
      // 한쪽이 실패해도 다른 쪽은 보낸다. 둘 다 실패하면 밖으로 알린다.
      const results = await Promise.allSettled([mail(m), push(m)]);
      const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      for (const f of failures) log(`- ⚠️ 가족 알림 일부 실패: ${f.reason instanceof Error ? f.reason.message : String(f.reason)}`);
      if (failures.length === results.length) throw new Error('가족 알림을 하나도 보내지 못했습니다');
      return true;
    },
  };
}

/**
 * 이슈 알림을 먼저 보내고, 그쪽이 "실제로 알렸다"고 할 때만 나머지(가족 알림)로 넘긴다.
 *
 * 이슈 알림이 중복 판정을 들고 있다 — 열린 이슈와 쿨다운. 가족 알림이 따로 판정하면
 * 상태를 둘로 나눠 들게 되고, 자리가 열려 있는 동안 5분마다 가족 폰이 울린다.
 * 가족 알림이 실패해도 이슈 알림은 이미 나갔으므로 감시를 멈추지 않는다.
 */
export function fanOut(primary: Notifier, followers: readonly Notifier[], log: (line: string) => void = console.log): Notifier {
  return {
    async send(notification) {
      const sent = await primary.send(notification);
      if (sent === false) return false;
      for (const follower of followers) {
        try {
          await follower.send(notification);
        } catch (error) {
          log(`- ⚠️ 가족 알림 실패: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return true;
    },
  };
}

/** 워크플로 환경 변수에서 가족 알림 설정을 읽는다. 없는 값은 그 길을 끈다. */
export function familyConfigFromEnv(env: NodeJS.ProcessEnv, log?: (line: string) => void): FamilyConfig {
  const pick = (name: string) => env[name]?.trim() || undefined;
  const mailerUrl = pick('MAILER_URL');
  const mailerKey = pick('MAILER_KEY');
  const ntfyTopic = pick('NTFY_TOPIC');
  return {
    ...(mailerUrl ? { mailerUrl } : {}),
    ...(mailerKey ? { mailerKey } : {}),
    ...(ntfyTopic ? { ntfyTopic } : {}),
    pageUrl: pick('PAGE_URL') ?? 'https://khrias86-oss.github.io/audium-reservation/',
    ...(log ? { log } : {}),
  };
}
