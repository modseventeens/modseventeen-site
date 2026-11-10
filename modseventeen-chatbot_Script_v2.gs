/**
 * modseventeen.com 後端（v2）
 * 功能：聊天機器人名單、電子報訂閱、實戰筆記資料來源、自動回信、3 天跟進信、每週摘要
 *
 * 安裝：在「modseventeen_官網聊天機器人名單」試算表 → 擴充功能 → Apps Script
 *      → 貼上本檔全部內容 → 儲存 → 執行 setup（授權）→ 部署為網頁應用程式
 */

// ====== 設定 ======
const NOTIFY_EMAIL     = 'modseventeen@gmail.com';
const SITE_URL         = 'https://modseventeen.com';
const BOOKING_PAID_URL = 'https://calendar.app.google/rDDUvxAxiAngauH37';   // Google 日曆「AI 流程健檢」預約頁網址
const BOOKING_FREE_URL = 'https://calendar.app.google/1qLYyqLUVWeni2n97';   // Google 日曆「15 分鐘適配確認」預約頁網址
const FOLLOW_UP_DAYS   = 3;    // 留資料幾天後寄跟進信
// ==================

const SHEET_LEADS = '名單';
const SHEET_SUBS  = '訂閱';
const SHEET_NOTES = '實戰筆記';

/* ---------- 網站送資料進來 ---------- */
function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
    const d = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const email = String(d.email || '').trim().toLowerCase();
    if (!isEmail_(email)) return json_({ ok: false, error: 'invalid email' });

    const isTest = !!d.env && !/(^|\.)modseventeen\.com$/.test(String(d.env));
    if (isTest) d.testLabel = '測試環境：' + d.env;

    if (d.type === 'subscribe') {
      const added = addSubscriber_(email, d.nickname, (isTest ? '[測試] ' : '') + (d.source || '網站訂閱'));
      if (added) sendWelcome_(email, d.nickname);
      return json_({ ok: true });
    }

    if (!d.nickname) return json_({ ok: false, error: 'missing nickname' });
    appendByHeader_(sheet_(SHEET_LEADS), {
      '時間': new Date(),
      '對話編號': d.sessionId,
      '意願等級': d.priority || '一般',
      '狀態': '新名單',
      '暱稱': d.nickname,
      'Email': email,
      '公司': d.company,
      'LINE ID': d.lineId,
      '主分類': d.category,
      '追問1': d.q1,
      '追問2': d.q2,
      '每週耗時': d.hours,
      '估算結果': d.estimate,
      '推薦方案': d.recommend,
      '自由描述': d.description,
      '點擊路徑': (d.path || []).join(' → '),
      '來源網址': d.referrer,
      'UTM': d.utm,
      '裝置': d.device,
      '同意告知時間': d.consentAt,
      '備註': d.testLabel || ''
    });
    notifyJustin_(d, email);
    autoReply_(d, email);
    return json_({ ok: true });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

/* ---------- 網站讀取實戰筆記；直接開網址可確認部署成功 ---------- */
function doGet(e) {
  if (e && e.parameter && e.parameter.type === 'notes') {
    return json_({ ok: true, notes: publishedNotes_(12) });
  }
  return ContentService.createTextOutput('modseventeen endpoint OK');
}

