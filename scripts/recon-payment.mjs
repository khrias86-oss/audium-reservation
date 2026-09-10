#!/usr/bin/env node
/**
 * 결제 단계 계약 정찰 — **브라우저 없이, 제출 없이.**
 *
 * ## 무엇을 알아내려는가
 *
 * 자동 예약을 만들려면 "예약하기"를 눌렀을 때 사이트가 **어디로 무엇을 보내는지**
 * 알아야 한다. 지금까지의 정찰은 조회까지만 따라갔기 때문에 그 부분이 비어 있다.
 *
 * 답은 사이트가 직접 알려준다. 이 사이트는 화면 조각과 그 조각을 다루는 스크립트를
 * 같이 내려보낸다. 회차 조각에 회차 클릭 핸들러가 붙어 있었던 것처럼, 상품 목록
 * 조각에는 예약 흐름 전체를 굴리는 `booking` 객체가 들어 있다. 그 정의를 읽으면
 * 제출 엔드포인트와 파라미터가 그대로 드러난다.
 *
 * ## 무엇을 하지 않는가
 *
 * - **어떤 제출도 하지 않는다.** 예약을 생성할 수 있는 요청은 보내지 않는다.
 * - 기본값은 조회용 조각만 읽는 것이다.
 * - `PROBE_PAYMENT_FORM=1`을 명시해야만 `/booking/payment`를 **렌더 목적으로**
 *   한 번 호출한다. 이 호출은 결제 화면을 그려줄 뿐 예약을 만들지 않는다
 *   (예약은 그 화면의 `#btn_reserve`를 눌러야 생긴다 — 우리는 누르지 않는다).
 * - `contract.ts`도 `docs/`도 건드리지 않는다. 결과는 사람이 검토해 채운다.
 */
import { writeFileSync, mkdirSync } from 'node:fs';

const ORIGIN = 'https://audeum.org';
const OUT = 'recon-output';
mkdirSync(OUT, { recursive: true });

const report = [];
const log = (line) => { console.log(line); report.push(line); };

const FORM_HEADERS = {
  'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
  referer: `${ORIGIN}/booking`,
  'x-requested-with': 'XMLHttpRequest',
};

