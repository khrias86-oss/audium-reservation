#!/usr/bin/env node
/**
 * M1 정찰 스크립트 — GitHub Actions 러너에서 실행된다.
 *
 * 이 스크립트를 만든 Claude Code 세션은 audeum.org에 접근할 수 없었다
 * (네트워크 egress 정책 차단). GitHub Actions 러너는 별개의 네트워크를 쓰므로
 * 여기서 실행한다. PC도, 세션 차단 우회도 필요 없다 — 애초에 다른 인프라다.
 *
 * 이 스크립트는 절대 예약을 제출하지 않는다:
 *   - "예약/신청/제출/결제/확인/다음/완료/로그인"류 텍스트를 가진 요소는 클릭하지 않는다
 *   - 숫자(날짜로 추정되는) 텍스트를 가진 요소만, 그것도 최대 6개까지만 클릭한다
 *   - 어떤 입력 필드에도 값을 채우지 않는다
 *
 * 출력은 전부 recon-output/ 에 저장되고 워크플로가 아티팩트로 업로드한다.
 * 이 스크립트는 docs/site-contract.md나 contract.ts를 직접 고치지 않는다 —
 * 결과를 사람(또는 이어서 작업하는 Claude 세션)이 검토한 뒤 채운다.
 */
import { chromium } from 'playwright';
import { writeFileSync, readFileSync, mkdirSync, appendFileSync } from 'node:fs';

const BASE = 'https://audeum.org';
const BOOKING_URL = `${BASE}/booking`;
const OUT = 'recon-output';
mkdirSync(OUT, { recursive: true });

const DANGEROUS_TEXT = /예약하기|예약신청|신청하기|제출|결제|확인|다음|완료|로그인|가입|취소하기|submit|confirm|pay|complete|login|sign\\s*up|checkout/i;
const DATE_LIKE = /^\s*(0?[1-9]|[12]\d|3[01])\s*$/;

const report = [];
const log = (line) => {
  console.log(line);
  report.push(line);
};

const networkLog = [];
const netStream = `${OUT}/network-log.jsonl`;
writeFileSync(netStream, '');

