# 오디움 사이트 계약 (Site Contract)

> **상태: 부분 확정 — 정찰 진행 중 (3회 실행 완료)**
>
> 이 문서는 `audeum.org/booking`의 실제 구조를 **실측으로** 확정해 기록하는 곳이다.
> 아래 표의 "미확인"이 하나라도 남아 있으면 `src/adapters/audeum/contract.ts`를
> 채우지 않으며, 어댑터는 실행 시 예외를 던진다 (`assertContractReady`).
>
> 채우는 방법: `/recon` 슬래시 커맨드 실행.

## 어떻게 조사하는가

Claude Code 세션은 egress 정책으로 `audeum.org`에 접근할 수 없다. 대신 **GitHub
Actions 러너**에서 정찰을 돌린다 (`.github/workflows/recon.yml`). 러너는 별개
네트워크를 쓰므로 PC 없이도 조사가 가능하다. `recon-run` 브랜치에 푸시하면 실행된다.

여전히 **추측으로 채우지 않는다.** 아래 "실측 확인" 항목만 근거가 있는 것이고,
나머지는 미확인으로 남겨 `assertContractReady()`가 어댑터 실행을 막는다.

## 실측으로 확인된 사실 (정찰 1~3차)

| 항목 | 값 | 확인 방법 |
|---|---|---|
| robots.txt | 404 — **단, 대기열/오류 공용 템플릿일 수 있어 재확인 필요** | 1~5차 |
| 서버 | nginx/1.24.0 | 응답 헤더 |
| `/booking` 역할 | **티켓 종류 선택 페이지** ("Reserve / Select ticket") | 렌더된 본문 353자 |
| 예약 가능 상품 | ① **EXHIBITIONS** — Jung Eum: In Search of Sound (FREE)<br>② **LECTURE** — Listening to France (FREE) | `/booking` 본문 |
| 하위 예약 경로 | `/booking/exhbition` (사이트 자체 오타), `/programs/booking` | 네트워크 캡처 |
| 하위 경로 직접 접근 | 본문 33~46자, 제목 비어 있음 → **파라미터 없이는 캘린더가 렌더되지 않음** | 2차 정찰 |
| JSON API | **캡처 0건** — SSR이거나 슬롯 정보가 HTML에 직접 있음 | 1~3차 모두 |
| iframe | 0개 | 3차 정찰 |
| 강의 프로그램 정보 | "Listening to France" — 2026년 7/29, 8/26, 10:00-12:00 / 14:00-16:00, 성인 20세 이상 | `/programs` 본문 |
| 사이트 언어 | EN/KR 전환 있음 (정찰은 기본 EN으로 진행됨) | 네비게이션 |

**중요:** JSON API가 없다는 것은 `deploy/README.md`의 **경로 B(브라우저 필요)**로
확정됐다는 뜻이다. 폴링에 Playwright가 필요하므로 배포 사양을 그에 맞춰야 한다.

**주의:** 정찰이 기본 영어 페이지에서 진행됐다. 한국어 페이지(KR)의 구조와 회차
표기가 다를 수 있으므로, 계약 확정 전에 KR 쪽도 확인해야 한다.

## 🚨 가상 대기열 (5차 정찰에서 발견 — 설계에 반영 필수)

사이트는 **가상 대기열(virtual waiting room)**을 운영한다. 혼잡 시 실제 페이지 대신
아래 페이지를 반환한다.

```
동시접속자가 많아 잠시 대기 중입니다.
We are currently experiencing a high volume of traffic.
Please give us a moment.
새로고침 (Refresh)
```

- HTTP 상태는 **200**이고 본문 텍스트는 약 119자, HTML은 약 5,469자
- 새로고침 버튼: `onclick="top.location='javascript:location.reload()'"`
- 예약 하위 경로들이 계속 빈 껍데기로 나온 원인이 이것으로 보인다
- **`/robots.txt`의 404 응답도 같은 템플릿**(동일한 base64 로고)을 쓴다.
  따라서 "robots.txt 404 = 파일 없음" 판정은 **대기열/오류 공용 템플릿을 본
  결과일 수 있어 재확인이 필요하다.**

### 왜 이것이 결정적인가

대기열 페이지를 잘못 분류하면 시스템이 조용히 실패한다.