async function post(path, body) {
  const started = Date.now();
  const res = await fetch(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: FORM_HEADERS,
    body,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  return { status: res.status, text, ms: Date.now() - started };
}

/** `<script>` 안의 내용만 뽑는다. 화면 마크업은 이미 아는 것이라 노이즈다. */
function scripts(html) {
  return [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
}

/** 요청을 보내는 코드 조각만 골라낸다 — 이게 우리가 찾는 계약이다. */
function requestCalls(source) {
  const found = [];
  const patterns = [
    /\$\.ajax\s*\(\s*\{[\s\S]{0,900}?\}\s*\)/g,
    /\$\.post\s*\([\s\S]{0,600}?\)\s*;/g,
    /\$\.get\s*\([\s\S]{0,600}?\)\s*;/g,
    /url\s*:\s*["'][^"']+["']/g,
  ];
  for (const p of patterns) for (const m of source.matchAll(p)) found.push(m[0]);
  return found;
}

/** 함수 정의를 이름으로 찾아 통째로 꺼낸다. 중괄호를 세어 끝을 찾는다. */
function functionBody(source, name) {
  const start = source.indexOf(name);
  if (start === -1) return null;
  const open = source.indexOf('{', start);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < source.length && i < open + 6000; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return source.slice(start, start + 3000);
}

async function main() {
  log(`# 결제 단계 계약 정찰\n\n생성 시각(UTC): ${new Date().toISOString()}\n`);
  log('이 실행은 브라우저를 쓰지 않고, 어떤 예약도 제출하지 않는다.\n');

  // --- 1. HTTP만으로 조회가 되는지 다시 확인하고, 실제 소요 시간을 잰다 ---
  log('## 1 — 조회 속도 실측 (브라우저 없이)\n');
  const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  const timeBody = `locale=ko&spectateDate=${today}&seqExhibition=1&language=ko`;
  try {
    const r = await post('/booking/time', timeBody);
    log(`POST /booking/time → ${r.status}, ${r.text.length}자, **${r.ms}ms**`);
    const slots = [...r.text.matchAll(/<spectate_time[^>]*>([^<]+)</g)].map((m) => m[1].trim());
    // 클래스가 붙은 자리만 센다. 조각 끝의 클릭 핸들러에도 같은 문자열이 나오므로
    // 단순히 세면 실제보다 많이 나온다 (1차 프로브가 회차 1개에 매진 2개로 나온 이유).
    const soldOut = (r.text.match(/class="[^"]*disabled-time-slots/g) ?? []).length;
    log(`회차 ${slots.length}개 (${slots.join(', ') || '없음'}), 그 중 매진 ${soldOut}개`);
    writeFileSync(`${OUT}/time-fragment.html`, r.text);
  } catch (e) {
    log(`조회 실패: ${e.message}`);
  }

  // --- 2. 예약 오픈 공지 (언제 폴링해야 의미가 있는지 알려준다) ---
  log('\n## 2 — 사이트가 공지한 예약 오픈/가능일\n');
  try {
    const r = await post('/booking/date', 'locale=ko&seqExhibition=1&language=ko');
    writeFileSync(`${OUT}/date-fragment.html`, r.text);
    const plain = r.text.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
    const notice = plain.match(/\[다음 예약일 안내\][\s\S]{0,400}/);
    log('```\n' + (notice ? notice[0] : plain.slice(0, 600)) + '\n```');
  } catch (e) {
    log(`날짜 조각 조회 실패: ${e.message}`);
  }

  // --- 3. 앱 번들 — 예약 흐름을 굴리는 booking 객체가 여기 있다 ---
  //
  // 1차 프로브에서 조각들의 인라인 스크립트를 뒤졌지만 `booking.selPayment` 정의가
  // 없었다. 조각의 스크립트는 그 조각의 클릭 핸들러만 갖고 있고, 흐름 자체는
  // Angular 앱 번들에 컴파일되어 있다. 번들은 압축돼 있어도 **문자열 리터럴은
  // 살아남는다** — 엔드포인트 경로와 파라미터 이름이 거기 그대로 있다.
  //
  // 공개된 정적 파일을 읽을 뿐이므로 사이트에 어떤 부담도 주지 않고, 제출과도 무관하다.
  log('\n## 3 — 앱 번들에서 제출 계약 찾기\n');
  try {
    const shell = await fetch(`${ORIGIN}/booking`, { signal: AbortSignal.timeout(20_000) });
    const shellHtml = await shell.text();
    writeFileSync(`${OUT}/booking-shell.html`, shellHtml);

    const srcs = [...shellHtml.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]);
    log(`번들 후보 ${srcs.length}개: ${srcs.map((s) => `\`${s}\``).join(', ') || '(없음)'}`);

    for (const src of srcs) {
      const url = src.startsWith('http') ? src : `${ORIGIN}/${src.replace(/^\//, '')}`;
      if (!url.startsWith(ORIGIN)) continue; // 외부 스크립트는 우리 관심사가 아니다
      let code = '';
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
        code = await r.text();
      } catch (e) {
        log(`- ${url} 실패: ${e.message}`);
        continue;
      }
      log(`\n### ${url} — ${code.length}자`);
      writeFileSync(`${OUT}/bundle-${url.split('/').pop()}`, code);

      // 예약 흐름 경로가 나오는 자리를 앞뒤 맥락과 함께 보여준다.
      // 압축된 코드는 줄바꿈이 없으므로 문자 단위로 잘라야 읽을 수 있다.
      const hits = [];
      for (const m of code.matchAll(/["'](\/(?:booking|programs)\/[a-zA-Z]+)["']/g)) {
        const at = m.index ?? 0;
        hits.push({ path: m[1], ctx: code.slice(Math.max(0, at - 420), at + 420) });
      }
      const byPath = new Map();
      for (const h of hits) if (!byPath.has(h.path)) byPath.set(h.path, h.ctx);
      for (const [path, ctx] of byPath) {
        log(`\n**\`${path}\`**`);
        log('```js\n' + ctx.replace(/`/g, "'") + '\n```');
      }

      for (const kw of ['spectatorNm', 'seqExhibitionReserve', 'NetFunnel', 'reserveComplete']) {
        const at = code.indexOf(kw);
        if (at === -1) continue;
        log(`\n**\`${kw}\` 주변**`);
        log('```js\n' + code.slice(Math.max(0, at - 500), at + 500).replace(/`/g, "'") + '\n```');
      }
    }
  } catch (e) {
    log(`번들 조사 실패: ${e.message}`);
  }

  // --- 3b. 조각의 인라인 스크립트 ---
  log('\n## 3 — 예약 흐름 스크립트 (제출 엔드포인트를 찾는다)\n');
  const fragments = [
    ['/booking/exhbition', 'locale=ko&language=ko'],
    ['/booking/age', 'locale=ko&seqExhibition=1&language=ko'],
  ];

  const allSource = [];
  for (const [path, body] of fragments) {
    try {
      const r = await post(path, body);
      writeFileSync(`${OUT}/fragment${path.replace(/\//g, '-')}.html`, r.text);
      const src = scripts(r.text).join('\n');
      allSource.push(src);
      log(`\n### ${path} → ${r.status}, 마크업 ${r.text.length}자, 스크립트 ${src.length}자`);

      const calls = [...new Set(requestCalls(src))];
      if (calls.length === 0) log('- 요청 코드 없음');
      for (const c of calls) log('```js\n' + c.trim().slice(0, 700) + '\n```');
    } catch (e) {
      log(`\n### ${path} 조회 실패: ${e.message}`);
    }
  }

  const source = allSource.join('\n');
  log('\n### 이름으로 찾은 함수들\n');
  for (const name of ['selPayment', 'reserve =', 'reserveInsert', 'goReserve', 'btn_reserve', 'NetFunnel_Action']) {
    const body = functionBody(source, name);
    log(`\n#### \`${name}\``);
    log(body ? '```js\n' + body.slice(0, 2500) + '\n```' : '- 이 조각에는 없음');
  }

  // --- 4. 결제 화면 렌더 (명시적으로 켰을 때만) ---
  log('\n## 4 — 결제 화면 조각\n');
  if (process.env.PROBE_PAYMENT_FORM !== '1') {
    log('건너뜀. `PROBE_PAYMENT_FORM=1`을 명시해야 실행된다.');
    log('이 호출은 화면을 그릴 뿐 예약을 만들지 않지만, 예약 흐름에 한 걸음 더 들어가므로 기본값은 끔이다.');
  } else {
    const seq = process.env.PROBE_RESERVE_SEQ ?? '';
    if (!seq) {
      log('`PROBE_RESERVE_SEQ`(회차의 seq_reserve 값)가 필요하다. 건너뛴다.');
    } else {
      try {
        const r = await post('/booking/payment', `locale=ko&seqExhibitionReserve=${seq}&seqExhibition=1&language=ko`);
        writeFileSync(`${OUT}/payment-fragment.html`, r.text);
        log(`POST /booking/payment → ${r.status}, ${r.text.length}자`);
        const src = scripts(r.text).join('\n');
        log(`스크립트 ${src.length}자`);
        for (const c of [...new Set(requestCalls(src))]) log('```js\n' + c.trim().slice(0, 900) + '\n```');
        const ids = [...new Set([...r.text.matchAll(/id=["']([^"']+)["']/g)].map((m) => m[1]))];
        log(`\n입력 요소 id: ${ids.map((i) => `\`${i}\``).join(', ') || '(없음)'}`);
      } catch (e) {
        log(`결제 조각 조회 실패: ${e.message}`);
      }
    }
  }

  log('\n---\n이 스크립트는 어떤 예약도 제출하지 않았고, contract.ts나 docs/도 건드리지 않았다.');
  writeFileSync(`${OUT}/RECON_REPORT.md`, report.join('\n'));
}

main().catch((e) => {
  writeFileSync(`${OUT}/RECON_REPORT.md`, report.join('\n') + `\n\n## 오류로 중단\n\n${e.stack}`);
  console.error(e);
  process.exit(1);
});
