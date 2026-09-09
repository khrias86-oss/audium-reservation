---
description: audeum.org/booking 구조를 실측하고 site-contract.md를 갱신한다
---

`PROMPT.md` §1.4 정찰 프로토콜을 순서대로 수행하라. 절대 건너뛰지 말 것.

**단계 0 — 준수 확인 (가장 먼저)**
`curl -sS https://audeum.org/robots.txt`와 이용약관을 확인하고 `docs/compliance.md`에
원문을 인용해 기록한다. 자동화를 명시적으로 금지한다면 **즉시 중단하고 사용자에게 보고**하라.
우회를 시도하지 말 것.

**단계 1 — 정적 표면**
`curl -sSI`로 상태코드·서버·쿠키를 보고, HTML을 받아 `__NEXT_DATA__` / `window.__NUXT__` /
`__INITIAL_STATE__` / 빈 `<div id="root">` / 프레임워크 지문을 찾는다. SSR인지 SPA인지 판정.

**단계 2 — 네트워크 캡처**
Playwright로 페이지를 열고 모든 xhr/fetch 요청·응답을 기록한다. 그리고 사용자 행동을
하나씩 재현하며 트래픽을 diff한다:
1. 최초 로드 → 월별 가용 날짜 API
2. 날짜 A 클릭 → 슬롯 조회 API
3. 날짜 B 클릭 → 어떤 파라미터가 바뀌는가 (날짜 형식 확정)
4. **매진 날짜 vs 여석 날짜 응답을 각각 저장해 diff** → 매진 판별 필드 확정
5. 예약 폼 진입 → 필드·hidden·CSRF·본인인증 iframe 확인 (**제출 금지**)

**단계 3 — 매진 판별 방식 확정**
API 필드(`remain`/`capacity`/`status`) / DOM 클래스(`.sold-out`/`disabled`/`aria-disabled`) /
텍스트("마감"/"매진"/"예약마감") / 요소 부재 중 실제로 무엇인지 판정하고, 다중 신호로
교차 검증할 수 있게 1·2순위를 정한다.

**단계 4 — 문서화**
`docs/site-contract.md`의 표를 "미확인" 없이 전부 채운다. 확인 방법과 확인 일시를 함께 적는다.

**단계 5 — 픽스처 저장**
`tests/fixtures/`에 최소 5종 저장: `all-available` `partially-sold` `fully-sold-out`
`error-429` `malformed-schema`. 개인정보가 섞였으면 마스킹한다.

마지막에 §0.3의 가설과 실측이 다른 항목을 표로 정리해 사용자에게 보고하라.
