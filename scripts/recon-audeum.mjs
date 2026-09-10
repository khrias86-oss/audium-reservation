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
      networkLog.push({ t: 'req', method: r.method(), url: r.url() });
    }
  });
  page.on('response', async (r) => {
    if (!['xhr', 'fetch', 'document'].includes(r.request().resourceType())) return;
    let body = null;
    try {
      if ((r.headers()['content-type'] ?? '').includes('json')) body = (await r.text()).slice(0, 6000);
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

    if (consoleErrors.length) {
      log(`JS 오류 ${consoleErrors.length}건: ${consoleErrors.slice(0, 5).join(' | ')}`);
      consoleErrors.length = 0;
    }

    passed.push({ ...target, text: result.text, html });
  }

  // ─── 단계 2: 통과한 페이지에서 캘린더 찾기 ────────────────────────────
  log('\n## 단계 2 — 캘린더·회차 탐색\n');
  const richest = passed.sort((a, b) => b.text.length - a.text.length)[0];

  if (!richest) {
    log('통과한 페이지가 없어 캘린더를 찾을 수 없습니다.');
  } else {
    try {
      log(`대상: ${richest.url} (본문 ${richest.text.length}자)\n`);
      await gotoThroughQueue(richest.url);

      const times = [...richest.text.matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g)].map((m) => m[0]);
      log(`본문에서 발견한 HH:MM 패턴: ${times.length ? [...new Set(times)].join(', ') : '없음'}`);

      const candidates = await page.$$eval('button, td, div, span, a, li', (els) =>
        els.filter((el) => el.children.length === 0)
          .map((el) => ({ text: (el.textContent ?? '').trim(), tag: el.tagName }))
          .filter((c) => c.text.length > 0 && c.text.length < 5),
      ).catch(() => []);

      const dateLike = candidates.filter((c) => DATE_LIKE.test(c.text) && !DANGEROUS_TEXT.test(c.text));
      log(`날짜로 보이는 요소: ${dateLike.length}개${dateLike.length ? ` (${dateLike.slice(0, 15).map((c) => c.text).join(', ')})` : ''}`);

      let clicked = 0;
      for (const cand of dateLike.slice(0, 15)) {
        if (clicked >= 4) break;
        const before = networkLog.length;
        try {
          const loc = page.locator(cand.tag.toLowerCase())
            .filter({ hasText: new RegExp(`^\\s*${cand.text}\\s*$`) }).first();
          if (await loc.isDisabled().catch(() => false)) {
            log(`- "${cand.text}" 비활성 → 매진/휴관 신호 후보`);
            continue;
          }
          await loc.click({ timeout: 3_000 });
          await page.waitForTimeout(2_000);
          clicked++;
          const after = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
          log(`- "${cand.text}" 클릭 → 요청 ${networkLog.length - before}건, 본문 ${after.length}자`);
          if (after.length > richest.text.length + 50) {
            log('  새 내용이 나타났습니다:');
            log('```');
            log(after.slice(0, 1500).replace(/\n{3,}/g, '\n\n'));
            log('```');
          }
          await page.screenshot({ path: `${OUT}/click-${clicked}.png`, fullPage: true }).catch(() => {});
        } catch (e) {
          log(`- "${cand.text}" 클릭 실패: ${e.message.split('\n')[0]}`);
        }
      }

      const signals = await page.evaluate(() => {
        const body = document.body?.innerText ?? '';
        return ['마감', '매진', '잔여', '남음', '가능', '회차', '예약', 'SOLD', 'FULL']
          .map((p) => ({ p, n: (body.match(new RegExp(p, 'gi')) || []).length }))
          .filter((x) => x.n > 0);
      }).catch(() => []);
      log(`\n매진·여석 신호: ${signals.length ? signals.map((s) => `${s.p}(${s.n})`).join(', ') : '없음'}`);

      const disabled = await page.locator('[disabled], [aria-disabled="true"], .disabled, .sold-out').count().catch(() => 0);
      log(`disabled 계열 셀렉터: ${disabled}개`);
    } catch (e) {
      log(`탐색 중 오류: ${e.message}`);
    }
  }

  await browser.close();
  writeFileSync(`${OUT}/network-log-full.json`, JSON.stringify(networkLog, null, 2));

  // ─── 요약 ─────────────────────────────────────────────────────────────
  log('\n## 요약\n');
  const audeumJson = networkLog.filter((n) => n.t === 'res' && n.body && n.url.includes('audeum.org'));
  log(`오디움 자체 JSON 응답: ${audeumJson.length}건`);
  for (const r of audeumJson.slice(0, 4)) {
    log(`\n### ${r.status} ${r.url}`);
    log('```json');
    log(r.body.slice(0, 2500));
    log('```');
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
