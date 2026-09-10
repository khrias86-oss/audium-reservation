# 픽스처

## 합성 픽스처 (`synthetic-*.json`)

`src/core/`는 사이트를 모르는 순수 로직이므로, 정규화된 `Slot[]` 형태의 합성 데이터만으로
전부 테스트할 수 있다. 이 파일들이 그 용도다.

## 실측 픽스처 (M1에서 추가)

어댑터 테스트에는 **실제 사이트 응답**이 필요하다. `/recon` 실행 시 다음 5종을 저장한다:

- `all-available` — 전 회차 여석
- `partially-sold` — 일부만 매진
- `fully-sold-out` — 전 회차 매진
- `error-429` — rate limit 응답
- `malformed-schema` — 스키마가 깨진 응답 (CONTRACT_BROKEN 검증용)

개인정보가 섞여 있으면 마스킹한 뒤 저장한다.
