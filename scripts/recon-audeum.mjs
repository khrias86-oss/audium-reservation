#!/usr/bin/env node
/**
 * M1 정찰 — GitHub Actions 러너에서 실행된다.
 *
 * 이 스크립트를 만든 Claude Code 세션은 audeum.org에 접근할 수 없다(egress 정책).
 * Actions 러너는 별개 네트워크를 쓰므로 여기서 조사한다. PC가 필요 없다.
 *
 * ## 6차 정찰의 목표: 대기열 통과
 *
 * 5차에서 사이트가 가상 대기열을 운영한다는 것이 드러났다. 혼잡 시 HTTP 200으로
 * "동시접속자가 많아 잠시 대기 중입니다" 페이지를 준다. 2~4차가 예약 페이지를
 * "빈 껍데기"로 본 것은 실제로는 이 대기열 페이지를 읽고 있었기 때문이다.
 *
 * 이번에는 대기열을 인식하고 재시도하면서, **몇 번 만에 통과하는지**를 측정한다.
 * 그 숫자가 폴링 설계를 좌우한다 — 매 틱마다 대기열을 뚫어야 한다면 틱 예산과
 * 재시도 정책이 완전히 달라진다.
 *
 * ## 이 스크립트가 하지 않는 것
 * - 어떤 형태의 예약 제출도 하지 않는다
 * - 예약/신청/제출/결제/확인/다음/완료/로그인 류 요소를 클릭하지 않는다
 * - 어떤 입력 필드도 채우지 않는다
 * - docs/site-contract.md나 contract.ts를 직접 고치지 않는다 (사람이 검토 후 반영)
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync, appendFileSync } from 'node:fs';

const BASE = 'https://audeum.org';
const OUT = 'recon-output';
mkdirSync(OUT, { recursive: true });

const DANGEROUS_TEXT =
  /예약하기|예약신청|신청하기|제출|결제|확인|다음|완료|로그인|가입|취소하기|submit|confirm|pay|complete|login|sign\s*up|checkout/i;
const DATE_LIKE = /^\s*(0?[1-9]|[12]\d|3[01])\s*$/;

/** 사이트가 상품 재클릭을 3초간 무시한다 (8차 정찰에서 확인). */
const ITEM_COOLDOWN_MS = 3_500;

/** 대기열 페이지의 지문. 이 문구는 5차 정찰에서 실제로 관측한 것이다. */
const QUEUE_MARKERS = [
  '동시접속자가 많아',
  'high volume of traffic',
  'Please give us a moment',
];

const report = [];
const log = (line) => { console.log(line); report.push(line); };
const networkLog = [];
const netStream = `${OUT}/network-log.jsonl`;
writeFileSync(netStream, '');

const isQueuePage = (text) => QUEUE_MARKERS.some((m) => text.includes(m));

