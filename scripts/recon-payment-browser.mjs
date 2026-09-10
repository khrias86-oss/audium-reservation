#!/usr/bin/env node
/**
 * 결제 화면 계약 확정 — 브라우저로 걸어가되, **제출은 하지 않는다.**
 *
 * ## 왜 브라우저를 다시 꺼내는가
 *
 * 조회는 브라우저가 필요 없다는 것이 11차에서 밝혀졌고, 감시 경로에서는 이미
 * 걷어냈다. 그런데 `/booking/payment`는 HTTP만으로는 500을 돌려준다 —
 * 파라미터 조합을 셋이나 시도해도 같았다. 조회 엔드포인트가 쿠키 없이 응답하는
 * 것과 대조적이므로, **결제 단계는 세션에 묶여 있다**고 보는 것이 자연스럽다.
 * 앞선 단계에서 고른 인원·연령이 서버 세션에 쌓여 있어야 화면이 그려진다.
 *
 * 그 세션을 만드는 유일한 정직한 방법은 사람이 하는 대로 걸어가는 것이다.
 * 이건 우회가 아니라 정상 경로다.
 *
 * ## 무엇을 확정하려는가
 *
 * 예약 화면에 무엇이 필요한지. 특히 **휴대폰 본인인증이 있는지**. 있다면
 * 무인 자동 예약은 불가능하고, 설계가 통째로 달라진다. 추측으로 결정할 수 없는
 * 종류의 사실이라 직접 봐야 한다.
 *
 * ## 안전장치
 *
 * 이 스크립트는 예약을 만들 수 있는 어떤 행동도 하지 않는다.
 *   - `#btn_reserve`를 **클릭하지 않는다** (존재 여부와 disabled 상태만 읽는다)
 *   - 인증번호 발송 버튼을 누르지 않는다 — 남의 폰으로 문자를 보내는 짓이다
 *   - 어떤 입력 필드에도 값을 넣지 않는다
 *   - 위험한 텍스트를 가진 요소는 클릭 대상에서 제외한다
 *   - 라우트 단계에서 제출로 보이는 요청을 막는다 (마지막 방어선)
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

const ORIGIN = 'https://audeum.org';
const OUT = 'recon-output';
mkdirSync(OUT, { recursive: true });

const report = [];
const log = (l) => { console.log(l); report.push(l); };

/** 눌러서는 안 되는 것. 예약을 만들거나 남에게 문자를 보내는 버튼들이다. */
const FORBIDDEN_CLICK = /예약하기|예약 하기|Reserve|Book now|인증번호|전송|발송|Send|결제|Pay|확인 요청/i;
/** 제출로 보이는 요청. 라우트에서 끊는다. */
const FORBIDDEN_REQUEST = /reserve|insert|confirm|complete|cert|auth|sms/i;

