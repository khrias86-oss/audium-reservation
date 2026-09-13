# audeum-reservation

오디움(https://audeum.org/booking) 관람 예약(전시·렉처, 두 상품 독립)을 5분 주기로
감시하고, 빈자리 발생 시 이메일로 알린 뒤 자동으로 예약하는 개인용 시스템.

전체 요구사항과 마일스톤은 `PROMPT.md`를 따른다.

## 아키텍처

하나의 이미지가 두 모드로 돈다. 배포처에 결합되어 있지 않다.

```
GitHub Actions cron ──▶ src/watch-once.ts    ← 실제로 도는 경로 (전시/렉처 완전 분리)
                              │
                              ├─ GitHub 이슈(감시 요청) 읽기 — product별로 나눠 처리
                              ├─ src/adapters/audeum/http-flow.ts  ← 폼 POST 1건
                              │     └─ parse-time-fragment.ts      ← 여석 판단
                              └─ 이슈로 알림

                        같은 실행마다 (감시 요청 유무와 무관하게) ↓
                   src/snapshot.ts → src/adapters/audeum/build-snapshot.ts
                              │        (요일을 추측하지 않는다 — /booking/date가
                              │         실측으로 밝힌 "열린 날짜"만 쓴다)
                              └─▶ docs-site/data/availability.json 커밋
                                        │
                                        └─▶ pages.yml이 재배포 (CHAIN_TOKEN으로 깨움 —
                                            기본 토큰의 push는 다른 워크플로를 못 깨운다)

MODE=tick (src/runtime/tick.ts) ← 서킷·하트비트·상태기계가 있는 완전판 파이프라인.
                                   저장소가 붙는 M3+ 에서 쓴다.
src/core/                       ← 사이트를 모르는 순수 로직
```

배포처는 **GitHub Actions**다. Vercel은 Hobby cron이 하루 1회라 탈락했고,
Cloud Run은 브라우저가 필요할 때의 대안이었는데 브라우저를 걷어내면서 필요가 없어졌다.

**확인 1회는 폼 POST 한 건, 실측 1.085초다** (11~12차 정찰). 사이트가 자리 정보를
쿠키도 토큰도 없이 그대로 내주기 때문에 브라우저가 필요 없다. 이전에는 44초였다
(크로미움 설치 23초 + 조작 21초).

**저장소는 public이다.** 그래서 Actions 시간이 무제한 무료이고, 예산이 설계를
지배하던 국면이 끝났다. 지금은 **화~토 24시간 5분 간격**으로 돈다 (하루 288회).
5분은 사이트 부담을 고려해 정한 하한이라 예산과 무관하게 유지한다.
근거는 `.github/workflows/watch.yml` 머리말에 적어 두었다.

감시 신청 페이지는 **GitHub Pages가 1차 배포처다**
(`https://khrias86-oss.github.io/audium-reservation/`, `.github/workflows/pages.yml`).
Claude 아티팩트 미리보기는 개발 중 확인용 사본일 뿐 제품 URL이 아니다 — CSP가
`fetch`를 막아 자동 등록이 안 되고, 소유자 세션에서만 열린다.
**단, Pages는 저장소 설정에서 아직 켜지지 않았다** — `Settings → Pages →
Source: GitHub Actions`를 사람이 한 번 눌러야 한다. Actions 기본 토큰에는
Pages *사이트를 새로 만들* 권한이 없고 이미 켜진 곳에 배포할 권한뿐이라
(`Resource not accessible by integration`), 자동화로 우회하지 않는다.
켜기 전까지는 미리보기 사본이 유일한 확인 경로다.
페이지에는 비밀이 없다 — 토큰과 예약 정보는 사용자 브라우저의 localStorage에만 있다.

**핵심 규칙: `src/core/`는 오디움을 몰라야 한다.** core는 정규화된 `Slot` 타입만 다루고,
사이트 고유의 셀렉터·URL·응답 스키마는 `src/adapters/audeum/contract.ts` 한 파일에만 존재한다.

## NEVER (타협 불가)

- `DRY_RUN=false`가 **명시적으로** 설정되지 않으면 실제 예약 제출(POST) 금지
- 폴링 주기 5분 미만 금지 (적응형 모드 포함)
- 봇 탐지 회피 코드 금지 — 프록시 로테이션, UA 위조, 헤드리스 은닉, CAPTCHA 자동 해제
- `.env`, 쿠키/세션 파일(`storage-state.json`), `runs/`, 예약자 개인정보 커밋 금지
  — **저장소가 public이므로 이메일·전화번호도 파일에 적지 않는다.** 크롤러가 수집한다.
  예약자 정보가 필요하면 GitHub Secrets(`APPLICANT_NAME`, `APPLICANT_EMAIL`)로만 주입한다
- 실제 사이트를 대상으로 한 반복 테스트 금지 → `tests/fixtures/` 사용
- 테스트를 skip/disable해서 통과시키지 않는다. 실패하면 테스트가 아니라 코드를 고친다
- 티켓 재판매·대리예약·다중 계정 기능은 만들지 않는다

## 개발 명령

```
pnpm verify      # typecheck + test — 커밋 전 필수
pnpm simulate    # 3틱 시뮬레이션 — 상태 전이를 눈으로 확인
pnpm typecheck
pnpm test
```

슬래시 커맨드: `/recon` `/dryrun` `/contract-check` `/verify`

## 진행 상황

- [x] M0 하네스
- [x] M1 정찰 — 14차까지 완료. 조회·요청 계약 확정 (`docs/site-contract.md`)
- [x] M2 코어 로직
- [x] M3 폴링 루프 — 실제로 돌고 있고, 실제 취소표를 한 번 잡아냈다
- [x] M4 알림 — GitHub 이슈로 보낸다 (앱 푸시 + 이메일이 딸려 온다)
- [x] M5 UI — `docs-site/index.html` 모바일 달력. 전시·렉처를 완전히 독립된
      카드로 그리고, `docs-site/data/availability.json`(실측 당월 매진/여석)을
      읽어 실제 상태를 보여준다. 서버 없이 이슈 주소로 넘긴다
- [~] M6 자동예약 — **휴대폰 인증 + Cloudflare Turnstile이 막고 있다.**
      뚫지 않는다. 관문 앞까지 자동화하는 것이 최대치다. `docs/auto-booking.md` 참고
- [~] M7 배포 — GitHub Actions (감시)는 돈다. GitHub Pages (신청 페이지)는
      워크플로가 준비돼 있지만 **저장소 설정에서 아직 켜지지 않았다** — 사람이
      `Settings → Pages → Source: GitHub Actions`를 한 번 눌러야 한다

정찰은 두 워크플로로 돈다.
- `recon.yml` — `recon-run` 브랜치 푸시. 브라우저 정찰(구식, 느림)
- `probe.yml` — `probe-run` 푸시는 HTTP 정찰(2초).
  `probe-payment-run` 푸시는 결제 화면까지 확인한다. **어느 쪽도 예약을 제출하지 않는다.**

## 작업 순서 주의

셀렉터·엔드포인트를 **추측해서 쓰지 않는다.** 정찰로 실측한 것만
`src/adapters/audeum/contract.ts`에 넣고, 근거를 `docs/site-contract.md`에 남긴다.
