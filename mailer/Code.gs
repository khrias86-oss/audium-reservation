/**
 * 오디움 빈자리 알림 — 가족 메일 발송기 (Google Apps Script)
 *
 * 이 파일은 저장소 주인의 Google 계정에 올라간다 (script.google.com).
 * 설정 방법은 같은 폴더의 `설정방법.md`를 따른다.
 *
 * 왜 Apps Script인가
 *   - 메일은 **주인의 Gmail에서** 나간다. 비밀번호·앱 비밀번호를 어디에도 적지 않는다.
 *   - 가족 메일 주소는 **이 스크립트의 저장소(Script Properties)에만** 남는다.
 *     공개 저장소(GitHub)에는 한 글자도 남지 않는다 — 크롤러가 수집하지 못한다.
 *   - 공개 페이지에서 가족이 직접 주소를 등록할 수 있다 (초대 코드가 있어야 한다).
 *
 * 스크립트 속성 (설정 → 스크립트 속성)
 *   INVITE_CODE  초대 링크에 들어가는 코드. 이게 있어야 메일 등록·테스트를 할 수 있다.
 *   NOTIFY_KEY   GitHub Actions가 알림을 보낼 때 쓰는 열쇠. GitHub 시크릿 MAILER_KEY와 같은 값.
 *   (SUBSCRIBERS 는 스크립트가 알아서 관리한다 — 손대지 않아도 된다)
 */

var MAX_SUBSCRIBERS = 20;          // 가족용이다. 넘으면 누군가 초대 코드를 퍼뜨린 것이다.
var TEST_COOLDOWN_SECONDS = 600;   // 테스트 메일은 주소당 10분에 한 번
var EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function doPost(e) {
  var req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return reply({ ok: false, error: '요청을 읽지 못했습니다' });
  }

  var props = PropertiesService.getScriptProperties();
  var action = String(req.action || '');

  if (action === 'notify') {
    if (!props.getProperty('NOTIFY_KEY') || req.key !== props.getProperty('NOTIFY_KEY')) {
      return reply({ ok: false, error: '열쇠가 맞지 않습니다' });
    }
    var list = readSubscribers();
    var sent = 0;
    for (var i = 0; i < list.length; i++) {
      MailApp.sendEmail({ to: list[i], subject: String(req.subject || '오디움 알림'), body: withFooter(String(req.text || '')) });
      sent++;
    }
    return reply({ ok: true, sent: sent });
  }

  // 여기부터는 공개 페이지에서 오는 요청이다. 초대 코드가 있어야 한다.
  if (!props.getProperty('INVITE_CODE') || req.invite !== props.getProperty('INVITE_CODE')) {
    return reply({ ok: false, error: '초대 링크가 올바르지 않습니다. 초대 링크로 다시 들어와 주세요.' });
  }
  var email = String(req.email || '').trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email)) return reply({ ok: false, error: '메일 주소 형식이 올바르지 않습니다' });

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var subscribers = readSubscribers();
    var has = subscribers.indexOf(email) !== -1;

    if (action === 'subscribe') {
      if (!has) {
        if (subscribers.length >= MAX_SUBSCRIBERS) return reply({ ok: false, error: '등록 인원이 꽉 찼습니다' });
        subscribers.push(email);
        writeSubscribers(subscribers);
      }
      MailApp.sendEmail({
        to: email,
        subject: '오디움 빈자리 알림에 등록되었습니다',
        body: withFooter('이 메일이 보이면 등록이 끝난 것입니다.\n\n'
          + '빈자리가 나거나 예약이 열리면 이 주소로 바로 알려 드립니다.\n'
          + '혹시 스팸함에 있었다면 "스팸 아님"으로 표시해 주세요 — 진짜 알림을 놓치지 않게.'),
      });
      return reply({ ok: true, already: has });
    }

    if (action === 'unsubscribe') {
      if (has) writeSubscribers(subscribers.filter(function (s) { return s !== email; }));
      return reply({ ok: true, removed: has });
    }

    if (action === 'test') {
      if (!has) return reply({ ok: false, error: '아직 등록되지 않은 주소입니다' });
      var cache = CacheService.getScriptCache();
      if (cache.get('test:' + email)) return reply({ ok: false, error: '테스트 메일은 10분에 한 번만 보낼 수 있습니다' });
      cache.put('test:' + email, '1', TEST_COOLDOWN_SECONDS);
      MailApp.sendEmail({
        to: email,
        subject: '🔔 [테스트] 오디움 빈자리 알림',
        body: withFooter('테스트 알림입니다. 실제 알림도 이렇게 옵니다.\n\n휴대폰 메일 앱의 알림이 켜져 있는지 확인해 주세요.'),
      });
      return reply({ ok: true });
    }

    if (action === 'status') {
      return reply({ ok: true, subscribed: has });
    }
  } finally {
    lock.releaseLock();
  }

  return reply({ ok: false, error: '알 수 없는 요청입니다' });
}

/** 주소가 살아 있는지 브라우저로 열어 확인할 때 쓴다. 메일 주소는 돌려주지 않는다. */
function doGet() {
  return reply({ ok: true, service: 'audeum-mailer', subscribers: readSubscribers().length });
}

function readSubscribers() {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty('SUBSCRIBERS');
    var list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch (err) {
    return [];
  }
}

function writeSubscribers(list) {
  PropertiesService.getScriptProperties().setProperty('SUBSCRIBERS', JSON.stringify(list));
}

function withFooter(text) {
  return text + '\n\n---\n알림을 그만 받으려면 빈자리 알림 페이지의 "메일 알림 끄기"를 누르세요.';
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** 설정 직후 편집기에서 한 번 실행하세요 — 메일 보내기 권한을 승인하는 단계입니다. */
function authorize() {
  MailApp.sendEmail({
    to: Session.getEffectiveUser().getEmail(),
    subject: '오디움 메일 발송기 권한 확인',
    body: '이 메일이 오면 발송기 설정이 끝난 것입니다. 남은 메일 발송 한도: ' + MailApp.getRemainingDailyQuota(),
  });
}
