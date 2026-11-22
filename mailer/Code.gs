/**
 * 오디움 빈자리 알림 서버 (Google Apps Script)
 *
 * 저장소 주인의 Google 계정(script.google.com)에 한 번 올려 두는 작은 서버다.
 * 설정 방법은 같은 폴더의 `설정방법.md`.
 *
 * ## 하는 일
 *
 *   공개 페이지 ──(신청·취소)──▶ 이 서버 ──▶ 구글 시트(신청 목록)
 *   GitHub Actions ──(5분마다: 무엇을 볼지 묻고, 본 결과를 알림)──▶ 이 서버 ──▶ 메일 · ntfy 푸시
 *
 * - 메일은 **이 스크립트를 올린 계정의 Gmail에서** 나간다. 비밀번호를 어디에도 적지 않는다.
 * - 신청자 메일 주소는 **이 계정의 구글 시트에만** 있다. 공개 저장소(GitHub)에는 남지 않는다.
 *   GitHub Actions도 "어느 회차를 볼지"만 받고, 누구에게 보낼지는 모른다.
 * - 신청 1건마다 메일 주소와 ntfy 채널이 따로 있다. 알림은 그 신청자에게만 간다.
 *
 * ## 알림 규칙 (빈자리)
 *
 *   자리가 보이면 즉시 1번 보낸다. 10분 뒤 다시 확인해 아직 남아 있으면 1번 더,
 *   없어졌으면 그 알림은 끝이다. 같은 신청은 회차 시작 1시간 전까지 계속 지켜보다가
 *   다음 취소표가 나면 다시 처음부터 알린다. 확인 한 번에 알림은 많아야 한 번이다.
 *
 * ## 스크립트 속성 (setup()이 만든다)
 *   SHEET_ID     신청 목록 시트
 *   NOTIFY_KEY   GitHub Actions가 쓰는 열쇠 (GitHub 시크릿 MAILER_KEY와 같은 값)
 */

var SHEET_NAME = '신청';
var HEADERS = ['id', 'token', 'kind', 'product', 'date', 'time', 'email', 'topic',
  'createdAt', 'lastAlertAt', 'episode', 'soonFor'];

var RECHECK_MS = 10 * 60 * 1000;            // 같은 신청에 다시 알리기까지 (10분)
var RECHECK_SLACK_MS = 60 * 1000;           // 5분 간격 확인이 몇 초 일찍 와도 10분으로 친다
var EXPIRE_BEFORE_START_MS = 60 * 60 * 1000; // 회차 시작 1시간 전에 감시를 끝낸다
var OPEN_TTL_MS = 60 * 24 * 3600 * 1000;    // 오픈 알림 신청은 60일 지나면 정리한다
var MAX_AHEAD_MS = 120 * 24 * 3600 * 1000;  // 120일 넘게 먼 날짜는 잘못 넣은 값으로 본다
var MAX_SLOTS_PER_REQUEST = 30;
var CONFIRM_RESERVE = 20;                   // 남은 발송 한도가 이만큼 이하면 확인 메일은 건너뛴다 (알림 우선)

var PRODUCT_NAME = { exhibition: '전시', lecture: '렉처' };
var BOOKING_URL = 'https://audeum.org/booking';
var NTFY_SERVER = 'https://ntfy.sh';
var SENDER_NAME = '오디움 빈자리 알림';
var EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
var DOW = ['일', '월', '화', '수', '목', '금', '토'];

/* ────────────────────────── 입구 ────────────────────────── */

function doPost(e) {
  var req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json({ ok: false, error: '요청을 읽지 못했습니다' });
  }
  try {
    return json(handle(req, Date.now()));
  } catch (err) {
    return json({ ok: false, error: String((err && err.message) || err) });
  }
}

/** 메일의 "그만 받기" 링크와 상태 확인이 GET으로 온다. */
function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.a === 'cancel') {
    var r = withLock(function () { return cancel(p.id, p.t); });
    return html(r.ok ? '알림을 껐습니다' : '이미 꺼진 알림입니다',
      r.ok ? '이 회차 알림을 더는 보내지 않습니다. 다른 회차가 필요하면 페이지에서 다시 신청하세요.'
        : '이미 취소됐거나 회차가 끝난 알림입니다.');
  }
  return json(status(Date.now()));
}