| 잘못된 처리 | 결과 |
|---|---|
| "여석 없음"으로 취급 | **빈자리가 나도 영원히 못 잡는다.** 최악의 실패 |
| "파싱 깨짐"으로 취급 | 정상 상황인데 `CONTRACT_BROKEN` 경고가 계속 울린다 |
| 일시 오류로 취급 | 서킷 브레이커가 열려 감시가 멈춘다 |

**대기열은 독립된 상태로 다뤄야 한다** — "사이트가 나중에 오라고 했다"는 뜻이지,
자리가 없다는 뜻도 우리가 깨졌다는 뜻도 아니다. `ParseResult`에 `QUEUED`를 추가했다.

### 운영상 함의

- 대기열이 있다는 것은 사이트가 **부하를 명시적으로 관리 중**이라는 뜻이다.
  폴링 주기 하한(5분)을 더욱 지켜야 하고, 대기열을 만나면 **더 길게 물러나야 한다.**
- 자동 예약도 대기열을 통과해야 하므로, 감지 후 즉시 예약이 실패할 수 있다.
  재시도 로직이 대기열을 인식해야 한다.

## 🔓 6차 정찰 돌파: 한국어 로케일이 실물을 열었다

브라우저 로케일을 `ko-KR`로 설정하자 페이지가 실제 마크업을 반환했다.
2~5차가 "빈 껍데기"를 본 것은 로케일 문제였을 가능성이 크다.

### 이 페이지들은 페이지가 아니라 AJAX 파셜이다

`/booking/exhbition`과 `/programs/booking`은 **부모 페이지 `/booking`에 주입되는
HTML 조각**이다. 그래서 제목이 비어 있고 본문이 17~24자였다. 콘솔의
`booking is not defined` 오류가 결정적 증거다 — 조각을 단독으로 열어 부모의
전역 객체가 없었던 것이다.

**6회 실행 내내 JSON이 0건이었던 이유도 이것이다.** 이 플로우는 JSON API가 아니라
HTML 조각을 주고받는다. 찾을 API가 애초에 없었다.

### 기술 스택

- **Angular** (`ng-star-inserted`) + **Clarity Design System** (`clr-col-*`, `cds-icon`)
- **jQuery** 기반 AJAX 플로우 (인라인 스크립트)
- 서버: nginx/1.24.0

### 대기열의 정체: NetFunnel

```js
NetFunnel_Action({action_id: "act_3"}, function () { programs.selDate(seq); });
```

대기열은 자체 구현이 아니라 **NetFunnel**(한국 트래픽 제어 솔루션)이다.
중요한 것은 **대기열이 사이트 앞단이 아니라 예약 플로우 *안에* 있다**는 점이다 —
연령 선택 후 날짜 조회 직전에 게이트가 걸린다.

### 확인된 예약 플로우

```
/booking (부모)
  └─ 상품 선택 (.exhibition-item 클릭, 숨겨진 <seq>에서 id 추출)
       └─ POST /programs/age          → .exhibition-wrapper 에 주입
            └─ NetFunnel_Action(act_3) ← 대기열 게이트
                 └─ selDate(seq)      → .exhibition-date-wrapper 에 주입
                      └─ (회차·잔여석) → .payment-form
```

### 확인된 식별자

| 항목 | 값 |
|---|---|
| 전시(정음: 소리의 여정) `seq` | **1** |
| 렉처(프랑스 소리의 역사) `seq` | **7** |
| `resType` 종류 | `LECTURE`, `PERFORMANCE`, `TOUR`, `WORKSHOP` |
| 확인된 엔드포인트 | `POST /programs/age` |
| NetFunnel action_id | `act_3` |
| 인원 파라미터 | `normalCount`, `youthCount`, `seniorCount` (+ 성별 체크박스) |
| DOM 컨테이너 | `.exhibition-wrapper`(연령), `.exhibition-date-wrapper`(날짜), `.payment-form`(결제) |
| 상품 목록 셀렉터 | `.exhibition-list-container .exhibition-item.program` / `.exhibition` |
| 선택 표시 | `.selected` 클래스 + `.selected-indicator` |

**주의:** 도슨트 투어 예약은 `resType`이 `TOUR`일 가능성이 높으나 미확인이다.

## 🎯 8차 정찰: 엔드포인트와 매진 로직 확보

인라인 스크립트에서 계약의 대부분을 추출했다. **전시와 렉처가 대칭 구조**다.