async function main() {
  log(`# 오디움 정찰 리포트 (6차 — 대기열 통과 시도)\n`);
  log(`생성 시각(UTC): ${new Date().toISOString()}\n`);

  // ─── 단계 0: 준수 확인 ────────────────────────────────────────────────
  log('## 단계 0 — robots.txt / 준수 확인\n');
  let verdict = 'UNKNOWN';
  let reason = '';
  let robotsText = '';

  try {
    const res = await fetch(`${BASE}/robots.txt`, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; personal-use-recon)' },
    });
    robotsText = await res.text();
    writeFileSync(`${OUT}/robots.txt`, robotsText);
    log(`상태: ${res.status}, 본문 ${robotsText.length}자`);

    // 5차에서 알게 된 것: 404 응답이 대기열/오류와 같은 템플릿을 쓴다.
    // 그래서 상태 코드만이 아니라 본문이 실제 robots.txt인지도 확인해야 한다.
    if (isQueuePage(robotsText)) {
      verdict = 'BLOCKED';
      reason = '대기열 페이지가 반환됨 — robots.txt를 실제로 확인하지 못함';
    } else if (res.status === 404 || res.status === 410) {
      verdict = 'ALLOWED';
      reason = 'robots.txt 없음(404/410) — 관례상 제한 없음';
    } else if (res.status >= 300) {
      verdict = 'BLOCKED';
      reason = `robots.txt를 읽을 수 없음 (HTTP ${res.status}) — 허용으로 해석하지 않음`;
    } else if (!/user-?agent\s*:/i.test(robotsText) && robotsText.trim() !== '') {
      verdict = 'BLOCKED';
      reason = '200이지만 robots.txt 문법이 없음 — 오류/대기열 페이지로 보임';
    } else {
      let wildcard = false;
      let blocksBooking = false;
      for (const line of robotsText.split('\n').map((l) => l.trim())) {
        if (/^user-agent:\s*\*/i.test(line)) wildcard = true;
        else if (/^user-agent:/i.test(line)) wildcard = false;
        else if (wildcard && /^disallow:/i.test(line)) {
          const path = line.split(':').slice(1).join(':').trim();
          if (path === '/' || (path && `${BASE}/booking`.includes(path))) blocksBooking = true;
        }
      }
      verdict = blocksBooking ? 'BLOCKED' : 'ALLOWED';
      reason = blocksBooking ? '/booking에 대한 Disallow 조항이 있음' : '/booking을 막는 조항 없음';
    }
  } catch (e) {
    verdict = 'BLOCKED';
    reason = `조회 실패 (${e.message}) — 확인하지 못한 것을 허용으로 간주하지 않음`;
  }

  log(`**판정: ${verdict}** — ${reason}\n`);

  // 대기열 때문에 확인을 못 한 것은 "금지"와 다르다. 그 경우는 계속 진행하되 명시한다.
  if (verdict === 'BLOCKED' && !isQueuePage(robotsText)) {
    log('**⛔ 중단합니다.** 자동화된 접근이 금지되었거나 확인할 수 없습니다. 우회하지 마세요.');
    writeFileSync(`${OUT}/RECON_REPORT.md`, report.join('\n'));
    process.exit(0);
  }
  if (isQueuePage(robotsText)) {
    log('⚠️ robots.txt 자리에 대기열 페이지가 왔습니다. 아래에서 대기열을 통과한 뒤 재확인이 필요합니다.\n');
  }

  // ─── 브라우저 준비 ────────────────────────────────────────────────────
  const browser = await chromium.launch();
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (compatible; personal-use-recon)',
    viewport: { width: 1280, height: 2400 },
    locale: 'ko-KR',
  });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(e.message.slice(0, 200)));
  page.on('request', (r) => {
    if (['xhr', 'fetch', 'document'].includes(r.resourceType())) {
      networkLog.push({
        t: 'req',
        method: r.method(),
        url: r.url(),
        // 브라우저를 걷어내고 HTTP 요청만으로 확인하려면 요청 본문이 필요하다.
        // 지금은 확인 1회에 44초가 드는데, 대부분이 브라우저 설치와 렌더링이다.
        postData: r.postData(),
        headers: r.headers(),
      });
    }
  });
  page.on('response', async (r) => {
    if (!['xhr', 'fetch', 'document'].includes(r.request().resourceType())) return;
    let body = null;
    try {
      // 이 사이트는 JSON이 아니라 HTML 조각을 주고받는다(8차 확인).
      // audeum.org 응답은 형식과 무관하게 본문을 잡아야 계약을 볼 수 있다.
      const ct = r.headers()['content-type'] ?? '';
      if (r.url().includes('audeum.org') && (ct.includes('json') || ct.includes('html') || ct.includes('text'))) {
        body = (await r.text()).slice(0, 8000);
      }
    } catch { /* 본문을 못 읽어도 나머지는 유효하다 */ }
    const entry = { t: 'res', url: r.url(), status: r.status(), body };
    networkLog.push(entry);
    appendFileSync(netStream, JSON.stringify(entry) + '\n');
  });

  /**
   * 대기열을 만나면 기다렸다가 다시 시도한다.
   *
   * 대기열은 사이트가 부하를 관리하는 장치이므로 간격을 넉넉히 둔다.
   * 몇 번 만에 통과하는지가 이번 정찰의 핵심 측정값이다.
   */
  async function gotoThroughQueue(url, maxAttempts = 8, waitMs = 8_000) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 40_000 });
      } catch (e) {
        return { ok: false, attempts: attempt, why: `로드 실패: ${e.message.split('\n')[0]}` };
      }
      await page.waitForTimeout(2_000); // 클라이언트 렌더가 끝날 시간을 준다
      const text = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');

      if (!isQueuePage(text)) {
        return { ok: true, attempts: attempt, text };
      }
      if (attempt < maxAttempts) {
        await page.waitForTimeout(waitMs);
      }
    }
    return { ok: false, attempts: maxAttempts, why: '대기열을 통과하지 못했습니다' };
  }

  const TARGETS = [
    { label: '예약 시작', url: `${BASE}/booking` },
    { label: '전시 예약', url: `${BASE}/booking/exhbition` },
    { label: '강의 예약', url: `${BASE}/programs/booking` },
  ];

  log('## 단계 1 — 대기열 통과 시도\n');
  const passed = [];

  for (const target of TARGETS) {
    const started = Date.now();
    const result = await gotoThroughQueue(target.url);
    const seconds = Math.round((Date.now() - started) / 1000);

    log(`\n### ${target.label} — ${target.url}`);
    if (!result.ok) {
      log(`- ❌ **통과 실패** (${result.attempts}회 시도, ${seconds}초): ${result.why}`);
      continue;
    }

    log(`- ✅ **통과** (${result.attempts}회 시도, ${seconds}초)`);
    if (result.attempts > 1) log(`- ⚠️ 첫 시도에 못 뚫었다 → 폴링 설계에 재시도가 필수다`);

    const html = await page.content().catch(() => '');
    const title = await page.title().catch(() => '');
    log(`- 제목: ${title || '(없음)'} · 본문 ${result.text.length}자 · HTML ${html.length}자`);

    const slug = target.label.replace(/\s+/g, '_');
    writeFileSync(`${OUT}/${slug}.html`, html);
    await page.screenshot({ path: `${OUT}/${slug}.png`, fullPage: true }).catch(() => {});

    log('```');
    log(result.text.slice(0, 2500).replace(/\n{3,}/g, '\n\n'));
    log('```');

    if (result.text.length < 600) {
      log('본문이 짧아 원본 HTML을 확인합니다:');
      log('```html');
      const bodyAt = html.indexOf('<body');
      log((bodyAt >= 0 ? html.slice(bodyAt) : html).slice(0, 5000).replace(/\s{2,}/g, ' '));
      log('```');
    }

    // 6차에서 드러난 것: 이 페이지들은 jQuery + AJAX 파셜이고, 인라인 스크립트에
    // 엔드포인트·필드명·플로우가 전부 들어 있다. JSON API가 없는 이유도 이것이다.
    // 스크립트를 통째로 덤프하는 것이 계약을 얻는 가장 빠른 길이다.
    const inlineScripts = await page.$$eval('script:not([src])', (els) =>
      els.map((el) => el.textContent ?? '').filter((t) => t.trim().length > 50),
    ).catch(() => []);

    if (inlineScripts.length) {
      const all = inlineScripts.join('\n');
      writeFileSync(`${OUT}/${slug}-scripts.js`, all);
      log(`인라인 스크립트 ${inlineScripts.length}개, 총 ${all.length}자 (아티팩트에 전문 저장)`);

      // 7차에서 스크립트를 통째로 찍었더니 로그가 2,600줄을 넘어 정작 읽기 어려웠다.
      // 계약에 해당하는 부분만 뽑는다 — 엔드포인트, 대기열 연동 지점, 여석 판별 어휘.

      // 1) 서버 엔드포인트: url:"..." 형태와 따옴표로 감싼 경로 리터럴
      const urls = new Set();
      for (const m of all.matchAll(/url\s*:\s*["'`]([^"'`]+)["'`]/g)) urls.add(m[1]);
      for (const m of all.matchAll(/["'`](\/[a-zA-Z][\w\/-]{2,60})["'`]/g)) urls.add(m[1]);
      log(`\n**엔드포인트 후보 ${urls.size}개**`);
      for (const u of [...urls].sort()) log(`- \`${u}\``);

      // 2) NetFunnel(대기열) 연동 지점 — 어느 단계에 게이트가 걸리는지
      const netfunnel = [...all.matchAll(/.{0,160}NetFunnel.{0,160}/g)].map((m) => m[0]);
      if (netfunnel.length) {
        log(`\n**NetFunnel 연동 ${netfunnel.length}곳**`);
        for (const n of netfunnel.slice(0, 8)) log(`- \`${n.replace(/\s+/g, ' ').trim()}\``);
      }

      // 3) 여석·매진·회차 관련 코드 — 매진 판별 신호가 여기 있다
      const KEYS = /잔여|매진|마감|남은|가능|selDate|selTime|selSeat|spectateDate|spectateTime|remainCnt|remain|soldOut|sold_out|seatCnt|reserveCnt|limitCnt|maxCnt/;
      const hits = all.split('\n').map((l) => l.trim()).filter((l) => KEYS.test(l) && l.length < 400);
      const uniqueHits = [...new Set(hits)];
      log(`\n**여석·회차 관련 코드 ${uniqueHits.length}줄**`);
      for (const h of uniqueHits.slice(0, 60)) log(`- \`${h}\``);

      // 4) 폼 필드 이름 — 예약 제출에 무엇이 필요한지
      const fields = new Set();
      for (const m of all.matchAll(/(?:name|id)\s*[:=]\s*["']([a-zA-Z][\w]{2,40})["']/g)) fields.add(m[1]);
      for (const m of all.matchAll(/\$\(["']#([a-zA-Z][\w]{2,40})["']\)/g)) fields.add(m[1]);
      if (fields.size) {
        log(`\n**폼 필드·요소 id 후보 ${fields.size}개**`);
        log([...fields].sort().map((f) => `\`${f}\``).join(', '));
      }
    }

    if (consoleErrors.length) {
      log(`JS 오류 ${consoleErrors.length}건: ${consoleErrors.slice(0, 5).join(' | ')}`);
      consoleErrors.length = 0;
    }

    passed.push({ ...target, text: result.text, html });
  }

  // ─── 단계 2: 실제 예약 흐름을 따라가 날짜 조각을 캡처한다 ──────────────
  //
  // 8차에서 플로우가 드러났다:
  //   .exhibition-item 클릭 → POST /booking/age → NetFunnel(act_3) → /booking/date
  //
  // 그 마지막 조각(.exhibition-date-wrapper)이 여석 판단의 근거다. 여기까지만 간다.
  // 결제 단계(/booking/payment, #btn_reserve)는 건드리지 않는다.
  log('\n## 단계 2 — 예약 흐름을 따라 날짜 조각 캡처\n');

  try {
    await gotoThroughQueue(`${BASE}/booking`);

    // 전시(도슨트)와 렉처를 모두 시도한다. 사용자가 원하는 것은 전시 쪽이다.
    for (const kind of ['exhibition', 'program']) {
      const selector = `.exhibition-list-container .exhibition-item.${kind}`;
      const count = await page.locator(selector).count().catch(() => 0);
      log(`\n### ${kind === 'exhibition' ? '전시(도슨트)' : '렉처'} — ${selector} (${count}개)`);
      if (count === 0) { log('- 항목이 없어 건너뜁니다'); continue; }

      const seq = await page.locator(`${selector} seq`).first().textContent().catch(() => null);
      log(`- seq: ${seq ?? '(읽지 못함)'}`);

      await page.locator(selector).first().click({ timeout: 5_000 });

      // 사이트가 age → NetFunnel → date 순으로 채운다. 넉넉히 기다린다.
      await page.waitForTimeout(9_000);

      for (const [name, sel] of [['연령', '.exhibition-wrapper'], ['날짜', '.exhibition-date-wrapper']]) {
        const html = await page.locator(sel).first().innerHTML().catch(() => '');
        const text = await page.locator(sel).first().innerText().catch(() => '');
        log(`\n**${name} 컨테이너 \`${sel}\`** — HTML ${html.length}자 / 텍스트 ${text.length}자`);
        if (text.trim()) {
          log('```');
          log(text.slice(0, 1200).replace(/\n{3,}/g, '\n\n'));
          log('```');
        }
        if (html.trim()) {
          log('```html');
          log(html.slice(0, 4000).replace(/\s{2,}/g, ' '));
          log('```');
        }
        writeFileSync(`${OUT}/${kind}-${name}.html`, html);
      }

      await page.screenshot({ path: `${OUT}/flow-${kind}.png`, fullPage: true }).catch(() => {});

      // 3초 쿨다운 + 다음 상품을 위해 페이지를 되돌린다
      await page.waitForTimeout(ITEM_COOLDOWN_MS);
      await gotoThroughQueue(`${BASE}/booking`);
    }
  } catch (e) {
    log(`흐름 추적 중 오류: ${e.message.split('\n')[0]}`);
  }

  await browser.close();
  writeFileSync(`${OUT}/network-log-full.json`, JSON.stringify(networkLog, null, 2));

  // ─── 요약 ─────────────────────────────────────────────────────────────
  log('\n## 요약\n');
  // 9차에서 요약이 페이지 로드 응답부터 찍는 바람에 정작 계약인 date/time 조각이
  // 로그 밖으로 밀렸다. 플로우 조각을 먼저, 그리고 전문에 가깝게 찍는다.
  const FLOW_STEP = /\/(age|date|time)(\?|$)/;
  const flowResponses = networkLog.filter((n) => n.t === 'res' && n.body && FLOW_STEP.test(n.url));

  log(`### 예약 플로우 조각 ${flowResponses.length}건 — **이것이 계약이다**\n`);
  if (flowResponses.length === 0) {
    log('플로우 조각을 하나도 잡지 못했습니다. 클릭이 동작하지 않았을 수 있습니다.');
  }
  for (const r of flowResponses) {
    log(`\n#### ${r.status} ${r.url}`);
    log('```html');
    log(r.body.replace(/\s{2,}/g, ' ').slice(0, 7000));
    log('```');
  }

  const pageResponses = networkLog.filter((n) => n.t === 'res' && n.body && !FLOW_STEP.test(n.url));
  log(`\n(페이지 로드 응답 ${pageResponses.length}건은 아티팩트에만 남깁니다)\n`);

  // 예약 흐름 단계의 요청 파라미터 — 브라우저 없이 재현하려면 이것이 계약이다
  const flowRequests = networkLog.filter(
    (n) => n.t === 'req' && FLOW_STEP.test(n.url) && n.url.includes('audeum.org'),
  );
  log(`\n### 예약 흐름 요청 ${flowRequests.length}건 — 브라우저 제거용\n`);
  for (const r of flowRequests) {
    log(`\n#### ${r.method} ${r.url}`);
    log(`- content-type: \`${r.headers?.['content-type'] ?? '(없음)'}\``);
    log(`- 쿠키 전송: ${r.headers?.['cookie'] ? '있음' : '없음'}`);
    log(`- referer: \`${r.headers?.['referer'] ?? '(없음)'}\``);
    log(r.postData ? `- **본문:** \`${r.postData.slice(0, 1000)}\`` : '- 본문 없음 (GET)');
  }

  const endpoints = [...new Set(networkLog.filter((n) => n.t === 'req' && n.url.includes('audeum.org')).map((n) => n.url.split('?')[0]))];
  log(`\n오디움 엔드포인트 ${endpoints.length}개:`);
  for (const e of endpoints) log(`- ${e}`);

  log('\n이 스크립트는 어떤 제출도 하지 않았고 contract.ts도 건드리지 않았습니다.');
  writeFileSync(`${OUT}/RECON_REPORT.md`, report.join('\n'));
  console.log('\n✅ 정찰 완료');
}

main().catch((e) => {
  console.error('정찰 오류:', e);
  writeFileSync(`${OUT}/RECON_REPORT.md`, report.join('\n') + `\n\n## 오류로 중단\n\n${e.stack}`);
  process.exit(1);
});