/* ---------- 第一次手動執行：授權＋建立排程 ---------- */
function setup() {
  [SHEET_LEADS, SHEET_SUBS, SHEET_NOTES].forEach(sheet_);
  MailApp.getRemainingDailyQuota();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (['followUpDaily', 'weeklySummary'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('followUpDaily').timeBased().everyDays(1).atHour(10).inTimezone('Asia/Taipei').create();
  ScriptApp.newTrigger('weeklySummary').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(9).inTimezone('Asia/Taipei').create();
}

/* ---------- 每天 10 點：留資料 3 天仍是「新名單」者，寄一封跟進信 ---------- */
function followUpDaily() {
  const sh = sheet_(SHEET_LEADS);
  const rows = readRows_(sh);
  const cutoff = Date.now() - FOLLOW_UP_DAYS * 86400000;
  const latest = publishedNotes_(1)[0];
  rows.forEach(function (r) {
    const t = r.data['時間'] instanceof Date ? r.data['時間'].getTime() : 0;
    if (r.data['狀態'] !== '新名單' || r.data['跟進信寄出'] || !t || t > cutoff) return;
    if (!isEmail_(r.data['Email'])) return;
    const body = [
      (r.data['暱稱'] || '你好') + ' 你好，',
      '',
      '前幾天你在 modseventeen.com 留下了「' + (r.data['主分類'] || 'AI 導入') + '」的諮詢，想確認一下你的狀況現在如何？',
      '',
      latest ? '分享一則最近的實戰筆記給你參考：\n【' + latest.title + '】\n' + latest.pain + '\n做法：' + latest.how + '\n成果：' + latest.result + '\n' : '',
      '如果想直接開始，有兩種方式：',
      '・AI 流程健檢（NT$3,000，費用可全額折抵後續建置）：' + bookingLink_(true),
      '・先免費聊 15 分鐘，確認適不適合：' + bookingLink_(false),
      '',
      '直接回覆這封信也可以。',
      '',
      'Justin Liao',
      SITE_URL
    ].join('\n');
    MailApp.sendEmail({ to: r.data['Email'], subject: '你的 AI 流程，還卡在哪一步？｜Justin Liao', body: body, name: 'Justin Liao' });
    setCell_(sh, r.row, '跟進信寄出', new Date());
  });
}

/* ---------- 每週一 9 點：寄給 Justin 的名單摘要 ---------- */
function weeklySummary() {
  const leads = readRows_(sheet_(SHEET_LEADS)).map(function (r) { return r.data; });
  const subs = readRows_(sheet_(SHEET_SUBS)).map(function (r) { return r.data; });
  const weekAgo = Date.now() - 7 * 86400000;
  const isThisWeek = function (x) { return x['時間'] instanceof Date && x['時間'].getTime() >= weekAgo; };
  const newLeads = leads.filter(isThisWeek);
  const hot = newLeads.filter(function (x) { return x['意願等級'] === '高'; });
  const pending = leads.filter(function (x) { return x['狀態'] === '新名單' || x['狀態'] === '已聯繫'; });
  const activeSubs = subs.filter(function (x) { return x['狀態'] === '訂閱中'; });
  const newSubs = subs.filter(isThisWeek);
  const body = [
    '本週名單摘要（過去 7 天）',
    '',
    '新名單：' + newLeads.length + ' 筆（高意願 ' + hot.length + ' 筆）',
    '新訂閱：' + newSubs.length + ' 人｜訂閱中總數：' + activeSubs.length + ' 人',
    '',
    '待跟進（狀態為「新名單」或「已聯繫」）：',
    pending.length ? pending.map(function (x) {
      return '・' + x['暱稱'] + '｜' + x['主分類'] + '｜' + x['意願等級'] + '｜' + x['狀態'] + '｜' + x['Email'];
    }).join('\n') : '（無）',
    '',
    '試算表：' + SpreadsheetApp.getActiveSpreadsheet().getUrl()
  ].join('\n');
  MailApp.sendEmail({ to: NOTIFY_EMAIL, subject: '[官網週報] 新名單 ' + newLeads.length + '｜待跟進 ' + pending.length, body: body });
}

/* ---------- 手動執行：把最新一則「發布」且未寄出的筆記寄給所有訂閱者 ---------- */
function sendLatestNote() {
  const notesSh = sheet_(SHEET_NOTES);
  const target = readRows_(notesSh)
    .filter(function (r) { return r.data['狀態'] === '發布' && !r.data['已寄送訂閱者']; })
    .sort(function (a, b) { return Number(b.data['編號']) - Number(a.data['編號']); })[0];
  if (!target) { Logger.log('沒有待寄送的筆記（狀態需為「發布」且「已寄送訂閱者」空白）'); return; }

  const subsSh = sheet_(SHEET_SUBS);
  const subs = readRows_(subsSh).filter(function (r) { return r.data['狀態'] === '訂閱中' && isEmail_(r.data['Email']); });
  const quota = MailApp.getRemainingDailyQuota();
  if (subs.length > quota) { Logger.log('今日寄信額度剩 ' + quota + ' 封，訂閱者 ' + subs.length + ' 人，請明天再寄或改用電子報工具'); return; }

  const n = target.data;
  subs.forEach(function (r) {
    const body = [
      (r.data['暱稱'] || '你好') + ' 你好，這是本週的 AI 實戰筆記：',
      '',
      '【No.' + n['編號'] + '】' + n['標題'],
      '',
      '痛點：' + n['痛點'],
      '做法：' + n['做法'],
      '成果：' + n['成果'],
      n['使用工具'] ? '使用工具：' + n['使用工具'] : '',
      '',
      '想把這套做法用在你的團隊？',
      '・AI 流程健檢（NT$3,000，可折抵建置費）：' + bookingLink_(true),
      '・免費 15 分鐘適配確認：' + bookingLink_(false),
      '',
      '更多筆記：' + SITE_URL + '/#notes',
      '',
      '— Justin Liao',
      '（不想再收到？直接回覆「取消訂閱」即可）'
    ].join('\n');
    MailApp.sendEmail({ to: r.data['Email'], subject: 'AI 實戰筆記 No.' + n['編號'] + '｜' + n['標題'], body: body, name: 'Justin Liao' });
    setCell_(subsSh, r.row, '最後寄送筆記', 'No.' + n['編號']);
  });
  setCell_(notesSh, target.row, '已寄送訂閱者', new Date());
  Logger.log('已寄出 No.' + n['編號'] + ' 給 ' + subs.length + ' 位訂閱者');
}

/* ===================== 內部工具 ===================== */

function notifyJustin_(d, email) {
  const fire = d.priority === '高' ? '🔥 ' : '';
  const body = [
    '官網聊天機器人收到一筆新諮詢：',
    '',
    '意願等級：' + (d.priority || '一般'),
    '暱稱：' + (d.nickname || ''),
    'Email：' + email,
    '公司：' + (d.company || '（未填）'),
    'LINE ID：' + (d.lineId || '（未填）'),
    '',
    '主分類：' + (d.category || ''),
    '追問 1：' + (d.q1 || ''),
    '追問 2：' + (d.q2 || ''),
    '每週耗時：' + (d.hours || ''),
    '估算結果：' + (d.estimate || ''),
    '推薦方案：' + (d.recommend || ''),
    '狀況描述：' + (d.description || '（未填）'),
    '',
    '點擊路徑：' + (d.path || []).join(' → '),
    '來源：' + (d.referrer || '直接進站') + (d.utm ? '｜' + d.utm : ''),
    '裝置：' + (d.device || ''),
    '',
    '直接回覆這封信即可回給對方。',
    '名單試算表：' + SpreadsheetApp.getActiveSpreadsheet().getUrl()
  ].join('\n');
  MailApp.sendEmail({
    to: NOTIFY_EMAIL, replyTo: email,
    subject: (d.testLabel ? '[測試] ' : '') + fire + '[官網諮詢] ' + (d.category || '未分類') + '｜' + (d.nickname || ''),
    body: body
  });
}

function autoReply_(d, email) {
  const body = [
    (d.nickname || '你好') + ' 你好，',
    '',
    '謝謝你在 modseventeen.com 留下諮詢，我已經收到了，會在 1 個工作天內親自回覆你。',
    '',
    '你剛剛提供的資訊：',
    '・主題：' + (d.category || ''),
    d.q1 ? '・' + d.q1 + (d.q2 ? '／' + d.q2 : '') : '',
    d.estimate ? '・初步估算：' + d.estimate : '',
    d.description ? '・狀況描述：' + d.description : '',
    '',
    '想更快開始，可以直接預約：',
    '・AI 流程健檢（NT$3,000，費用可全額折抵後續建置）：' + bookingLink_(true),
    '・免費 15 分鐘，確認適不適合：' + bookingLink_(false),
    '',
    '有任何補充，直接回覆這封信就好。',
    '',
    'Justin Liao',
    SITE_URL
  ].filter(function (x) { return x !== ''; }).join('\n');
  MailApp.sendEmail({ to: email, subject: '收到你的諮詢｜Justin Liao', body: body, name: 'Justin Liao', replyTo: NOTIFY_EMAIL });
}

function sendWelcome_(email, nickname) {
  const latest = publishedNotes_(1)[0];
  const body = [
    (nickname || '你好') + ' 你好，',
    '',
    '謝謝訂閱 AI 實戰筆記！之後每週會寄一則「拿去就能用」的 AI 自動化案例給你。',
    '',
    latest ? '先送上最新一則：\n【' + latest.title + '】\n痛點：' + latest.pain + '\n做法：' + latest.how + '\n成果：' + latest.result + '\n' : '',
    '所有筆記：' + SITE_URL + '/#notes',
    '',
    '— Justin Liao',
    '（不想再收到？直接回覆「取消訂閱」即可）'
  ].join('\n');
  MailApp.sendEmail({ to: email, subject: '歡迎訂閱 AI 實戰筆記｜Justin Liao', body: body, name: 'Justin Liao' });
}

function addSubscriber_(email, nickname, source) {
  const sh = sheet_(SHEET_SUBS);
  const exists = readRows_(sh).some(function (r) { return String(r.data['Email']).toLowerCase() === email; });
  if (exists) return false;
  appendByHeader_(sh, { '時間': new Date(), 'Email': email, '暱稱': nickname, '來源': source, '狀態': '訂閱中' });
  return true;
}

function publishedNotes_(limit) {
  return readRows_(sheet_(SHEET_NOTES))
    .map(function (r) { return r.data; })
    .filter(function (n) { return n['狀態'] === '發布' && n['標題']; })
    .sort(function (a, b) { return Number(b['編號']) - Number(a['編號']); })
    .slice(0, limit)
    .map(function (n) {
      return {
        no: n['編號'], date: n['日期'] instanceof Date ? Utilities.formatDate(n['日期'], 'Asia/Taipei', 'yyyy-MM-dd') : String(n['日期'] || ''),
        title: n['標題'], tag: n['標籤'], pain: n['痛點'], how: n['做法'], result: n['成果'], tools: n['使用工具']
      };
    });
}

function bookingLink_(paid) {
  const url = paid ? BOOKING_PAID_URL : BOOKING_FREE_URL;
  return url || (SITE_URL + '/#offers');
}

function sheet_(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(name);
  if (!sh) throw new Error('找不到工作表：' + name);
  return sh;
}

function readRows_(sh) {
  const last = sh.getLastRow();
  if (last < 2) return [];
  const values = sh.getRange(1, 1, last, sh.getLastColumn()).getValues();
  const headers = values[0];
  return values.slice(1).map(function (row, i) {
    const data = {};
    headers.forEach(function (h, j) { data[h] = row[j]; });
    return { row: i + 2, data: data };
  });
}

function appendByHeader_(sh, obj) {
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  sh.appendRow(headers.map(function (h) { return clean_(obj[h]); }));
}

function setCell_(sh, row, header, value) {
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const col = headers.indexOf(header) + 1;
  if (col > 0) sh.getRange(row, col).setValue(value);
}

function isEmail_(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '')); }

/** 限制長度，並避免以 = + - @ 開頭的內容被試算表當成公式執行 */
function clean_(v) {
  if (v === undefined || v === null) return '';
  if (v instanceof Date) return v;
  let s = String(v).slice(0, 1000);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return s;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
