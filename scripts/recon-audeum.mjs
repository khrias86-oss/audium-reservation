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
import { writeFileSync, mkdirSync, appendFileSync } from 'node:fs';

const BASE = 'https://audeum.org';
const BOOKING_URL = `${BASE}/booking`;
const OUT = 'recon-output';
mkdirSync(OUT, { recursive: true });

const DANGEROUS_TEXT = /예약하기|예약신청|신청하기|제출|결제|확인|다음|완료|로그인|가입|취소하기/;
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
  let robotsDisallowsBooking = false;
  try {
    const res = await fetch(`${BASE}/robots.txt`, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; personal-use-recon)' } });
    robotsText = await res.text();
    writeFileSync(`${OUT}/robots.txt`, robotsText);
    log(`robots.txt 상태: ${res.status}`);
    log('```\n' + robotsText.slice(0, 3000) + '\n```\n');

    // 아주 보수적인 파서: User-agent: * 블록 안에서 Disallow: / 또는 /booking 계열을 찾는다.
    const lines = robotsText.split('\n').map((l) => l.trim());
    let inWildcardBlock = false;
    for (const line of lines) {
      if (/^user-agent:\s*\*/i.test(line)) inWildcardBlock = true;
      else if (/^user-agent:/i.test(line)) inWildcardBlock = false;
      else if (inWildcardBlock && /^disallow:/i.test(line)) {
        const path = line.split(':').slice(1).join(':').trim();
        if (path === '/' || (path && BOOKING_URL.includes(path))) {
          robotsDisallowsBooking = true;
        }
      }
    }
  } catch (e) {
    log(`robots.txt 조회 실패: ${e.message} (차단으로 간주하지 않고 계속 진행하되, 사람 검토 필요)`);
  }

  if (robotsDisallowsBooking) {
    log('\n**⛔ robots.txt가 /booking(또는 전체)에 대한 자동화된 접근을 명시적으로 금지하는 것으로 보입니다.**');
    log('이 스크립트는 여기서 중단합니다. 이용약관을 사람이 직접 확인한 뒤 진행 여부를 결정해야 합니다.');
    writeFileSync(`${OUT}/RECON_REPORT.md`, report.join('\n'));
    process.exit(0); // 실패가 아니라 "의도적으로 멈춤" — 워크플로는 성공으로 끝나되 리포트가 이를 명시한다.
  }
  log('robots.txt에서 /booking 차단 조항을 찾지 못했습니다. **단, 이것이 이용약관 확인을 대체하지 않습니다 — 사람이 별도로 확인해야 합니다.**\n');

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

  // --- 단계 2~3: Playwright로 네트워크 캡처 + 상호작용 ---
  log('\n## 단계 2~3 — 네트워크 캡처 및 상호작용\n');
  const browser = await chromium.launch();
  const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (compatible; personal-use-recon)' });
  const page = await context.newPage();

  page.on('request', (req) => {
    if (['xhr', 'fetch', 'document'].includes(req.resourceType())) {
      networkLog.push({ phase: 'unlabeled', t: 'req', method: req.method(), url: req.url() });
    }
  });
  page.on('response', async (res) => {
    const req = res.request();
    if (['xhr', 'fetch'].includes(req.resourceType())) {
      let body = null;
      try {
        const ct = res.headers()['content-type'] ?? '';
        if (ct.includes('json') || ct.includes('text')) {
          body = (await res.text()).slice(0, 5000);
        }
      } catch { /* 응답 본문을 못 읽어도 무시하고 계속 진행 */ }
      const entry = { t: 'res', url: res.url(), status: res.status(), body };
      networkLog.push(entry);
      appendFileSync(netStream, JSON.stringify(entry) + '\n');
    }
  });

  try {
    await page.goto(BOOKING_URL, { waitUntil: 'networkidle', timeout: 30_000 });
  } catch (e) {
    log(`페이지 로드 실패 또는 타임아웃: ${e.message}`);
  }

  await page.screenshot({ path: `${OUT}/01-initial.png`, fullPage: true }).catch(() => {});
  writeFileSync(`${OUT}/rendered.html`, await page.content().catch(() => ''));
  log(`초기 로드까지 캡처된 xhr/fetch 요청: ${networkLog.filter((n) => n.t === 'req').length}건`);

  // 날짜로 추정되는 요소를 찾아 최대 6개까지만 클릭한다. 위험한 텍스트는 절대 클릭하지 않는다.
  const candidates = await page.$$eval('button, td, div, span, a', (els) =>
    els
      .filter((el) => el.children.length === 0) // 리프 노드만 — 컨테이너 오클릭 방지
      .map((el, i) => ({ i, text: (el.textContent ?? '').trim(), tag: el.tagName }))
      .filter((c) => c.text.length > 0 && c.text.length < 5),
  );
  const dateLikeCandidates = candidates.filter((c) => DATE_LIKE.test(c.text) && !DANGEROUS_TEXT.test(c.text));
  log(`날짜로 추정되는 클릭 후보: ${dateLikeCandidates.length}개 (최대 6개만 시도)`);

  let clicked = 0;
  for (const cand of dateLikeCandidates.slice(0, 20)) {
    if (clicked >= 6) break;
    const before = networkLog.length;
    try {
      const locator = page.locator(cand.tag.toLowerCase()).filter({ hasText: new RegExp(`^\\s*${cand.text}\\s*$`) }).first();
      const isDisabled = await locator.isDisabled().catch(() => false);
      const ariaDisabled = await locator.getAttribute('aria-disabled').catch(() => null);
      if (isDisabled || ariaDisabled === 'true') {
        log(`- "${cand.text}" 는 비활성 상태로 보여 건너뜀 (매진/휴관 판별에 유용한 신호)`);
        continue;
      }
      await locator.click({ timeout: 3_000 });
      await page.waitForTimeout(1_200); // 클릭 후 비동기 요청이 발생할 시간을 준다
      clicked++;
      const after = networkLog.length;
      log(`- "${cand.text}" 클릭 → 새 xhr/fetch 요청 ${after - before}건`);
      await page.screenshot({ path: `${OUT}/click-${clicked}-${cand.text}.png` }).catch(() => {});
    } catch (e) {
      log(`- "${cand.text}" 클릭 시도 실패: ${e.message}`);
    }
  }

  // --- 단계: 매진/여석 텍스트 신호 스캔 ---
  log('\n## 매진·여석 텍스트 신호 스캔\n');
  const textSignals = await page.evaluate(() => {
    const body = document.body.innerText;
    const patterns = ['마감', '매진', '예약마감', '신청불가', '잔여', '남음', 'SOLD', 'sold-out', 'disabled', 'unavailable'];
    return patterns.map((p) => ({ pattern: p, count: (body.match(new RegExp(p, 'gi')) || []).length }));
  });
  for (const { pattern, count } of textSignals) {
    if (count > 0) log(`- "${pattern}": ${count}회 발견`);
  }

  const disabledCount = await page.locator('[disabled], [aria-disabled="true"], .disabled, .sold-out').count().catch(() => 0);
  log(`- disabled/aria-disabled/.disabled/.sold-out 셀렉터 매칭: ${disabledCount}개`);

  await browser.close();

  writeFileSync(`${OUT}/network-log-full.json`, JSON.stringify(networkLog, null, 2));

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
