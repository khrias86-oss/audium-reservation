import { z } from 'zod';
import type { Watch } from '../core/types.js';

/**
 * 감시 조건 파일 (`watches.json`).
 *
 * 이 파일은 **사용자가 GitHub 모바일에서 직접 편집**한다. 그래서 검증이 엄격해야 하고,
 * 오류 메시지가 폰 화면에서 읽고 바로 고칠 수 있을 만큼 구체적이어야 한다.
 * "invalid input" 같은 메시지는 여기서 쓸모가 없다.
 *
 * **예약자 개인정보는 이 파일에 넣지 않는다.** 저장소에 커밋되기 때문이다.
 * 이름·이메일은 GitHub Secrets에서 환경변수로 주입한다.
 */

const KST_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const WatchEntry = z.object({
  date: z.string().regex(KST_DATE, '날짜는 YYYY-MM-DD 형식이어야 합니다 (예: 2026-03-14)'),
  time: z.string().regex(HHMM, '회차는 HH:MM 24시간 형식이어야 합니다 (예: 10:00, 13:30)'),
  /** 어떤 상품인가. 도슨트 관람은 exhibition이다. */
  product: z.enum(['exhibition', 'lecture']).default('exhibition'),
  /** 낮을수록 먼저 시도한다. 생략하면 파일에 적힌 순서를 쓴다. */
  priority: z.number().int().min(0).optional(),
  /** 사람이 알아보기 위한 메모. 동작에 영향을 주지 않는다. */
  note: z.string().optional(),
});

const WatchFile = z.object({
  watches: z.array(WatchEntry).max(20, '감시는 최대 20건까지입니다'),
});

export type WatchEntry = z.infer<typeof WatchEntry>;

export interface LoadedWatch extends Watch {
  readonly product: 'exhibition' | 'lecture';
  readonly note: string | undefined;
}

/**
 * 파일 내용을 감시 목록으로 변환한다.
 *
 * 날짜가 지난 항목은 오류가 아니라 **건너뛴다** — 사용자가 관람을 마친 뒤 파일을
 * 지우지 않는 것은 자연스러운 일이고, 그것 때문에 나머지 감시가 멈추면 안 된다.
 * 건너뛴 항목은 호출자가 로그로 남길 수 있도록 함께 돌려준다.
 */
export function parseWatchFile(
  raw: unknown,
  userId: string,
  today: string,
): { watches: readonly LoadedWatch[]; skipped: readonly string[] } {
  const parsed = WatchFile.parse(raw);

  const seen = new Set<string>();
  const watches: LoadedWatch[] = [];
  const skipped: string[] = [];

  for (const [index, entry] of parsed.watches.entries()) {
    const key = `${entry.product}:${entry.date}T${entry.time}`;

    if (seen.has(key)) {
      // 중복은 조용히 무시하지 않는다. 사용자가 의도한 것이 아닐 가능성이 높다.
      skipped.push(`${entry.date} ${entry.time} (${entry.product}) — 중복 항목`);
      continue;
    }
    seen.add(key);

    if (entry.date < today) {
      skipped.push(`${entry.date} ${entry.time} — 이미 지난 날짜`);
      continue;
    }

    watches.push({
      id: key,
      userId,
      date: entry.date,
      time: entry.time,
      priority: entry.priority ?? index,
      state: 'WATCHING',
      product: entry.product,
      note: entry.note,
    });
  }

  return { watches, skipped };
}

/**
 * 검증 오류를 폰에서 읽을 수 있는 한국어 메시지로 바꾼다.
 *
 * Zod 기본 출력은 경로가 `watches.0.date` 처럼 나와 어느 줄인지 알기 어렵다.
 * 몇 번째 항목의 어느 필드인지 명시한다.
 */
export function describeWatchFileError(error: unknown): string {
  if (!(error instanceof z.ZodError)) {
    return `watches.json을 읽지 못했습니다: ${error instanceof Error ? error.message : String(error)}`;
  }

  const lines = error.issues.map((issue) => {
    const path = issue.path;
    if (path[0] === 'watches' && typeof path[1] === 'number') {
      const field = path[2] ?? '항목';
      return `- ${path[1] + 1}번째 감시의 \`${String(field)}\`: ${issue.message}`;
    }
    return `- ${issue.message}`;
  });

  return ['watches.json에 문제가 있습니다:', ...lines].join('\n');
}
