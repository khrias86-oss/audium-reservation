# audeum-reservation

오디움(https://audeum.org/booking) 관람 예약을 주기적으로 감시하고, 빈자리가 생기면
이메일로 알린 뒤 자동으로 예약하는 **개인용** 도구.

본인 1인의 무료 관람 예약만을 위한 도구다. 티켓 재판매·대리예약·다중 계정 기능은 없다.

## 현재 상태

| 마일스톤 | 상태 |
|---|---|
| M0 하네스 | ✅ 완료 |
| M1 정찰 | ⛔ **미완료 — `audeum.org` 접근 가능한 환경에서 `/recon` 실행 필요** |
| M2 코어 로직 | ✅ 완료 (계약 비의존 부분) |
| M3 폴링 루프 | ⏳ M1 필요 |
| M4 이메일 | ⏳ |
| M5 대시보드 | ⏳ |
| M6 자동 예약 | ⏳ |
| M7 배포 | ⏳ |

`src/adapters/audeum/contract.ts`는 의도적으로 비어 있다. M1 정찰이 끝나기 전에
셀렉터나 엔드포인트를 추측해서 채우면 안 된다 — `assertContractReady`가 이를 강제한다.

## 구조

```
src/core/       사이트를 모르는 순수 로직 (타입·상태기계·매처·스케줄러·서킷·하트비트)
src/adapters/   사이트 계약이 격리되는 유일한 경계
tests/          전부 오프라인. 실제 사이트를 호출하지 않는다
docs/           site-contract.md · compliance.md · runbook.md
PROMPT.md       전체 요구사항과 마일스톤
CLAUDE.md       에이전트 작업 규칙
```

## 개발

```bash
pnpm install
pnpm verify      # typecheck + 테스트 (53개)
```

슬래시 커맨드: `/recon` `/dryrun` `/contract-check` `/verify`

## 다음 단계

1. `audeum.org` 접근이 가능한 환경에서 이 저장소를 열고 `/recon` 실행
2. `docs/compliance.md`의 robots.txt·약관 판정을 먼저 확인
   — 자동화 금지 조항이 있으면 **중단**
3. `docs/site-contract.md`를 채우고 `src/adapters/audeum/contract.ts`로 옮김
4. M3부터 순서대로 진행
