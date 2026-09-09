# audeum-reservation

오디움(https://audeum.org/booking) 관람 예약을 10분 주기로 감시하고, 빈자리 발생 시
이메일로 알린 뒤 자동으로 예약하는 개인용 시스템.

전체 요구사항과 마일스톤은 `PROMPT.md`를 따른다.

## 아키텍처

하나의 이미지가 두 모드로 돈다. 배포처에 결합되어 있지 않다.

```
MODE=server (대시보드) ──┐
                          ├─▶ [Store 포트: 감시조건·스냅샷·서킷·하트비트·멱등성키]
MODE=tick   (폴링 1회) ──┘        인메모리(현재) → Postgres(M3)
        │
        └─▶ src/runtime/tick.ts   ← 파이프라인. 부수효과를 전부 주입받는다
                    │
              src/adapters/audeum/ ← 사이트 계약이 격리되는 유일한 경계
                    │
              src/core/            ← 사이트를 모르는 순수 로직
```

배포처는 **Cloud Run + Cloud Scheduler**로 결정했다 (근거와 예산 계산은 `deploy/README.md`).
Vercel은 Hobby cron이 하루 1회라 10분 주기가 불가능해 탈락했다. 다만 코드는 어느
플랫폼에도 결합되어 있지 않으므로, 배포처를 바꿔도 `Dockerfile`을 옮기면 된다.

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
- [ ] M1 정찰  ← **GitHub Actions `recon.yml`(workflow_dispatch)로 실행한다.**
      이 세션은 `audeum.org` 접근이 차단되지만, Actions 러너는 별개 네트워크라
      가능하다. 결과는 `recon-output` 아티팩트로 나오며, 사람 또는 다음 세션이
      검토해 `docs/site-contract.md`를 채운다. 워크플로는 절대 예약을 제출하지
      않고 스케줄도 걸려 있지 않다(수동 트리거만).
- [x] M2 코어 로직 (계약 비의존 부분)
- [~] M3 폴링 루프 — 파이프라인·저장소 포트·설정·진입점 완료, **어댑터만 M1 대기**
- [ ] M4 이메일 / M5 대시보드 / M6 자동예약 / M7 배포

테스트 77개. `MODE=tick`은 M1 전까지 `assertContractReady()`로 의도적으로 실패한다.

## 작업 순서 주의

M1(정찰)이 끝나기 전에는 셀렉터·엔드포인트를 **추측해서 쓰지 않는다.**
`src/adapters/audeum/contract.ts`는 M1 완료 후에만 채운다.