async function main() {
  log(`# 결제 화면 계약 확정 (브라우저, 제출 없음)\n\n생성 시각(UTC): ${new Date().toISOString()}\n`);

  const browser = await chromium.launch();
  const context = await browser.newContext({ locale: 'ko-KR', viewport: { width: 420, height: 1400 } });
  const page = await context.newPage();

  // 마지막 방어선: 제출로 보이는 요청은 브라우저 밖으로 나가지 못한다.
  let blocked = 0;
  await context.route('**/*', (route) => {
    const req = route.request();
    if (req.method() === 'POST' && FORBIDDEN_REQUEST.test(req.url())) {
      blocked++;
      log(`- 🛑 제출로 보이는 요청을 차단했다: ${req.method()} ${req.url()}`);
      return route.abort();
    }
    return route.continue();
  });

  const fragments = new Map();
  page.on('response', (res) => {
    const url = res.url();
    if (!url.includes('audeum.org')) return;
    if (!/\/(age|date|time|payment)$/.test(url)) return;
    void res.text().then((t) => fragments.set(url, t), () => {});
  });

  try {
    log('## 1 — 예약 페이지 열기\n');
    await page.goto(`${ORIGIN}/booking`, { waitUntil: 'networkidle', timeout: 45_000 });
    const text = await page.locator('body').innerText().catch(() => '');
    if (/동시접속자가 많아|high volume of traffic/.test(text)) {
      log('대기열 페이지다. 오늘은 여기까지. 나중에 다시 돌린다.');
      return;
    }
    log(`본문 ${text.length}자`);

    log('\n## 2 — 전시 상품 선택\n');
    const item = page.locator('.exhibition-list-container .exhibition-item.exhibition').first();
    if ((await item.count().catch(() => 0)) === 0) {
      log('상품 항목을 찾지 못했다. 페이지 구조가 바뀌었을 수 있다.');
      return;
    }
    await item.click({ timeout: 10_000 });
    await page.waitForTimeout(9_000);   // 연령 → NetFunnel(act_3) → 날짜 순으로 채워진다
    log('연령/날짜 단계까지 진행');

    log('\n## 3 — 인원 1명 선택 (결제 화면을 그리려면 필요하다)\n');
    // 인원이 0이면 서버가 결제 화면을 만들 수 없다. HTTP만으로 500이 났던 이유로 보인다.
    const plus = page.locator('.exhibition-age .select-category-container').first().locator('.plus-btn');
    if ((await plus.count().catch(() => 0)) > 0) {
      await plus.click({ timeout: 5_000 }).catch((e) => log(`- 인원 증가 실패: ${e.message}`));
      await page.waitForTimeout(1_000);
      log('일반 1명 선택');
    } else {
      log('인원 버튼을 찾지 못했다');
    }

    log('\n## 4 — 예약 가능한 회차 고르기\n');
    // 날짜를 하나씩 눌러 회차가 나오는 날을 찾는다. 매진 회차는 사이트가 클릭을
    // 거부하므로(disabled-time-slots), 여석이 있는 회차만 결제 화면으로 넘어간다.
    const days = page.locator('#datepicker_reserve td a, .calendar-container td a');
    const dayCount = await days.count().catch(() => 0);
    log(`달력 클릭 후보 ${dayCount}개`);

    let opened = false;
    for (let i = 0; i < Math.min(dayCount, 12) && !opened; i++) {
      const label = (await days.nth(i).innerText().catch(() => '')).trim();
      if (FORBIDDEN_CLICK.test(label)) continue;
      await days.nth(i).click({ timeout: 4_000 }).catch(() => {});
      await page.waitForTimeout(2_500);

      const free = page.locator('.time-slots:not(.disabled-time-slots)');
      const freeCount = await free.count().catch(() => 0);
      log(`- ${label}일 → 여석 회차 ${freeCount}개`);
      if (freeCount === 0) continue;

      await free.first().click({ timeout: 4_000 }).catch((e) => log(`  회차 클릭 실패: ${e.message}`));
      await page.waitForTimeout(4_000);
      opened = (await page.locator('.payment-form').innerHTML().catch(() => '')).trim().length > 0;
    }

    log('\n## 5 — 결제 화면\n');
    const paymentHtml = await page.locator('.payment-form').innerHTML().catch(() => '');
    if (paymentHtml.trim().length === 0) {
      log('결제 화면이 열리지 않았다. 여석이 있는 회차가 없었을 가능성이 높다.');
      log('(예약이 열린 직후에 다시 돌리면 열린다)');
    } else {
      writeFileSync(`${OUT}/payment-form.html`, paymentHtml);
      log(`결제 화면 마크업 ${paymentHtml.length}자\n`);

      const ids = [...new Set([...paymentHtml.matchAll(/id=["']([^"']+)["']/g)].map((m) => m[1]))];
      log(`입력 요소 id: ${ids.map((i) => `\`${i}\``).join(', ')}\n`);

      // 이것이 이 실행의 핵심 질문이다.
      const reserveBtn = page.locator('#btn_reserve');
      const exists = (await reserveBtn.count().catch(() => 0)) > 0;
      const disabled = exists ? await reserveBtn.isDisabled().catch(() => null) : null;
      log(`\`#btn_reserve\` 존재: ${exists}, disabled: ${disabled}  ← **클릭하지 않았다**`);

      const sendBtn = await page.locator('.telephone-inner-wrapper .send-num-btn, .send-num-btn').count().catch(() => 0);
      const telInput = await page.locator('.telephone-inner-wrapper input, input[type=tel]').count().catch(() => 0);
      log(`인증번호 발송 버튼: ${sendBtn}개, 전화번호 입력칸: ${telInput}개  ← **누르지 않았다**`);

      log('\n**결제 화면 스크립트**');
      const scripts = [...paymentHtml.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join('\n');
      log('```js\n' + (scripts.slice(0, 7000) || '(인라인 스크립트 없음)') + '\n```');

      const plain = paymentHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      log('\n**화면에 보이는 문구**');
      log('```\n' + plain.slice(0, 1500) + '\n```');
    }

    await page.screenshot({ path: `${OUT}/payment-screen.png`, fullPage: true }).catch(() => {});

    log('\n## 6 — 흐름 전체 스크립트\n');
    for (const [url, body] of fragments) {
      const src = [...body.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join('\n');
      if (src.trim().length === 0) continue;
      log(`\n### ${url} — 스크립트 ${src.length}자`);
      log('```js\n' + src.slice(0, 3000) + '\n```');
    }
  } catch (e) {
    log(`\n오류로 중단: ${e.message}`);
  } finally {
    log(`\n---\n차단한 제출성 요청: ${blocked}건. 예약 버튼과 인증 버튼은 누르지 않았다.`);
    writeFileSync(`${OUT}/RECON_REPORT.md`, report.join('\n'));
    await browser.close().catch(() => {});
  }
}

main().catch((e) => {
  writeFileSync(`${OUT}/RECON_REPORT.md`, report.join('\n') + `\n\n## 오류\n\n${e.stack}`);
  console.error(e);
  process.exit(1);
});