### 엔드포인트

| 단계 | 전시(도슨트) | 렉처 | 주입 대상 |
|---|---|---|---|
| ① 연령·인원 | `/booking/age` | `/programs/age` | `.exhibition-wrapper` |
| ② 날짜 목록 | `/booking/date` | `/programs/date` | `.exhibition-date-wrapper` |
| ③ **회차·여석** | **`/booking/time`** | `/programs/time`(추정) | — |
| ④ 제출 | `/booking/payment` | `/programs/payment` | `.payment-form` |

**`/booking/time`은 9차 정찰에서 실제로 클릭해 흐름을 따라가다 발견했다.**
8차의 스크립트 추출로는 잡히지 않았는데, 날짜를 고른 뒤에야 호출되기 때문이다.
사이트 주석("시간을 선택하면 매진 여부를 체크")과 정확히 일치한다 —
**여석의 최종 근거는 이 단계다.**

응답은 **JSON이 아니라 HTML 조각**이며 해당 컨테이너에 `.html(e)`로 주입된다.

### 전체 플로우 (전시 기준)

```
/booking (부모 — booking 전역 객체 보유)
  └─ .exhibition-item.exhibition 클릭 (숨은 <seq>=1)
       └─ POST /booking/age              → .exhibition-wrapper
            └─ NetFunnel_Action(act_3)   ← 대기열 게이트
                 └─ booking.selDate(seq)
                      └─ POST /booking/date        → .exhibition-date-wrapper
                           └─ bookingDate.selTime(spectateDate)
                                └─ POST /booking/payment → .payment-form
```

- 상품 클릭은 **3초 쿨다운**이 걸려 있다 (`isClick` 플래그 + `setTimeout 3000`)
- `NetFunnel_Complete()` 로 게이트를 닫는다

### 사이트 소스가 알려준 매진 로직

사이트 자체 주석이 판별 방식을 그대로 설명한다.

```js
//4) 시간을 선택하면 매진 여부를 체크하고 예약정보 확인 및 결제화면 보이기
//매진시 재조회
//예약 가능한 경우만 값 셋팅
//예약가능한 시간이 아닌경우
com.msg("예약가능한 시간이 아닙니다.");
```

**핵심:** 매진 판별은 **회차(시간) 선택 시점**에 이루어지고, 매진이면 **재조회**한다.
즉 날짜 목록에 회차가 보인다고 예약 가능한 것이 아니다 — 시간을 고른 뒤에야 확정된다.
`"예약가능한 시간이 아닙니다."` 는 매진/마감을 알리는 확실한 문자열 신호다.

### 상태 변수와 폼 필드

| 이름 | 역할 |
|---|---|
| `booking.spectateDate` / `programs.spectateDate` | 선택된 관람일 |
| `booking.spectateTime` / `programs.spectateTime` | 선택된 회차 |
| `btn_reserve` | **제출 버튼 — 절대 클릭하지 않는다** |
| `input_spectatorNm` | 예약자 이름 |
| `input_spectatorEmail` | 예약자 이메일 |
| `txt_reserveTime` | 표시용 "날짜. 회차" |
| `txt_reserveUserCnt`, `txt_reserveFee`, `txt_reserveNm` | 표시용 |

예약자 입력이 **이름과 이메일뿐**으로 보인다 — 본인인증 단계는 아직 발견되지 않았다.

## 아직 확인하지 못한 것 (계약의 핵심)

- **`/booking/date` 응답 HTML의 구조** — 날짜·회차가 어떤 마크업으로 오는지 (9차 목표)
- 매진 회차가 DOM에서 어떻게 구분되는지 (disabled? 클래스? 클릭 후에만 판별?)
- `/booking/age`·`/booking/date` 의 **필수 POST 파라미터**
- NetFunnel 게이트를 자동화에서 통과하는 방법
- 본인인증 요구 여부 (현재까지는 이름·이메일만 확인됨)
- 회차별 잔여석을 어떻게 표기하는가
- 매진을 무엇으로 판별하는가
- 예약 폼 필드와 제출 방식
- 본인인증 요구 여부

## 계약 표

