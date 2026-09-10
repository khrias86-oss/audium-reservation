import { z } from 'zod';
import { MIN_INTERVAL_MINUTES } from './core/scheduler.js';

/**
 * 환경변수 파싱.
 *
 * 잘못된 설정으로 조용히 잘못 동작하느니 기동 시점에 죽는 편이 낫다.
 * 특히 DRY_RUN은 오타 하나가 원치 않는 실제 예약으로 이어지므로
 * 'false'라는 정확한 문자열만 게이트를 연다.
 */
const Schema = z.object({
  MODE: z.enum(['server', 'tick']).default('server'),
  PORT: z.coerce.number().int().positive().default(8080),

  /** 'false'일 때만 실제 제출. 미설정·오타·빈 문자열은 전부 안전한 쪽으로 해석된다. */
  DRY_RUN: z.string().default('true'),

  POLL_INTERVAL_MINUTES: z.coerce.number().int().min(MIN_INTERVAL_MINUTES).default(10),
  POLL_JITTER_SECONDS: z.coerce.number().int().min(0).max(300).default(60),
  ADAPTIVE_POLLING: z.enum(['true', 'false']).default('false'),

  NOTIFY_EMAIL_TO: z.string().email().optional(),
  RESEND_API_KEY: z.string().optional(),
  DATABASE_URL: z.string().optional(),
});

export interface Config {
  readonly mode: 'server' | 'tick';
  readonly port: number;
  /** true면 실제 예약을 제출한다. 기본값은 항상 false. */
  readonly liveBooking: boolean;
  readonly pollIntervalMinutes: number;
  readonly pollJitterSeconds: number;
  readonly adaptivePolling: boolean;
  readonly notifyEmailTo: string | undefined;
  readonly resendApiKey: string | undefined;
  readonly databaseUrl: string | undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Schema.parse(env);
  return {
    mode: parsed.MODE,
    port: parsed.PORT,
    liveBooking: parsed.DRY_RUN === 'false',
    pollIntervalMinutes: parsed.POLL_INTERVAL_MINUTES,
    pollJitterSeconds: parsed.POLL_JITTER_SECONDS,
    adaptivePolling: parsed.ADAPTIVE_POLLING === 'true',
    notifyEmailTo: parsed.NOTIFY_EMAIL_TO,
    resendApiKey: parsed.RESEND_API_KEY,
    databaseUrl: parsed.DATABASE_URL,
  };
}