function handle(req, now) {
  var action = String(req.action || '');

  // 공개 페이지에서 오는 요청 — 누구나 쓸 수 있다.
  if (action === 'subscribe') return withLock(function () { return subscribe(req, now); });
  if (action === 'cancel') return withLock(function () { return cancel(req.id, req.token); });
  if (action === 'status') return status(now);

  // 감시 시스템(GitHub Actions) 전용 — 열쇠가 있어야 한다. 없으면 아무나 가짜
  // "자리 났다"를 보내 신청자들에게 메일을 뿌릴 수 있다.
  var key = PropertiesService.getScriptProperties().getProperty('NOTIFY_KEY');
  if (!key || req.key !== key) return { ok: false, error: '열쇠가 맞지 않습니다' };

  if (action === 'wants') return withLock(function () { return wants(now); });
  if (action === 'report') return withLock(function () { return report(req.observations || [], now); });
  if (action === 'opening') return withLock(function () { return opening(req, now); });
  return { ok: false, error: '알 수 없는 요청입니다' };
}

/* ────────────────────────── 신청 · 취소 ────────────────────────── */

function subscribe(req, now) {
  var email = String(req.email || '').trim().toLowerCase();
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) return { ok: false, error: '메일 주소 형식이 올바르지 않습니다' };
  var product = String(req.product || 'exhibition');
  if (!PRODUCT_NAME[product]) return { ok: false, error: '알 수 없는 프로그램입니다' };
  var kind = req.kind === 'open' ? 'open' : 'slot';

  var wanted = [];
  if (kind === 'slot') {
    var slots = Array.isArray(req.slots) ? req.slots : [];
    if (slots.length === 0) return { ok: false, error: '회차를 하나 이상 골라 주세요' };
    if (slots.length > MAX_SLOTS_PER_REQUEST) return { ok: false, error: '한 번에 ' + MAX_SLOTS_PER_REQUEST + '개까지 신청할 수 있습니다' };
    var seen = {};
    for (var i = 0; i < slots.length; i++) {
      var date = String(slots[i].date || '');
      var time = String(slots[i].time || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return { ok: false, error: '날짜·회차 형식이 올바르지 않습니다' };
      var start = slotStartMs(date, time);
      if (!(start - EXPIRE_BEFORE_START_MS > now)) return { ok: false, error: shortDate(date) + ' ' + time + ' 회차는 곧 시작하거나 이미 지났습니다' };
      if (start - now > MAX_AHEAD_MS) return { ok: false, error: '너무 먼 날짜입니다' };
      if (!seen[date + ' ' + time]) { seen[date + ' ' + time] = true; wanted.push({ date: date, time: time }); }
    }
  } else {
    wanted.push({ date: '', time: '' });
  }

  var topic = 'audeum-' + randomId().slice(0, 20);
  var rows = prune(loadRows(), now);
  var items = [];
  for (var j = 0; j < wanted.length; j++) {
    var w = wanted[j];
    // 같은 사람이 같은 것을 다시 신청하면 새 신청으로 바꾼다 — 메일이 두 번 오지 않게.
    rows = rows.filter(function (r) {
      return !(r.email === email && r.kind === kind && r.product === product && r.date === w.date && r.time === w.time);
    });
    var row = {
      id: randomId(), token: randomId(), kind: kind, product: product, date: w.date, time: w.time,
      email: email, topic: topic, createdAt: String(now), lastAlertAt: '', episode: '0', soonFor: '',
    };
    rows.push(row);
    items.push({ id: row.id, token: row.token, kind: kind, product: product, date: w.date, time: w.time });
  }
  saveRows(rows);

  var mailed = false;
  if (MailApp.getRemainingDailyQuota() > CONFIRM_RESERVE) {
    try {
      MailApp.sendEmail({ to: email, subject: '✅ 오디움 빈자리 알림 신청 완료', body: confirmationText(kind, product, items, topic), name: SENDER_NAME });
      mailed = true;
    } catch (err) {
      mailed = false; // 확인 메일이 안 나가도 신청은 유지한다. 페이지가 결과를 보여준다.
    }
  }
  return { ok: true, topic: topic, items: items, mailed: mailed };
}

function cancel(id, token) {
  var rows = loadRows();
  var kept = rows.filter(function (r) { return !(r.id === String(id || '') && r.token === String(token || '') && r.token !== ''); });
  if (kept.length === rows.length) return { ok: false, error: '이미 취소됐거나 없는 신청입니다' };
  saveRows(kept);
  return { ok: true };
}