| 항목 | 값 | 확인 방법 | 확인 일시 |
|---|---|---|---|
| 렌더링 방식 (SSR/SPA) | 미확인 | | |
| 월별 가용일 조회 | 미확인 | | |
| 슬롯(회차) 조회 | 미확인 | | |
| 예약 제출 | 미확인 | | |
| 매진 판별 신호 (1순위) | 미확인 | | |
| 매진 판별 신호 (2순위) | 미확인 | | |
| 회차 정의 (실제 시각 목록) | 미확인 | | |
| 운영일 규칙 | 미확인 | | |
| 예약 오픈 규칙 | 미확인 | | |
| 인증 요구 (없음/본인인증/로그인) | 미확인 | | |
| robots.txt 관련 조항 | 미확인 | | |
| Rate limit 징후 | 미확인 | | |

## 검증해야 할 가설

아래는 2차 출처(블로그·지역언론) 기반의 **가설**이다. 신뢰도가 낮으므로
정찰 결과가 다르면 **가설을 버리고 실측을 따른다.**

| 가설 | 출처 신뢰도 | 검증 결과 |
|---|---|---|
| 운영일은 목·금·토 | 중 (복수 출처 일치) | 미검증 |
| 회차는 10:00 / 11:00 / 13:30 / 14:30 / 15:30 | 중 | 미검증 |
| 예약 오픈은 매주 화 14:00 차주분 | **낮 (출처 간 상충 — "2주 전"이라는 설명도 있음)** | 미검증 |
| 1인 1매, 본인 명의만, 대리예약 불가 | 중 | 미검증 |
| 예약 완료 시 QR 티켓 이메일 5분 내 발송 | 낮 | 미검증 |
| 취소는 이메일 링크로만 가능 | 낮 | 미검증 |
| 취소표는 관람 1~2일 전·당일 오전에 발생 | 낮 | 미검증 |

## 정찰 결과 요약

_(M1 완료 후 작성)_

---

## 🚀 11~14차 정찰: 브라우저가 필요 없었다

11차에서 처음으로 **요청**을 캡처했다. 10차까지는 응답만 알았기 때문에, 그 응답을
얻어내려고 브라우저로 클릭을 흉내내고 있었다. 캡처해 보니 회차 조회는 이랬다.

```
POST https://audeum.org/booking/time
content-type: application/x-www-form-urlencoded; charset=UTF-8
referer: https://audeum.org/booking
(쿠키 없음)

locale=ko&spectateDate=2026-09-10&seqExhibition=1&language=ko
```

**쿠키도, 토큰도, 선행 요청도 없다.** 브라우저는 이 POST를 만들어내려고 돌리던
것이지 답을 얻는 데 필요한 것이 아니었다.

| | 브라우저 방식 | HTTP 방식 |
|---|---|---|
| 확인 1회 | 약 44초 (설치 23 + 조작 21) | **1.085초** (실측, 12차) |
| 의존성 | Playwright + 크로미움 | `fetch` |
| 실패 지점 | 렌더 타이밍·셀렉터·클릭 쿨다운 | HTTP 상태 코드 |

NetFunnel 대기열은 **결제 앞**에 걸려 있어서(`act_3`), 조회는 통과할 필요조차 없다.
페이지 자체에도 게이트가 있지만(`act_1`), 조각 엔드포인트는 그것과 무관하게 응답한다.

### 상품 식별자

| 상품 | 파라미터 | 값 |
|---|---|---|
| 전시 《정음(正音): 소리의 여정》 | `seqExhibition` | `1` |
| 렉처 〈프랑스를 듣다〉 | `seqProgram` | `7` |

값이 틀리면 4xx가 온다. 그래서 어댑터는 4xx를 **계약 파손**으로 올린다 —
"자리 없음"으로 넘기면 사이트 개편을 영영 눈치채지 못한다. 5xx는 사이트 장애이므로
일시 오류로 다룬다.

## 📅 사이트가 공지한 운영 일정 (12차, `/booking/date` 응답)

```
[다음 예약일 안내]
전시 《정음(正音): 소리의 여정》
  예약 오픈 일시 : 9월 22일(화) 오후 2시
  예약 가능일   : 9월 24, 26일 & 10월 1, 2, 3일 (목, 금, 토)
* 오디움은 2026년 9월 25일(금) 추석 당일 휴관합니다.
* 전시 예약은 격주 화요일 오후 2시(KST)에 오픈됩니다.
```

