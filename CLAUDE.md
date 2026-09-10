# audeum-reservation

오디움(https://audeum.org/booking) 관람 예약을 10분 주기로 감시하고, 빈자리 발생 시
이메일로 알린 뒤 자동으로 예약하는 개인용 시스템.

전체 요구사항과 마일스톤은 `PROMPT.md`를 따른다.

## 아키텍처

하나의 이미지가 두 모드로 돈다. 배포처에 결합되어 있지 않다.

```
GitHub Actions cron ──▶ src/watch-once.ts    ← 실제로 도는 경로
                              │
                              ├─ GitHub 이슈(감시 요청) 읽기
                              ├─ src/adapters/audeum/http-flow.ts  ← 폼 POST 1건
                              │     └─ parse-time-fragment.ts      ← 여석 판단
                              └─ 이슈로 알림

MODE=tick (src/runtime/tick.ts) ← 서킷·하트비트·상태기계가 있는 완전판 파이프라인.
                                   저장소가 붙는 M3+ 에서 쓴다.
src/core/                       ← 사이트를 모르는 순수 로직
```

배포처는 **GitHub Actions**다. Vercel은 Hobby cron이 하루 1회라 탈락했고,
Cloud Run은 브라우저가 필요할 때의 대안이었는데 브라우저를 걷어내면서 필요가 없어졌다.

**확인 1회는 폼 POST 한 건, 실측 1.085초다** (11~12차 정찰). 사이트가 자리 정보를
쿠키도 토큰도 없이 그대로 내주기 때문에 브라우저가 필요 없다. 이전에는 44초였다
(크로미움 설치 23초 + 조작 21초).

다만 **속도가 예산을 줄여주지는 않는다.** Actions는 실행 1회를 몇 초가 걸리든
1분으로 반올림하므로 비용을 정하는 것은 횟수다. private 저장소 한도는 월 2,000분이고,
사이트가 목·금·토만 운영하므로 **수~토 09~22시(KST)**로 좁혀 월 약 1,370분을 쓴다.
계산은 `.github/workflows/watch.yml` 머리말에 적어 두었다.

**핵심 규칙: `src/core/`는 오디움을 몰라야 한다.** core는 정규화된 `Slot` 타입만 다루고,
사이트 고유의 셀렉터·URL·응답 스키마는 `src/adapters/audeum/contract.ts` 한 파일에만 존재한다.

## NEVER (타협 불가)

- `DRY_RUN=false`가 **명시적으로** 설정되지 않으면 실제 예약 제출(POST) 금지
- 폴링 주기 5분 미만 금지 (적응형 모드 포함)
- 봇 탐지 회피 코드 금지 — 프록시 로테이션, UA 위조, 헤드리스 은닉, CAPTCHA 자동 해제
- `.env`, 쿠키/세션 파일(`storage-state.json`), `runs/`, 예약자 개인정보 커밋 금지
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
- [x] M5 UI — `docs-site/index.html` 모바일 달력. 서버 없이 이슈 주소로 넘긴다
- [~] M6 자동예약 — **휴대폰 본인인증이 막고 있다.** `docs/auto-booking.md` 참고
- [x] M7 배포 — GitHub Actions

정찰은 두 워크플로로 돈다.
- `recon.yml` — `recon-run` 브랜치 푸시. 브라우저 정찰(구식, 느림)
- `probe.yml` — `probe-run` 푸시는 HTTP 정찰(2초).
  `probe-payment-run` 푸시는 결제 화면까지 확인한다. **어느 쪽도 예약을 제출하지 않는다.**

## 작업 순서 주의

셀렉터·엔드포인트를 **추측해서 쓰지 않는다.** 정찰로 실측한 것만
`src/adapters/audeum/contract.ts`에 넣고, 근거를 `docs/site-contract.md`에 남긴다.
