import { z } from 'zod';
import type { Product } from './types.js';

/**
 * 알림 서버(`mailer/Code.gs`, 주인 Google 계정의 Apps Script)와 이야기하는 쪽.
 *
 * 감시 시스템은 **누가 신청했는지 모른다.** 알림 서버에 "무엇을 볼지"만 묻고(wants),
 * 본 결과를 그대로 넘긴다(report). 누구에게 언제 보낼지는 알림 서버가 정한다 —
 * 신청자 메일 주소가 공개 저장소의 로그나 코드에 닿을 길이 아예 없다.
 */
export interface WantedSlot {
  readonly product: Product;
  readonly date: string;
  readonly time: string;
}

export interface Wants {
  readonly slots: readonly WantedSlot[];
  /** 오픈 알림을 신청한 사람이 있는 상품 */
  readonly opens: readonly Product[];
}

/** 이번에 확인한 회차 하나. 확인하지 못한 회차는 보내지 않는다(서버가 상태를 그대로 둔다). */
export interface Observation {
  readonly product: Product;
  readonly date: string;
  readonly time: string;
  readonly available: boolean;
  /** 자리가 있을 때만 — 알림 제목·본문·눌렀을 때 열 주소 */
  readonly subject?: string;
  readonly text?: string;
  readonly click?: string;
}

export interface OpeningEvent {
  readonly event: 'soon' | 'opened';
  readonly product: Product;
  /** 'soon'일 때 예상 오픈 시각 (KST). 같은 시각의 예고는 한 번만 간다. */
  readonly at?: string;
  readonly subject: string;
  readonly text: string;
  readonly click: string;
}

export interface Delivery {
  readonly alerted: number;
  readonly mailed: number;
  readonly pushed: number;
  readonly failed: number;
}

export interface AlertServer {
  wants(): Promise<Wants>;
  report(observations: readonly Observation[]): Promise<Delivery>;
  opening(event: OpeningEvent): Promise<Delivery>;
}

export interface AlertServerConfig {
  /** Apps Script 웹 앱 주소 (`https://script.google.com/macros/s/…/exec`) */
  readonly url: string;
  /** Apps Script의 NOTIFY_KEY */
  readonly key: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

const product = z.enum(['exhibition', 'lecture']);
const wantsSchema = z.object({
  ok: z.literal(true),
  slots: z.array(z.object({ product, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), time: z.string().regex(/^\d{2}:\d{2}$/) })),
  opens: z.array(product),
});
const deliverySchema = z.object({
  ok: z.literal(true),
  alerted: z.number(), mailed: z.number(), pushed: z.number(), failed: z.number(),
});

export function createAlertServer(config: AlertServerConfig): AlertServer {
  const doFetch = config.fetchImpl ?? fetch;

  async function call(body: Record<string, unknown>): Promise<unknown> {
    // text/plain: Apps Script 웹 앱은 본문을 그대로 받는다. 302로 결과 주소에 넘기므로 따라간다.
    const res = await doFetch(config.url, {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...body, key: config.key }),
      redirect: 'follow',
      signal: AbortSignal.timeout(config.timeoutMs ?? 30_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`알림 서버 HTTP ${res.status}: ${text.slice(0, 200)}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // 배포 권한이 "모든 사용자"가 아니면 Google 로그인 화면(HTML)이 온다.
      throw new Error(`알림 서버가 JSON이 아닌 응답을 줬습니다 (웹 앱 액세스가 "모든 사용자"인지 확인): ${text.slice(0, 120)}`);
    }
    const error = (parsed as { ok?: boolean; error?: string }).ok === false ? (parsed as { error?: string }).error : null;
    if (error) throw new Error(`알림 서버가 거절했습니다: ${error}`);
    return parsed;
  }

  return {
    async wants() {
      const r = wantsSchema.parse(await call({ action: 'wants' }));
      return { slots: r.slots, opens: r.opens };
    },
    async report(observations) {
      const r = deliverySchema.parse(await call({ action: 'report', observations }));
      return { alerted: r.alerted, mailed: r.mailed, pushed: r.pushed, failed: r.failed };
    },
    async opening(event) {
      const r = deliverySchema.parse(await call({ action: 'opening', ...event }));
      return { alerted: r.alerted, mailed: r.mailed, pushed: r.pushed, failed: r.failed };
    },
  };
}

/**
 * 워크플로 환경 변수에서 알림 서버 설정을 읽는다. 둘 중 하나라도 없으면 null —
 * 아직 설정 전이라는 뜻이고, 호출하는 쪽이 그 사실을 로그로 알린다.
 */
export function alertServerFromEnv(env: NodeJS.ProcessEnv): AlertServer | null {
  const url = env['MAILER_URL']?.trim();
  const key = env['MAILER_KEY']?.trim();
  if (!url || !key) return null;
  return createAlertServer({ url, key });
}
