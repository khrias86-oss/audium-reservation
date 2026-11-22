# 빈자리 알림 신청 페이지

`index.html` 하나짜리 정적 페이지다. 빌드도, 의존성도 없다. 누구나 쓰는 **한 화면**이다
(예전의 가족/관리자 화면, GitHub 토큰, 이슈 신청서, 초대 코드는 모두 없앴다).

## 무엇을 하는가

```
달력(data/availability.json) → 날짜 → 회차 고르기 → 메일 + 동의 → [빈자리 알림 신청]
                                                      └─ 또는 [다음 예약 오픈 알림 받기]
        │ POST (text/plain JSON)
        ▼
알림 서버 (mailer/Code.gs, 주인 Google 계정의 Apps Script) → 구글 시트에 저장, 확인 메일
        │ 응답: 신청별 ntfy 채널 + 회차별 취소 토큰
        ▼
신청 완료 화면: ntfy 3단계 안내(설치 → 채널 붙여넣기 → 테스트 푸시)
"이 기기에서 신청한 알림": localStorage에 남긴 신청 목록, [알림 끄기]
```

- **달력**은 감시 워크플로가 커밋하는 `data/availability.json`(이번 달·다음 달의 실측
  매진/여석)을 그대로 그린다 — 요일 규칙 같은 추측이 아니다. 조회에 실패한 날은 점선
  **확인 불가**, 다음 오픈 추정치는 **"예상"** 이라고 표시한다.
- **알림 서버 주소**는 `config.json`(`{"mailerUrl": …}`)에서 읽는다. 이 파일은 커밋하지 않고
  `pages.yml`이 배포 때 저장소 변수 `MAILER_URL`로 만든다. 없으면 "준비 중"을 보여주고
  신청 버튼을 끈다.
- 요청 본문은 **`text/plain`** 이다. `application/json`이면 브라우저가 사전 요청(OPTIONS)을
  보내는데 Apps Script 웹 앱은 그걸 받지 못한다.
- **신청 1건 = 메일 주소 1개 + ntfy 채널 1개.** 같은 신청에서 고른 회차들은 채널을 같이 쓰고,
  다른 메일로 다시 신청하면 채널도 새로 생긴다. 끄기는 회차 단위(토큰)다.
- 맨 아래 상태 줄은 알림 서버의 `status`(진행 중 신청 수, 마지막 확인 시각)다.

## 어디에 올려져 있는가

**https://khrias86-oss.github.io/audium-reservation/** (GitHub Pages, `.github/workflows/pages.yml`)

Claude 아티팩트 미리보기는 개발 중 확인용 사본일 뿐이다. 그 안에서는 CSP가 외부 `fetch`를
막아 신청이 되지 않는다 (`looksLikePreview()`가 이 경우를 짚어 안내한다).

### Pages 켜는 법 (한 번만, 사람이 직접)

1. 저장소 **Settings → Pages → Build and deployment → Source: GitHub Actions**
2. Actions 탭 → `📄 감시 신청 페이지 배포` → **Run workflow**

Actions의 기본 토큰에는 Pages *사이트를 새로 만들* 권한이 없고 이미 켜진 곳에 *배포할*
권한뿐이다(`Resource not accessible by integration`). 저장소 설정을 바꾸는 일이라 봇에게
열어두지 않는 것이고, 워크플로 쪽에서 우회하지 않는다.

## 페이지가 공개되어도 안전한 이유

- 페이지에는 비밀이 없다. 알림 서버 주소는 원래 공개로 불리는 주소다
- 신청자 메일 주소는 **알림 서버(주인의 구글 시트)에만** 간다. 공개 저장소에는 남지 않고,
  감시 시스템(GitHub Actions)도 받지 않는다 — 감시 쪽은 "어느 회차를 볼지"만 받는다
- 알림 발송(`report`·`opening`)은 열쇠(`MAILER_KEY`)가 있어야 해서, 페이지에서 가짜
  "자리 났다"를 보낼 수 없다
- 이 기기에서 신청한 목록(취소 토큰 포함)은 그 브라우저의 `localStorage`에만 있다
- 이름·전화번호는 받지 않는다. 오디움 예약 화면을 바깥에서 미리 채울 방법이 없어서
  받아 봐야 쓸 데가 없다 — 대신 휴대폰 자동완성을 안내한다

## 고칠 때 주의할 것

- 달력은 **회차나 운영 요일을 하드코딩하지 않는다.** `data/availability.json`만 그린다.
- 만료 규칙(회차 시작 1시간 전)은 알림 서버(`EXPIRE_BEFORE_START_MS`)와 같아야 한다.
  어긋나면 서버가 거절할 회차를 고르게 하거나, 끝난 신청을 목록에 남긴다.
- 알림 서버의 요청·응답 모양을 바꾸면 이 페이지, `src/notify/alert-server.ts`,
  `tests/alert-server-script.test.ts`를 함께 고친다.
