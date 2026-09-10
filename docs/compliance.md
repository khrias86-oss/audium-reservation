# 준수 사항 (Compliance)

> **상태: 미확인 — M1 정찰의 단계 0에서 가장 먼저 채운다**

## robots.txt

```
(미확인 — `curl -sS https://audeum.org/robots.txt` 결과를 원문 그대로 붙인다)
```

**판정**: 미확인

## 이용약관

**자동화 관련 조항**: 미확인 (해당 조항 원문을 인용할 것)

**판정**: 미확인

> ⚠️ robots.txt 또는 이용약관이 자동화를 명시적으로 금지한다면
> **즉시 개발을 중단하고 사용자에게 보고한다.** 우회하지 않는다.

## 코드로 강제하는 준수 항목

| 항목 | 강제 위치 | 테스트 |
|---|---|---|
| 폴링 주기 5분 하한 | `src/core/scheduler.ts` `MIN_INTERVAL_MINUTES` | `tests/scheduler.test.ts` |
| 사용자 지정 범위 밖 예약 금지 | `src/core/matcher.ts` `selectClaimTarget` | `tests/matcher.test.ts` |
| 1인 1매 | `src/core/matcher.ts` (BOOKED 사용자 제외) | `tests/matcher.test.ts` |
| 동시 1건만 시도 | `selectClaimTarget`이 단일 대상 반환 | `tests/matcher.test.ts` |
| 계약 미확정 시 실행 차단 | `src/adapters/audeum/contract.ts` | `tests/contract-guard.test.ts` |
| DRY_RUN 게이트 | 어댑터 `submitBooking` (M6) | 미구현 |

## 하지 않는 것

- 봇 탐지 회피 (프록시 로테이션, UA 위조, 헤드리스 은닉, CAPTCHA 자동 해제)
- 티켓 재판매, 대리예약, 다중 계정
- CAPTCHA·본인인증 자동 통과 — 이 지점에서는 사람에게 넘긴다 (`NEEDS_HUMAN`)

## 노쇼 방지

예약 성공 메일과 대시보드에 **취소 방법**을 함께 안내한다.
사전 통보 없는 불참은 향후 예약 제한 사유이므로, 가지 못하게 되면 즉시 취소해야 한다.