function status(now) {
  var rows = prune(loadRows(), now);
  var last = Number(PropertiesService.getScriptProperties().getProperty('LAST_REPORT_AT') || 0);
  return { ok: true, service: 'audeum-alerts', active: rows.length, lastReportAt: last ? new Date(last).toISOString() : null };
}

/* ────────────────────────── 감시 시스템 전용 ────────────────────────── */

/** 지금 지켜봐야 할 회차 목록. 메일 주소는 돌려주지 않는다. */
function wants(now) {
  var before = loadRows();
  var rows = prune(before, now);
  if (rows.length !== before.length) saveRows(rows);
  var slots = [];
  var seen = {};
  var opens = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (r.kind === 'open') {
      if (opens.indexOf(r.product) === -1) opens.push(r.product);
      continue;
    }
    var k = r.product + '|' + r.date + '|' + r.time;
    if (seen[k]) continue;
    seen[k] = true;
    slots.push({ product: r.product, date: r.date, time: r.time });
  }
  return { ok: true, slots: slots, opens: opens, subscriptions: rows.length };
}

/**
 * 이번 확인 결과. observations: [{product, date, time, available, subject, text, click}]
 * 이번에 확인하지 못한 회차는 아예 빠져서 온다 — 그 신청의 상태는 건드리지 않는다.
 */
function report(observations, now) {
  PropertiesService.getScriptProperties().setProperty('LAST_REPORT_AT', String(now));
  var byKey = {};
  for (var i = 0; i < observations.length; i++) {
    var o = observations[i];
    byKey[o.product + '|' + o.date + '|' + o.time] = o;
  }
  var rows = prune(loadRows(), now);
  var tally = { alerted: 0, mailed: 0, pushed: 0, failed: 0 };
  for (var j = 0; j < rows.length; j++) {
    var r = rows[j];
    if (r.kind !== 'slot') continue;
    var ob = byKey[r.product + '|' + r.date + '|' + r.time];
    if (!ob) continue;
    var d = decideAlert(r, ob.available === true, now);
    r.episode = d.episode;
    r.lastAlertAt = d.lastAlertAt;
    if (!d.send) continue;
    tally.alerted++;
    deliver(r, String(ob.subject || '오디움 빈자리 알림'), String(ob.text || ''), String(ob.click || BOOKING_URL), 5, ['tada'], tally);
  }
  saveRows(rows);
  return { ok: true, alerted: tally.alerted, mailed: tally.mailed, pushed: tally.pushed, failed: tally.failed };
}

/**
 * 빈자리 알림을 지금 보낼지 정한다. 순수 함수 — 테스트가 이걸 직접 부른다.
 *
 *   자리 없음                     → 보내지 않고 알림을 끝낸다 (episode 0)
 *   자리 있음, 알림 중이 아님      → 즉시 보낸다
 *   자리 있음, 알림 중, 10분 지남  → 재확인됐으니 한 번 더 보낸다
 *   자리 있음, 알림 중, 10분 안 됨 → 보내지 않는다
 */
function decideAlert(row, available, now) {
  var last = Number(row.lastAlertAt || 0);
  if (!available) return { send: false, episode: '0', lastAlertAt: row.lastAlertAt || '' };
  if (row.episode !== '1') return { send: true, episode: '1', lastAlertAt: String(now) };
  if (now - last >= RECHECK_MS - RECHECK_SLACK_MS) return { send: true, episode: '1', lastAlertAt: String(now) };
  return { send: false, episode: '1', lastAlertAt: row.lastAlertAt };
}

/**
 * 예약 오픈 알림. event: 'soon'(오픈 예고, at = 예상 시각) | 'opened'(열림).
 * 예고는 같은 예상 시각에 한 번만, 열림을 알리면 그 신청은 끝난다.
 */
