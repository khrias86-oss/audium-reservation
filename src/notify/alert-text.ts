import type { Product } from './types.js';
import { PRODUCT_NAME, shortDate } from './types.js';
import { bookingSteps } from './github-issue.js';

/**
 * 신청자에게 가는 알림의 문구 (메일 본문 = ntfy 본문).
 *
 * 문구는 여기(테스트되는 TypeScript)에서 만들고, 알림 서버는 그대로 전달하면서
 * 끝에 "그만 받기" 링크만 붙인다. 문구가 두 곳에 흩어지지 않게.
 *
 * 이 메시지는 받는 사람이 **폰에서 뛰면서** 읽는다. 설명이 아니라 순서표다.
 */
export interface AlertMessage {
  readonly subject: string;
  readonly text: string;
  readonly click: string;
}

export const BOOKING_URL = 'https://audeum.org/booking';
export const PAGE_URL = 'https://khrias86-oss.github.io/audium-reservation/';

export function slotAlert(
  product: Product,
  date: string,
  time: string,
  options: { readonly verified: boolean; readonly bookUrl?: string | null } = { verified: true },
): AlertMessage {
  const url = options.bookUrl ?? BOOKING_URL;
  const card = product === 'lecture' ? '렉처 프로그램' : '전시';
  return {
    subject: `🎉 오디움 자리 났어요 — ${PRODUCT_NAME[product]} ${shortDate(date)} ${time}`,
    text: [
      `${PRODUCT_NAME[product]} ${shortDate(date)} ${time} 자리가 났습니다. 지금 예약하세요.`,
      options.verified ? '(방금 한 번 더 확인했고 자리가 남아 있었습니다.)' : '(다시 확인은 못 했습니다 — 그 사이 나갔을 수 있어요.)',
      '',
      `예약 페이지: ${url}`,
      '',
      ...bookingSteps(card, date, time).map((s) => s.replaceAll('**', '')),
      '',
      '취소표는 몇 분 만에 다시 나갑니다. 오디움은 1인 1매이고 본인 휴대폰 인증이 필요합니다.',
      '10분 뒤 다시 확인해 아직 자리가 있으면 한 번 더 알려 드립니다.',
    ].join('\n'),
    click: url,
  };
}

export function openingSoonAlert(product: Product, at: string): AlertMessage {
  const hm = at.slice(11, 16);
  return {
    subject: `⏰ 오늘 ${hm} 오디움 ${PRODUCT_NAME[product]} 예약 오픈 예상`,
    text: [
      `오늘 ${hm}에 ${PRODUCT_NAME[product]} 예약이 열릴 것으로 보입니다.`,
      '(지난 오픈 간격으로 추정한 시각이라 틀릴 수 있어요. 실제로 열리면 다시 알려 드립니다.)',
      '',
      `- ${hm} 조금 전에 예약 페이지를 열어 두세요: ${BOOKING_URL}`,
      '- 휴대폰 자동완성에 이름·이메일·전화번호가 들어 있는지 확인하세요',
      '- 함께 가실 분은 각자 본인 휴대폰으로 동시에 예약하세요 (1인 1매)',
    ].join('\n'),
    click: BOOKING_URL,
  };
}

export function openedAlert(product: Product, dates: readonly string[]): AlertMessage {
  const list = dates.map(shortDate).join(', ');
  return {
    subject: `📢 오디움 ${PRODUCT_NAME[product]} 예약이 열렸어요 — ${list}`,
    text: [
      `${PRODUCT_NAME[product]} 예약이 방금 열렸습니다: ${list}`,
      `예약 페이지: ${BOOKING_URL}`,
      '',
      '열린 직후가 자리가 가장 많을 때입니다. 함께 가실 분은 각자 본인 휴대폰으로 동시에 예약하세요 (1인 1매).',
      `원하는 회차가 이미 매진이면 빈자리 알림을 신청하세요: ${PAGE_URL}`,
    ].join('\n'),
    click: BOOKING_URL,
  };
}
