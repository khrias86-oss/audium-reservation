# audeum-reservation

오디움(https://audeum.org/booking) 관람 예약을 10분 주기로 감시하고, 빈자리 발생 시
이메일로 알린 뒤 자동으로 예약하는 개인용 시스템.

전체 요구사항과 마일스톤은 `PROMPT.md`를 따른다.

## 아키텍처

```
[대시보드 Next.js/Vercel] ──┐
                            ├─▶ [Postgres: 감시조건·상태·하트비트]
[폴링 워커 (플랫폼 미정)] ──┘
        │
        └─▶ src/adapters/audeum/  ← 사이트 계약이 격리되는 유일한 경계
                    │
              src/core/           ← 사이트를 모르는 순수 로직
```

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
pnpm typecheck
pnpm test
```

슬래시 커맨드: `/recon` `/dryrun` `/contract-check` `/verify`

## 진행 상황

- [x] M0 하네스
- [ ] M1 정찰  ← **`audeum.org` 접근 가능한 환경에서 수행해야 함**
- [x] M2 코어 로직 (계약 비의존 부분)
- [ ] M3 폴링 루프 (M1 필요)
- [ ] M4 이메일 / M5 대시보드 / M6 자동예약 / M7 배포

## 작업 순서 주의

M1(정찰)이 끝나기 전에는 셀렉터·엔드포인트를 **추측해서 쓰지 않는다.**
`src/adapters/audeum/contract.ts`는 M1 완료 후에만 채운다.