function opening(req, now) {
  var product = String(req.product || '');
  var event = req.event === 'opened' ? 'opened' : 'soon';
  var at = String(req.at || '');
  var rows = prune(loadRows(), now);
  var tally = { alerted: 0, mailed: 0, pushed: 0, failed: 0 };
  var kept = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (r.kind !== 'open' || r.product !== product) { kept.push(r); continue; }
    if (event === 'soon') {
      if (r.soonFor !== at) {
        tally.alerted++;
        deliver(r, String(req.subject || ''), String(req.text || ''), String(req.click || BOOKING_URL), 4, ['alarm_clock'], tally);
        r.soonFor = at;
      }
      kept.push(r);
    } else {
      tally.alerted++;
      deliver(r, String(req.subject || ''), String(req.text || ''), String(req.click || BOOKING_URL), 5, ['loudspeaker'], tally);
      // 열림을 알렸으니 이 신청은 끝났다. 남겨 두지 않는다.
    }
  }
  saveRows(kept);
  return { ok: true, alerted: tally.alerted, mailed: tally.mailed, pushed: tally.pushed, failed: tally.failed };
}

/* ────────────────────────── 발송 ────────────────────────── */

function deliver(row, subject, text, click, priority, tags, tally) {
  var body = text + '\n\n' + footerFor(row);
  try {
    if (MailApp.getRemainingDailyQuota() > 0) {
      MailApp.sendEmail({ to: row.email, subject: subject, body: body, name: SENDER_NAME });
      tally.mailed++;
    } else {
      tally.failed++; // 오늘 발송 한도를 다 썼다. 푸시는 그래도 간다.
    }
  } catch (err) {
    tally.failed++;
  }
  try {
    var res = UrlFetchApp.fetch(NTFY_SERVER, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ topic: row.topic, title: subject, message: text, click: click, priority: priority, tags: tags }),
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() < 300) tally.pushed++;
    else tally.failed++;
  } catch (err) {
    tally.failed++;
  }
}

function cancelUrl(row) {
  return ScriptApp.getService().getUrl() + '?a=cancel&id=' + encodeURIComponent(row.id) + '&t=' + encodeURIComponent(row.token);
}

function footerFor(row) {
  return '---\n'
    + (row.kind === 'open' ? '이 오픈 알림 그만 받기: ' : '이 회차 알림 그만 받기 (예약했다면 눌러 주세요): ') + cancelUrl(row) + '\n'
    + '휴대폰 푸시(ntfy) 채널: ' + row.topic;
}

function confirmationText(kind, product, items, topic) {
  var lines = [];
  if (kind === 'open') {
    lines.push(PRODUCT_NAME[product] + ' 다음 예약이 열리면 이 주소로 알려 드립니다.');
    lines.push('');
    lines.push('- 오픈 약 1시간 30분 전에 예고 한 번, 실제로 열리면 한 번 보냅니다.');
    lines.push('- 열림을 알린 뒤 이 신청은 자동으로 끝납니다.');
    lines.push('- 그만 받기: ' + cancelUrl({ id: items[0].id, token: items[0].token }));
  } else {
    lines.push('아래 회차에 빈자리가 나면 이 주소로 바로 알려 드립니다.');
    lines.push('');
    for (var i = 0; i < items.length; i++) {
      lines.push('- ' + PRODUCT_NAME[product] + ' ' + shortDate(items[i].date) + ' ' + items[i].time
        + '  (그만 받기: ' + cancelUrl({ id: items[i].id, token: items[i].token }) + ')');
    }
    lines.push('');
    lines.push('알림 규칙: 자리가 나면 즉시 1번 보내고, 10분 뒤 다시 확인해 아직 남아 있으면 1번 더 보냅니다.');
    lines.push('회차 시작 1시간 전에 자동으로 끝납니다.');
  }
  lines.push('');
  lines.push('📱 휴대폰 푸시로도 받기 (선택, 무료·가입 없음)');
  lines.push('1) ntfy 앱 설치 (App Store / Play 스토어에서 "ntfy")');
  lines.push('2) 앱에서 ＋ 를 누르고 채널 이름에 ' + topic + ' 을 넣은 뒤 Subscribe');
  lines.push('   이 채널에는 이번 신청 알림만 옵니다.');
  lines.push('');
  lines.push('이 메일이 스팸함에 있었다면 "스팸 아님"으로 표시해 주세요 — 진짜 알림을 놓치지 않게.');
  return lines.join('\n');
}

/* ────────────────────────── 저장 (구글 시트) ────────────────────────── */

function sheet() {
  var id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!id) throw new Error('setup()을 먼저 실행해 주세요');
  var ss = SpreadsheetApp.openById(id);
  return ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
}

