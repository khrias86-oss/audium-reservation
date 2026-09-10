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
  try { rendered = readFileSync(`${OUT}/rendered.html`, 'utf8'); } catch { /* 저장 실패 시 아래에서 안내한다 */ }
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
