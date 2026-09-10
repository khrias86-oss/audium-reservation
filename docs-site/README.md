# 감시 신청 페이지

`index.html` 하나짜리 정적 페이지다. 서버도, 빌드도, 의존성도 없다.

## 무엇을 하는가

폰에서 관람 종류·회차·날짜를 **눌러서** 고르게 하고, 고른 것을 미리 채워진
GitHub 이슈 주소로 넘긴다. 이슈가 감시 목록이자 알림 채널이므로, 이 페이지가
직접 들고 있어야 할 상태가 없다 — 토큰도, 로그인도, 백엔드도 필요 없다.

## 어디에 올려져 있는가

**https://claude.ai/code/artifact/1af3e850-4a59-4c2d-8501-39bb6548f72a**
(비공개. 소유자만 열린다.)

GitHub Pages를 쓰지 않은 이유는 하나다. **Pages는 private 저장소에서 무료
플랜으로 동작하지 않는다** (Pro 이상이 필요하다). 이 저장소를 public으로
바꾸면 Pages를 쓸 수 있고, 덤으로 Actions 시간도 무제한이 된다 —
다만 감시 신청 이슈(어떤 날짜에 가고 싶은지)도 함께 공개된다.
바꿀지 말지는 사용자가 정할 일이라 그대로 두었다.

저장소를 public으로 바꾸기로 했다면:

```
Settings → General → Danger Zone → Change visibility → Public
Settings → Pages → Source: Deploy from a branch → main / docs-site
```

## 고칠 때 주의할 것

- `REPO` 상수가 이슈 주소를 만든다. 저장소 이름이 바뀌면 여기도 바꾼다.
- `ROUNDS`와 `OPEN_DOW`는 **정찰로 실측한 값**이다 (`docs/site-contract.md`).
  사이트가 회차나 운영 요일을 바꾸면 여기만 고치면 된다.
- 달력 드래그는 `#days`의 `touch-action: none`에 의존한다. 지우면 사파리가
  그 제스처를 스크롤로 가져가 드래그가 죽는다.
- 신청서를 **자동으로 여러 개 열지 않는다.** 그렇게 하면 첫 건에서 현재 창이
  넘어가며 나머지가 사라지거나 팝업 차단에 걸리고, 사용자는 빠진 줄 모른다.