function loadRows() {
  var values = sheet().getDataRange().getValues();
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var v = values[i];
    if (!v[0]) continue;
    var row = {};
    for (var c = 0; c < HEADERS.length; c++) row[HEADERS[c]] = cellText(v[c]);
    rows.push(row);
  }
  return rows;
}

/** 시트는 '2026-12-04'나 '10:00'을 날짜·시각으로 바꿔 버린다. 저장 때 글자 형식으로 막고, 읽을 때도 되돌린다. */
function cellText(value) {
  if (Object.prototype.toString.call(value) === '[object Date]') {
    if (value.getFullYear() <= 1900) return pad(value.getHours()) + ':' + pad(value.getMinutes());
    return value.getFullYear() + '-' + pad(value.getMonth() + 1) + '-' + pad(value.getDate());
  }
  return value === null || value === undefined ? '' : String(value);
}

function saveRows(rows) {
  var sh = sheet();
  var data = [HEADERS];
  for (var i = 0; i < rows.length; i++) {
    data.push(HEADERS.map(function (h) { return rows[i][h] === undefined || rows[i][h] === null ? '' : String(rows[i][h]); }));
  }
  sh.clearContents();
  sh.getRange(1, 1, data.length, HEADERS.length).setNumberFormat('@').setValues(data);
}

/** 끝난 신청을 뺀다 — 회차가 곧 시작하거나 지난 것, 너무 오래된 오픈 알림. 메일 주소를 오래 들고 있지 않는다. */
function prune(rows, now) {
  return rows.filter(function (r) { return !isExpired(r, now); });
}

function isExpired(row, now) {
  if (row.kind === 'open') return now - Number(row.createdAt || 0) > OPEN_TTL_MS;
  return now >= slotStartMs(row.date, row.time) - EXPIRE_BEFORE_START_MS;
}

/* ────────────────────────── 도우미 ────────────────────────── */

function slotStartMs(date, time) {
  return Date.parse(date + 'T' + time + ':00+09:00');
}

function shortDate(date) {
  var d = new Date(date + 'T00:00:00Z');
  return Number(date.slice(5, 7)) + '/' + Number(date.slice(8, 10)) + '(' + DOW[d.getUTCDay()] + ')';
}

function pad(n) { return (n < 10 ? '0' : '') + n; }

function randomId() { return Utilities.getUuid().replace(/-/g, ''); }

function withLock(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function html(title, message) {
  return HtmlService.createHtmlOutput(
    '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<div style="font:16px/1.6 -apple-system,sans-serif;max-width:420px;margin:48px auto;padding:0 16px">'
    + '<h2 style="font-size:20px">' + title + '</h2><p>' + message + '</p></div>',
  ).setTitle(title);
}

/* ────────────────────────── 처음 한 번 ────────────────────────── */

/**
 * 설정 직후 편집기에서 한 번 실행하세요.
 * 신청 목록 시트와 감시 시스템용 열쇠를 만들고, 그 값을 본인 메일로 보냅니다.
 * 다시 실행해도 이미 있는 시트와 열쇠는 그대로 둡니다.
 */
function setup() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('SHEET_ID')) {
    var ss = SpreadsheetApp.create('오디움 빈자리 알림 — 신청 목록');
    ss.getSheets()[0].setName(SHEET_NAME);
    props.setProperty('SHEET_ID', ss.getId());
    saveRows([]);
  }
  if (!props.getProperty('NOTIFY_KEY')) props.setProperty('NOTIFY_KEY', randomId() + randomId());

  var sheetUrl = SpreadsheetApp.openById(props.getProperty('SHEET_ID')).getUrl();
  var text = [
    '오디움 빈자리 알림 서버 설정이 끝났습니다.',
    '',
    'GitHub 시크릿 MAILER_KEY 에 넣을 값:',
    props.getProperty('NOTIFY_KEY'),
    '',
    '신청 목록 시트: ' + sheetUrl,
    '',
    '다음: 배포 → 새 배포 → 웹 앱 (실행: 나, 액세스: 모든 사용자) → 웹 앱 URL을 GitHub 변수 MAILER_URL 에 넣으세요.',
    '남은 오늘 메일 발송 한도: ' + MailApp.getRemainingDailyQuota(),
  ].join('\n');
  MailApp.sendEmail({ to: Session.getEffectiveUser().getEmail(), subject: '오디움 빈자리 알림 서버 설정값', body: text, name: SENDER_NAME });
  Logger.log(text);
}