async function main() {
  log(`# 오디움 정찰 리포트\n\n생성 시각(UTC): ${new Date().toISOString()}\n`);

  // --- 단계 0: 준수 확인 (가장 먼저, 가장 중요) ---
  log('## 단계 0 — robots.txt / 준수 확인\n');
  let robotsText = '';
  let robotsVerdict = 'UNKNOWN';
  let robotsReason = '';

  try {
    const res = await fetch(`${BASE}/robots.txt`, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; personal-use-recon)' } });
    robotsText = await res.text();
    writeFileSync(`${OUT}/robots.txt`, robotsText);
    log(`robots.txt 상태: ${res.status}`);
    log('```\n' + robotsText.slice(0, 3000) + '\n```\n');

    // RFC 9309의 관례를 따른다. 응답을 못 받았거나 오류라면 "허용"으로 해석하지 않는다.
    //
    // 이 검사가 중요한 이유: 프록시나 방화벽은 403과 함께 안내 문구를 본문으로 준다.
    // 그 본문에는 Disallow 줄이 없으므로, 상태 코드를 안 보면 "차단 조항 없음 = 허용"
    // 이라는 정반대 결론이 나온다. 실제로 이 스크립트를 처음 돌렸을 때 그렇게 됐다.
    if (res.status === 404 || res.status === 410) {
      robotsVerdict = 'ALLOWED';
      robotsReason = 'robots.txt가 존재하지 않음 (404/410) — 관례상 제한 없음';
    } else if (res.status >= 400) {
      robotsVerdict = 'BLOCKED';
      robotsReason = `robots.txt를 읽을 수 없음 (HTTP ${res.status}). 접근이 제한됐거나 중간 프록시가 가로챈 것으로, 허용으로 해석해서는 안 됨`;
    } else if (res.status >= 300) {
      robotsVerdict = 'BLOCKED';
      robotsReason = `예상치 못한 리다이렉트 응답 (HTTP ${res.status}) — 사람이 확인 필요`;
    } else if (!/user-?agent\s*:/i.test(robotsText) && robotsText.trim() !== '') {
      // 200인데 robots.txt 문법이 전혀 없다면 오류 페이지를 받은 것이다.
      robotsVerdict = 'BLOCKED';
      robotsReason = '200 응답이지만 robots.txt 문법(User-agent:)이 없음 — 오류 페이지를 받은 것으로 보임';
    } else {
      const lines = robotsText.split('\n').map((l) => l.trim());
      let inWildcardBlock = false;
      let disallowsBooking = false;
      for (const line of lines) {
        if (/^user-agent:\s*\*/i.test(line)) inWildcardBlock = true;
        else if (/^user-agent:/i.test(line)) inWildcardBlock = false;
        else if (inWildcardBlock && /^disallow:/i.test(line)) {
          const path = line.split(':').slice(1).join(':').trim();
          if (path === '/' || (path && BOOKING_URL.includes(path))) disallowsBooking = true;
        }
      }
      robotsVerdict = disallowsBooking ? 'BLOCKED' : 'ALLOWED';
      robotsReason = disallowsBooking
        ? '/booking(또는 전체)에 대한 Disallow 조항을 찾음'
        : '/booking을 막는 Disallow 조항 없음';
    }
  } catch (e) {
    robotsVerdict = 'BLOCKED';
    robotsReason = `robots.txt 조회 자체가 실패함 (${e.message}) — 확인하지 못한 것을 허용으로 간주하지 않음`;
  }

  log(`**판정: ${robotsVerdict}** — ${robotsReason}\n`);

  if (robotsVerdict !== 'ALLOWED') {
    log('\n**⛔ 정찰을 여기서 중단합니다.**');
    log('robots.txt를 확인하지 못했거나 자동화된 접근이 금지되어 있습니다.');
    log('사람이 직접 사이트와 이용약관을 확인한 뒤 진행 여부를 결정해야 합니다. 우회하지 마세요.');
    writeFileSync(`${OUT}/RECON_REPORT.md`, report.join('\n'));
    process.exit(0); // 실패가 아니라 "의도적으로 멈춤" — 리포트가 이유를 설명한다.
  }
  log('robots.txt 검사를 통과했습니다. **단, 이것이 이용약관 확인을 대체하지 않습니다 — 사람이 별도로 확인해야 합니다.**\n');

  // --- 단계 1: 정적 표면 ---
  log('## 단계 1 — 정적 표면\n');
  let staticHtml = '';
  try {
    const res = await fetch(BOOKING_URL, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; personal-use-recon)' } });
    staticHtml = await res.text();
    writeFileSync(`${OUT}/static.html`, staticHtml);
    log(`상태 코드: ${res.status}`);
    log(`Server 헤더: ${res.headers.get('server') ?? '(없음)'}`);
    log(`Content-Length: ${staticHtml.length}자`);

    const markers = ['__NEXT_DATA__', '__NUXT__', '__INITIAL_STATE__', 'window.__remixContext', 'react', 'vue', 'nuxt', 'next'];
    for (const m of markers) {
      if (staticHtml.includes(m)) log(`- 프레임워크 지문 발견: \`${m}\``);
    }
    const rootMatch = staticHtml.match(/<div id="(root|app|__next|__nuxt)"[^>]*>([\s\S]{0,200})/);
    if (rootMatch) {
      const inner = rootMatch[2].trim();
      log(`- #${rootMatch[1]} 내부 초기 콘텐츠: ${inner.length < 20 ? '**거의 비어 있음 → SPA 가능성 높음**' : `${inner.length}자 있음 → SSR 가능성`}`);
    }
  } catch (e) {
    log(`정적 HTML 조회 실패: ${e.message}`);
  }

  // --- 단계 2~3: Playwright로 후보 경로 탐색 + 네트워크 캡처 ---
  //
  // 1차 정찰에서 /booking 응답이 1,746자뿐이고 /programs/booking, /booking/exhbition
  // 으로 이동하는 정황이 잡혔다. /booking은 입구일 뿐 실제 예약 UI가 아니라는 뜻이므로,
  // 후보 경로를 모두 열어보고 어디에 실물이 있는지 확인한다.
  log('\n## 단계 2~3 — 후보 경로 탐색\n');

  // 2차 정찰에서 /booking이 "티켓 종류 선택" 페이지임이 확인됐다.
  // EXHIBITIONS / LECTURE 두 항목이 있고, 하위 페이지에 직접 들어가면 본문이
  // 33~46자에 제목도 비어 있었다 — 필요한 파라미터 없이 들어가서 캘린더가
  // 렌더되지 않은 것으로 보인다. 그래서 실제 사용자 흐름대로 링크를 추출해 따라간다.
  const START = `${BASE}/booking`;

  const browser = await chromium.launch();
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (compatible; personal-use-recon)',
    viewport: { width: 1280, height: 2400 },
  });
  const page = await context.newPage();

  let currentPhase = 'init';
  page.on('request', (req) => {
    if (['xhr', 'fetch', 'document'].includes(req.resourceType())) {
      networkLog.push({ phase: currentPhase, t: 'req', method: req.method(), url: req.url() });
    }
  });
  page.on('response', async (res) => {
    const type = res.request().resourceType();
    if (['xhr', 'fetch', 'document'].includes(type)) {
      let body = null;
      try {
        const ct = res.headers()['content-type'] ?? '';
        if (ct.includes('json')) body = (await res.text()).slice(0, 6000);
      } catch { /* 본문을 못 읽어도 나머지는 유효하다 */ }
      const entry = { phase: currentPhase, t: 'res', type, url: res.url(), status: res.status(), body };
      networkLog.push(entry);
      appendFileSync(netStream, JSON.stringify(entry) + '\n');
    }
  });

  // 렌더가 늦게 끝나는 페이지를 놓치지 않도록, 로드 후 한 번 더 기다렸다가 읽는다.
  // networkidle은 네트워크만 보므로 클라이언트 렌더가 진행 중이어도 즉시 발생한다.
  async function inspect(label) {
    await page.waitForTimeout(3_000);
    const url = page.url();
    const title = await page.title().catch(() => '');
    const text = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
    const html = await page.content().catch(() => '');
    const frames = page.frames().filter((f) => f !== page.mainFrame());

    log(`\n### ${label}`);
    log(`- URL: ${url}`);
    log(`- 제목: ${title || '(없음)'}`);
    log(`- 본문 텍스트 ${text.length}자 / HTML ${html.length}자`);
    log(`- iframe ${frames.length}개${frames.length ? ': ' + frames.map((f) => f.url()).join(', ') : ''}`);

    // 텍스트는 짧은데 HTML이 크면, DOM에는 있지만 화면에 안 보이는 상태다.
    if (html.length > 20_000 && text.length < 200) {
      log('- ⚠️ HTML은 큰데 보이는 텍스트가 적다 → 탭/아코디언에 숨겨졌거나 렌더 미완료');
    }

    if (text.length > 0) {
      log('```');
      log(text.slice(0, 2000).replace(/\n{3,}/g, '\n\n'));
      log('```');
    }

    const slug = label.replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 40);
    writeFileSync(`${OUT}/${slug}.html`, html);
    await page.screenshot({ path: `${OUT}/${slug}.png`, fullPage: true }).catch(() => {});
    return { url, title, text, html };
  }

  currentPhase = 'booking';
  log('\n## 단계 2 — 시작 페이지\n');
  await page.goto(START, { waitUntil: 'networkidle', timeout: 40_000 }).catch((e) => log(`로드 실패: ${e.message}`));
  await inspect('booking (시작)');

  // 링크 전수 조사 — 티켓 종류가 실제로 어디를 가리키는지가 여기서 드러난다.
  log('\n## 페이지 내 링크 전수 조사\n');
  const links = await page.$$eval('a[href]', (as) =>
    as.map((a) => ({ text: (a.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 60), href: a.href })),
  ).catch(() => []);

  const seen = new Set();
  const unique = links.filter((l) => !seen.has(l.href) && seen.add(l.href));
  log(`총 ${unique.length}개:`);
  for (const l of unique) log(`- [${l.text || '(텍스트 없음)'}] → ${l.href}`);

  // 예약 흐름으로 이어질 만한 링크만 추린다.
  // 3차 정찰에서 이 필터가 네비게이션 링크(/programs, /exhibitions)에 낚였다.
  // 그 둘은 소개 페이지일 뿐 예약 화면이 아니다. 경로에 booking이 들어간 링크를
  // 먼저 보고, 그 다음에야 나머지 후보를 본다.
  const isBookingPath = (href) => /\/booking|booking\/|reserv|ticket/i.test(href);
  const isNavPage = (href) => /\/(programs|exhibitions|about|visit)\/?$/i.test(href);

  const internal = unique.filter((l) => l.href.startsWith(BASE) && !/^mailto:|^tel:/.test(l.href));
  const promising = [
    ...internal.filter((l) => isBookingPath(l.href)),
    ...internal.filter((l) => !isBookingPath(l.href) && !isNavPage(l.href)),
  ];
  log(`\n예약 경로 우선 후보 ${promising.length}개 (booking 포함 ${internal.filter((l) => isBookingPath(l.href)).length}개)`);

  const pageReports = [];
  for (const link of promising.slice(0, 6)) {
    currentPhase = link.href;
    try {
      await page.goto(link.href, { waitUntil: 'networkidle', timeout: 40_000 });
      const r = await inspect(`${link.text || '링크'} → ${link.href.replace(BASE, '')}`);
      pageReports.push({ ...r, textLength: r.text.length });
    } catch (e) {
      log(`\n### ${link.href}\n- 로드 실패: ${e.message.split('\n')[0]}`);
    }
  }

  // 내용이 가장 많은 페이지에서만 상호작용한다. 빈 껍데기를 클릭해봐야 의미가 없다.
  const richest = pageReports.sort((a, b) => b.textLength - a.textLength)[0];

  // 상호작용 단계가 죽어도 아래의 JSON 응답·요약 섹션은 남겨야 한다.
  // 3차 실행에서 여기서 던진 예외 하나가 리포트 후반부를 통째로 날렸다.
  try {
  if (richest && richest.textLength > 0) {
    log(`\n## 상호작용 대상: ${richest.url} (본문 ${richest.textLength}자)\n`);
    currentPhase = 'interact';
    await page.goto(richest.url, { waitUntil: 'networkidle', timeout: 40_000 }).catch(() => {});

    const candidates = await page.$$eval('button, td, div, span, a, li', (els) =>
      els
        .filter((el) => el.children.length === 0)
        .map((el) => ({ text: (el.textContent ?? '').trim(), tag: el.tagName }))
        .filter((c) => c.text.length > 0 && c.text.length < 5),
    ).catch(() => []);

    const dateLike = candidates.filter((c) => DATE_LIKE.test(c.text) && !DANGEROUS_TEXT.test(c.text));
    log(`날짜로 추정되는 클릭 후보: ${dateLike.length}개 (최대 6개만 시도)`);

    let clicked = 0;
    for (const cand of dateLike.slice(0, 20)) {
      if (clicked >= 6) break;
      const before = networkLog.length;
      try {
        const locator = page.locator(cand.tag.toLowerCase())
          .filter({ hasText: new RegExp(`^\\s*${cand.text}\\s*$`) }).first();
        if (await locator.isDisabled().catch(() => false)) {
          log(`- "${cand.text}" 비활성 — 매진/휴관 신호일 수 있음`);
          continue;
        }
        await locator.click({ timeout: 3_000 });
        await page.waitForTimeout(1_500);
        clicked++;
        log(`- "${cand.text}" 클릭 → 새 요청 ${networkLog.length - before}건`);
        await page.screenshot({ path: `${OUT}/click-${clicked}.png`, fullPage: true }).catch(() => {});
      } catch (e) {
        log(`- "${cand.text}" 클릭 실패: ${e.message.split('\n')[0]}`);
      }
    }

    log('\n## 매진·여석 텍스트 신호 스캔\n');
    const signals = await page.evaluate(() => {
      const body = document.body?.innerText ?? '';
      const patterns = ['마감', '매진', '예약마감', '신청불가', '잔여', '남음', '가능', '예약', '회차', 'SOLD'];
      return patterns.map((p) => ({ p, n: (body.match(new RegExp(p, 'gi')) || []).length }));
    }).catch(() => []);
    for (const { p, n } of signals) if (n > 0) log(`- "${p}": ${n}회`);

    const disabledCount = await page.locator('[disabled], [aria-disabled="true"], .disabled, .sold-out').count().catch(() => 0);
    log(`- disabled 계열 셀렉터 매칭: ${disabledCount}개`);
  } else {
    log('\n**모든 후보 경로에서 본문 텍스트를 얻지 못했습니다.** 로그인이 필요하거나 봇 차단이 있을 수 있습니다.');
  }
  } catch (e) {
    log(`\n**상호작용 단계에서 오류 발생:** ${e.message}`);
    log('아래 섹션은 그대로 유효하니 참고하세요.');
  }

  await browser.close();

  writeFileSync(`${OUT}/network-log-full.json`, JSON.stringify(networkLog, null, 2));

  // --- 유망한 JSON 응답을 리포트에 직접 싣는다 ---
  //
  // 아티팩트(zip)를 받지 않고 로그만으로도 사이트 계약을 확정할 수 있어야 한다.
  // 예약 가능 여부와 관련돼 보이는 응답은 본문을 잘라서 그대로 남긴다.
  log('\n## 유망한 JSON 응답 (계약 확정용 원본)\n');
  const INTERESTING = /date|day|time|slot|seat|remain|capacity|avail|reserv|book|schedule|round|status|sold|stock|quota|ticket/i;

  const looksLikeJson = (n) =>
    n.t === 'res' && typeof n.body === 'string' && /^\s*[[{]/.test(n.body);

  const jsonResponses = networkLog
    .filter(looksLikeJson)
    .map((n) => {
      let parsed = null;
      try { parsed = JSON.parse(n.body); } catch { /* JSON이 아니면 아래에서 걸러진다 */ }
      return { url: n.url, status: n.status, body: n.body, parsed };
    })
    .filter((r) => r.parsed !== null);

  const scored = jsonResponses
    .map((r) => {
      // 키 이름과 값에 예약 관련 어휘가 얼마나 등장하는지로 순위를 매긴다.
      const keys = JSON.stringify(r.parsed).match(/"[^"]{1,40}"\s*:/g) ?? [];
      const hits = keys.filter((k) => INTERESTING.test(k)).length;
      return { ...r, hits };
    })
    .sort((a, b) => b.hits - a.hits);

  if (scored.length === 0) {
    log('JSON 응답을 하나도 캡처하지 못했습니다. SSR이거나, 슬롯 정보가 HTML에 직접 박혀 있을 수 있습니다.');
    log('그 경우 아래 "렌더된 HTML 발췌"를 근거로 판단해야 합니다.');
  }

  for (const r of scored.slice(0, 6)) {
    log(`\n### ${r.status} ${r.url}`);
    log(`예약 관련 키 매칭 수: ${r.hits}`);
    log('```json');
    log(r.body.length > 2500 ? r.body.slice(0, 2500) + '\n... (이하 생략, 전문은 아티팩트 참조)' : r.body);
    log('```');
  }

  // --- 렌더된 HTML에서 예약 관련 부분만 발췌 ---
  //
  // JSON API가 없으면 이 발췌가 유일한 근거가 된다.
  log('\n## 렌더된 HTML 발췌 (예약 관련 부분)\n');
  let rendered = '';
  try { rendered = readFileSync(`${OUT}/page_programs_booking.html`, 'utf8'); } catch { /* 아래에서 안내한다 */ }
  if (rendered) {
    // 회차 시각처럼 보이는 텍스트 주변을 잘라서 보여준다.
    const timePattern = /\d{1,2}\s*:\s*\d{2}/g;
    const positions = [...rendered.matchAll(timePattern)].slice(0, 8).map((m) => m.index ?? 0);
    if (positions.length === 0) {
      log('렌더된 HTML에서 HH:MM 형태의 회차 시각을 찾지 못했습니다.');
    }
    for (const pos of positions) {
      const excerpt = rendered.slice(Math.max(0, pos - 400), pos + 400).replace(/\s+/g, ' ');
      log('```html');
      log(excerpt);
      log('```');
    }
  } else {
    log('렌더된 HTML을 저장하지 못했습니다.');
  }

  // --- 요약 ---
  log('\n## 요약\n');
  const uniqueEndpoints = [...new Set(networkLog.filter((n) => n.t === 'req').map((n) => n.url.split('?')[0]))];
  log(`고유 xhr/fetch 엔드포인트 ${uniqueEndpoints.length}개:`);
  for (const url of uniqueEndpoints) log(`- ${url}`);

  log('\n**이 리포트는 사람(또는 다음 Claude 세션)이 검토해 `docs/site-contract.md`를 채우는 데 쓰인다.**');
  log('이 스크립트는 어떤 형태의 제출도 하지 않았고, `contract.ts`도 건드리지 않았다.');

  writeFileSync(`${OUT}/RECON_REPORT.md`, report.join('\n'));
  console.log('\n✅ 정찰 완료. recon-output/ 아티팩트를 확인하세요.');
}

main().catch((e) => {
  console.error('정찰 스크립트 오류:', e);
  writeFileSync(`${OUT}/RECON_REPORT.md`, report.join('\n') + `\n\n## 오류로 중단됨\n\n${e.stack}`);
  process.exit(1);
});
