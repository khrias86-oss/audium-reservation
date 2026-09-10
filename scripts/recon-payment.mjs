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

    // 먼저 페이지 자신의 인라인 스크립트를 본다. 2차 프로브가 외부 번들만 뒤졌는데,
    // 이 사이트가 외부로 내보내는 것은 공통 유틸과 NetFunnel SDK뿐이었다.
    // 예약 흐름을 굴리는 `booking` 객체는 페이지에 인라인으로 박혀 있다 —
    // 조각들이 `booking.selPayment(seq)`를 부르는데 조각 어디에도 정의가 없었으니,
    // 남는 자리는 부모 페이지밖에 없다.
    const inline = scripts(shellHtml).join('\n');
    log(`인라인 스크립트 ${inline.length}자, 외부 스크립트 후보 확인 중\n`);
    writeFileSync(`${OUT}/booking-inline.js`, inline);

    const sources = [['(/booking 인라인)', inline]];

    // /booking 의 인라인 스크립트는 1,011자짜리 NetFunnel 게이트 하나뿐이었다.
    // 11차 정찰이 센 20,473자는 조각들이 주입된 **렌더 후** DOM의 것이었으므로,
    // 흐름을 굴리는 `booking` 객체는 조각을 내려주는 다른 문서에 있다.
    // 그 후보를 문서로 직접 받아 본다 — 조회일 뿐 제출과 무관하다.
    for (const path of ['/booking/exhbition', '/programs/booking', '/booking/date', '/booking/age']) {
      try {
        const r = await fetch(`${ORIGIN}${path}`, {
          headers: { referer: `${ORIGIN}/booking` },
          signal: AbortSignal.timeout(20_000),
        });
        const html = await r.text();
        writeFileSync(`${OUT}/doc${path.replace(/\//g, '-')}.html`, html);
        sources.push([`GET ${path} (${r.status})`, scripts(html).join('\n')]);
      } catch (e) {
        log(`- GET ${path} 실패: ${e.message}`);
      }
    }

    const srcs = [...shellHtml.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]);
    log(`외부 스크립트 ${srcs.length}개: ${srcs.map((x) => `\`${x}\``).join(', ') || '(없음)'}`);
    for (const src of srcs) {
      const url = src.startsWith('http') ? src : `${ORIGIN}/${src.replace(/^\//, '')}`;
      if (!url.startsWith(ORIGIN)) continue;
      if (/netfunnel|skin/i.test(url)) { log(`- ${url} 건너뜀 (NetFunnel SDK — 우리 계약이 아니다)`); continue; }
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
        sources.push([url, await r.text()]);
      } catch (e) {
        log(`- ${url} 실패: ${e.message}`);
      }
    }

    for (const [name, code] of sources) {
      log(`\n### ${name} — ${code.length}자`);

      // 예약 흐름 경로가 나오는 자리를 앞뒤 맥락과 함께 보여준다.
      const seen = new Map();
      for (const m of code.matchAll(/["'](\/(?:booking|programs)\/[a-zA-Z]+)["']/g)) {
        const at = m.index ?? 0;
        if (!seen.has(m[1])) seen.set(m[1], code.slice(Math.max(0, at - 500), at + 700));
      }
      if (seen.size === 0) log('- 예약 경로 리터럴 없음');
      for (const [path, ctx] of seen) {
        log(`\n**\`${path}\`**`);
        log('```js\n' + ctx.replace(/`/g, "'") + '\n```');
      }

      // 이름으로 흐름 함수를 통째로 꺼낸다. 압축돼 있어도 중괄호는 셀 수 있다.
      for (const name2 of ['selPayment', 'selTime', 'selDate', 'reserve = function', 'fn_reserve', 'insertReserve']) {
        const body = functionBody(code, name2);
        if (!body) continue;
        log(`\n**\`${name2}\` 정의**`);
        log('```js\n' + body.slice(0, 2200).replace(/`/g, "'") + '\n```');
      }

      for (const kw of ['spectatorNm', 'spectatorEmail', 'seqExhibitionReserve', 'btn_reserve', 'com.submit', 'var booking']) {
        const at = code.indexOf(kw);
        if (at === -1) continue;
        log(`\n**\`${kw}\` 주변**`);
        log('```js\n' + code.slice(Math.max(0, at - 600), at + 800).replace(/`/g, "'") + '\n```');
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
    // 회차 조각에서 seq를 그대로 뽑아 쓴다. 사람이 손으로 옮겨 적으면 틀린 회차를
    // 가리킬 수 있고, 그건 예약 흐름에서 가장 위험한 종류의 실수다.
    //
    // 오늘 날짜만 보면 실패하기 쉽다. 지난 회차는 조각에서 빠지므로 오후에 돌리면
    // 0개가 나온다. 그래서 앞으로 3주의 목·금·토를 훑어 회차가 있는 첫 날을 쓴다.
    let seq = process.env.PROBE_RESERVE_SEQ ?? '';
    let date = today;

    if (!seq) {
      const candidates = [];
      for (let i = 0; i < 22 && candidates.length < 8; i++) {
        const d = new Date(Date.now() + 9 * 3600_000 + i * 86_400_000);
        if ([4, 5, 6].includes(d.getUTCDay())) candidates.push(d.toISOString().slice(0, 10));
      }
      log(`회차를 찾을 날짜 후보: ${candidates.join(', ')}`);
      for (const d of candidates) {
        const probe = await post('/booking/time', `locale=ko&spectateDate=${d}&seqExhibition=1&language=ko`)
          .catch(() => null);
        const m = probe?.text.match(/<seq_reserve[^>]*>([^<]+)</);
        if (m) { seq = m[1].trim(); date = d; break; }
      }
      log(seq ? `${date} 회차에서 seq_reserve=${seq} 를 얻었다.` : '앞으로 3주 안에 회차가 하나도 없다.');
    }

    if (!seq) {
      log('회차가 없어 결제 화면을 열 수 없다. 예약이 열린 뒤 다시 돌린다.');
    } else {
      // 4차 프로브가 /programs/booking 문서에서 흐름 전체를 읽어냈다. 렉처 쪽은
      //   programs.selPayment = function(seqReserve) {
      //     url: "/programs/payment",
      //     param: {"locale": ..., "seqProgramReserveList": seqReserve}
      //   }
      // 이고, 전시 쪽은 대칭이다 — 회차 조각의 스크립트가 예약 직전에
      // `booking.seqExhibitionReserveList = 0`을 초기화하는 것이 그 증거다.
      // 그래서 첫 번째 조합이 정답일 가능성이 높고, 나머지는 보험이다.
      const attempts = [
        `locale=ko&seqExhibitionReserveList=${seq}&language=ko`,
        `locale=ko&seqExhibitionReserveList=${seq}&seqExhibition=1&spectateDate=${date}&language=ko`,
        `locale=ko&seqExhibitionReserve=${seq}&seqExhibition=1&language=ko`,
      ];
      for (const body of attempts) {
        let r;
        try { r = await post('/booking/payment', body); }
        catch (e) { log(`- \`${body}\` → 실패: ${e.message}`); continue; }

        log(`\n#### \`${body}\` → ${r.status}, ${r.text.length}자`);
        if (r.status !== 200 || r.text.length < 200) { log('- 빈 응답. 다음 조합을 시도한다.'); continue; }

        writeFileSync(`${OUT}/payment-fragment.html`, r.text);
        const src = scripts(r.text).join('\n');
        const ids = [...new Set([...r.text.matchAll(/id=["']([^"']+)["']/g)].map((m) => m[1]))];
        log(`입력 요소 id: ${ids.map((i) => `\`${i}\``).join(', ') || '(없음)'}`);
        log(`\n**결제 조각 스크립트 ${src.length}자**`);
        log('```js\n' + src.slice(0, 6000).replace(/`/g, "'") + '\n```');
        break; // 통한 조합을 찾았으면 더 두드리지 않는다
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
