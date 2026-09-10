# 자동 예약 — 어디까지 되고, 무엇이 막고 있는가

> **결론부터: 사람 손을 완전히 뗀 무인 예약은 만들 수 없다.**
> 기술이 모자라서가 아니라, 오디움이 사람만 통과할 수 있는 관문을 두 개 세워
> 뒀기 때문이다. 그리고 그 관문을 뚫는 것은 이 프로젝트가 하지 않기로 한 일이다.
>
> 대신 **관문 직전까지 전부 자동으로 밀어 둘 수 있다.** 사람이 할 일은
> 문자로 온 숫자 네 자리를 넣는 것 하나로 줄어든다.

## 어떻게 확인했는가

15차 정찰에서 예약 화면까지 실제로 걸어갔다. **제출은 하지 않았다** —
예약 버튼과 인증번호 발송 버튼은 존재와 상태만 읽고 누르지 않았으며,
제출로 보이는 요청은 라우트 단계에서 끊도록 해 두었다
(`scripts/recon-payment-browser.mjs`).

예약 화면(28,841자)에서 읽어낸 입력 요소는 이렇다.

```
txt_reserveNm, txt_reserveTime, txt_reserveUserCnt, txt_reserveFee,
input_spectatorNm, input_spectatorEmail,
nation_korean, nation_foreigner, countrySelect,
phone, input_authCode,
chk_consent,
turnStilecontainer, cf-chl-widget-0a29f_response,
btn_reserve
```

그리고 결정적인 한 줄:

```
#btn_reserve 존재: true, disabled: true
```

**예약 버튼은 처음부터 비활성 상태다.**

## 관문 1 — 휴대폰 인증번호

화면 스크립트가 언제 예약 버튼이 열리는지 정확히 알려준다.

```js
//인증번호 발송
$('.telephone-inner-wrapper .send-num-btn').click(function(e){
    ...
    var service = { serviceName : "bookingService", methodName : "sendPhoneNumber" };
    var param = {
        "locale" : com.getLanguage(),
        "phoneNumber" : payment.itiPhone.getNumber(),
        "searchType": "exhibition",
        "selectedSeq": booking.seqExhibition,
        "reserveSeq" : booking.seqExhibitionReserveList
    };
    com.execAjax(options, service, param);
    // 성공 핸들러 안에서:
    //   $('.telephone-input-wrapper').slideDown();
    //   $('#btn_reserve').removeAttr("disabled");   ← 여기서 처음 열린다
    //   com.msg("인증번호를 전송하였습니다. 인증번호 4자리 입력 후 예약하기를 클릭하십시오.");
});
```

즉 순서가 이렇다.

```
휴대폰 번호 입력 → 인증번호 발송 → 문자 수신 → 4자리 입력 → 그제서야 예약 가능
```

**인증번호는 사용자 폰으로만 온다.** 서버가 받을 방법이 없다. 이건 우회할
대상이 아니라 설계 조건이다 — 오디움이 "대리 예매 및 양도 불가, 본인 이름으로
예약, 방문 시 실물 신분증 지참"을 내걸고 그것을 실제로 강제하는 장치다.

## 관문 2 — Cloudflare Turnstile (CAPTCHA)

```js
window.onloadTurnstileCallback = function () {
    turnstile.render('#turnStilecontainer', {
        sitekey: '0x4AAAAAAAdQ5H9BEBnqUgYB',
        callback: function(token) { payment.turnstileCheck = (token != undefined); },
    });
};

//예약하기
$('#btn_reserve').click(function(e){
    if (nationality.trim() == '') { com.msg("국적을 선택 해 주세요."); return; }
    if (!payment.turnstileCheck) { com.msg("사람인지 확인하십시오."); return; }
    if (booking.seqExhibitionReserveList == 0) { ... }
    ...
});
```

버튼을 눌러도 **"사람인지 확인"을 통과하지 못하면 거기서 멈춘다.**

`CLAUDE.md`의 NEVER 목록에 **"CAPTCHA 자동 해제 금지"**가 있다. 이건 편의상
둔 규칙이 아니다. Turnstile은 오디움이 자동 예매를 막으려고 돈을 주고 붙인
장치이고, 그걸 뚫는 것은 사이트 운영자의 명시적 의사에 반하는 행동이다.
할 수 있느냐와 무관하게 하지 않는다.

## 그래서 무엇을 만들 수 있는가 — 원터치 예약

관문은 **마지막 화면에만** 있다. 그 앞의 모든 것은 자동으로 할 수 있고,
실제로 자동으로 하고 있다.

| 단계 | 누가 | 걸리는 시간 |
|---|---|---|
| 빈자리 감시 (수~토, 10분마다) | 시스템 | — |
| 빈자리 감지 | 시스템 | 1.085초 |
| **사라졌는지 재확인** | 시스템 | 1초 |
| 회차 식별자(`seq_reserve`) 확보 | 시스템 | (재확인에 포함) |
| 폰으로 알림 | 시스템 | 즉시 |
| 예약 화면 열기 | 사람 | ~10초 |
| 이름·이메일 (미리 채워 알려 줌) | 사람 | ~10초 |
| **인증번호 4자리** | **사람 (불가피)** | ~20초 |
| 예약하기 | 사람 | 1초 |

사람이 실제로 들이는 시간은 **1분 남짓**이다. 사이트를 계속 들여다보는 일,
자리가 났는지 판단하는 일, 어느 회차인지 찾는 일은 전부 시스템이 한다.

취소표는 자리가 난 뒤 몇 분에서 몇 시간까지 남아 있으므로 — 실제로 관측한
사례에서 14:30 회차가 매진에서 여석으로 6분 만에 바뀌었다 — 이 정도면
사람이 놓치지 않는다.

## 코드에 남겨 둔 것

`src/booking-gate.ts`의 관문(`decideBookingMode`)과 `DRY_RUN` 장치는 그대로 둔다.
지금은 제출할 곳이 없지만, 구조가 있어야 나중에 조건이 바뀌었을 때
안전장치 없이 급하게 붙이는 일이 안 생긴다. 관문은 이렇게 동작한다.

- `DRY_RUN`이 **정확히 문자열 `'false'`**가 아니면 확인만 한다
- 예약자 이름과 이메일이 없으면 실제 예약으로 넘어가지 않는다
- 값이 없거나 모르는 값이면 전부 **안전한 쪽으로 떨어진다**

이 관문은 실제 사고에서 나왔다. 첫 시험 운전이 `inputs.dry_run == false`라는
워크플로 표현식 때문에 실제 예약 모드로 돌았다 — push에는 inputs가 없고
GitHub은 `null == false`를 참으로 본다. 없는 값이 위험한 쪽을 골랐던 것이다.
아무것도 예약되지 않은 것은 마침 자리가 없었기 때문이지 설계 덕분이 아니었다.

## 다시 볼 만한 조건

- 오디움이 인증을 없애거나 완화한다 (가능성 낮음 — 1인 1매 정책의 근간이다)
- 사용자가 **직접** 인증번호를 시스템에 전달할 방법을 만든다.
  기술적으로는 가능하지만, 휴대폰 인증 문자를 다른 곳으로 흘리는 구조는
  만들지 않는 편이 낫다.

두 경우 모두 사용자가 판단할 일이고, 지금 코드가 그 결정을 미리 내려놓지는 않는다.