이 공지가 **폴링 시간표의 근거**다. 전시는 목·금·토만 열리고 예약은 격주로 오픈되므로,
상시 폴링은 대부분의 시간을 헛돈다. `watch.yml`은 수~토 09~22시(KST)로 좁혀
월 약 1,370분을 쓴다 (무료 한도 2,000분).

## 🔑 14차 정찰: 예약 흐름의 정의를 찾았다

`booking` 객체는 조각에도, 외부 번들에도 없었다. `/booking` 페이지의 인라인
스크립트는 1,011자짜리 NetFunnel 게이트 하나뿐이다. 흐름의 정의는 **흐름 문서**에
있었다 — `GET /programs/booking` (9,258자)이 렉처 쪽 전체를 담고 있고,
전시 쪽은 대칭이다.

### 요청 헬퍼 (`/js/common.js`)

```js
com.execController = function(options, param) {
    if(param.language == null || param.language == "") param.language = com.getLanguage();
    $.ajax({ url: options.url, data: param, type:'POST', cache:false, async: options.async||false,
             success: options.submitDoneHandler, error: options.submitErrorHandler });
};
```

폼 인코딩 POST 하나다. 우리 어댑터가 보내는 것과 정확히 같다.

### 결제 화면 호출

```js
programs.selPayment = function(seqReserve, isMove){
    programs.seqProgramReserveList = 0;
    if( $(".payment-form").children().length <= 0 ){
        var options = { url : "/programs/payment", async: false,
            submitDoneHandler : function(e){ $(".payment-form").html(e); ... },
            submitErrorHandler : function(e){
                //매진시 재조회
                if(e.responseJSON.rsMsg.message == "soldout"){ programDate.selTime(programDate.spectateDate); }
            } };
        var param = {"locale" : com.getLanguage(), "seqProgramReserveList" : seqReserve};
        com.execController(options, param);
    } else {
        var service = {serviceName : "bookingService", methodName : "isSoldoutCheckProgram"};
        var param = {"locale" : com.getLanguage(), "seqProgramReserveList" : seqReserve};
        com.execAjax(options, service, param);
    }
};
```

두 가지가 중요하다.

1. **파라미터 이름은 `seqExhibitionReserveList`다** (렉처는 `seqProgramReserveList`).
   10차에 캡처한 회차 조각이 예약 직전에 `booking.seqExhibitionReserveList = 0`을
   초기화하는 것이 전시 쪽 대칭의 증거다.
2. **매진은 서버가 `rsMsg.message == "soldout"`으로 알려준다.** 우리는 조각의
   `disabled-time-slots` 클래스로 판별하는데, 이건 사이트 자신의 클릭 핸들러와
   같은 규칙이므로 유효하다. 다만 **회차를 고른 뒤 서버가 한 번 더 확인한다**는
   뜻이므로, 감지와 예약 사이에 자리가 사라질 수 있다.

### 🚨 예약 폼에 휴대폰 본인인증이 있다

같은 함수의 뒷부분이 결제 화면의 입력 요소를 다룬다.

```js
$("#input_spectatorNm").val(programs.param.spectatorNm);
$("#input_spectatorEmail").val(programs.param.spectatorEmail);
programPayment.input.value = programs.param.spectatorMobilephone;

$(programPayment.input).attr('disabled', true);
$('.telephone-inner-wrapper .send-num-btn').hide();

$("#btn_reserve").removeAttr("disabled");
```

읽어야 할 것은 **마지막 세 줄이 "기존 예약 변경"일 때만 실행된다**는 점이다.
새 예약에서는 휴대폰 입력이 열려 있고, `.send-num-btn`(인증번호 발송)이 보이며,
`#btn_reserve`는 **disabled인 채로 시작한다.**

즉 예약을 완료하려면 **문자로 온 인증번호를 사람이 입력해야 한다.**

이것은 우회할 대상이 아니라 **설계 조건**이다. 인증번호는 사용자 폰으로만 오고,
본인확인을 자동으로 뚫는 코드는 `CLAUDE.md`가 금지한다. 오디움 자신도
"대리 예매 및 양도 불가, 본인 이름으로 예약, 실물 신분증 지참"을 명시한다.

따라서 자동 예약의 현실적인 최대치는 **인증번호 직전까지 자동으로 밀어 두고,
사람은 번호 하나만 넣는 것**이다. 자세한 설계는 `docs/auto-booking.md`.
