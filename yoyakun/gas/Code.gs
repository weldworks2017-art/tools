// よやくん — Google Apps Script バックエンド v1.0
// ============================================================
// セットアップ手順:
// 1. Google スプレッドシートを新規作成してIDをメモ
// 2. スプレッドシートのメニュー「拡張機能」→「Apps Script」を開く
// 3. このファイルの内容を貼り付け
// 4. CONFIG の各値を設定
// 5. 「デプロイ」→「新しいデプロイ」→種類:ウェブアプリ
//    実行ユーザー:自分, アクセス:全員 → デプロイ
// 6. 表示されたURLをreserve.jsのGAS_URLに貼り付け
// ============================================================

const CONFIG = {
  SPREADSHEET_ID: 'YOUR_SPREADSHEET_ID',       // スプレッドシートのID
  DISCORD_BOT_TOKEN: 'YOUR_BOT_TOKEN',          // くろかん２号のトークン
  OWNER_DISCORD_USER_ID: '1489271410600968375', // あなたのDiscordユーザーID（変更不要）
  ADMIN_PASSWORD: 'YOUR_ADMIN_PASSWORD',        // 管理画面のパスワード
  HOLIDAY_CALENDAR_ID: 'ja.japanese#holiday@group.v.calendar.google.com',
};

// ============================================================
// メインエントリーポイント（JSONP対応）
// ============================================================
function doGet(e) {
  const callback = e.parameter.callback;
  let result;

  try {
    const action = e.parameter.action;
    switch (action) {
      case 'getAvailableDates':  result = getAvailableDates(e.parameter);   break;
      case 'submitRequest':      result = submitRequest(e.parameter);        break;
      case 'getStatus':          result = getRequestStatus(e.parameter);     break;
      case 'getDropdowns':       result = getDropdownOptions();              break;
      case 'getUserInfo':        result = getUserInfo(e.parameter.token);    break;
      case 'getUserRequests':    result = getUserRequests(e.parameter);      break;
      case 'adminGetRequests':   result = adminGetRequests(e.parameter);     break;
      case 'adminUpdateStatus':  result = adminUpdateStatus(e.parameter);    break;
      case 'setup':              result = setupSpreadsheet();                break;
      default:                   result = { success: false, error: 'Unknown action' };
    }
  } catch (err) {
    result = { success: false, error: err.message };
    Logger.log(err);
  }

  const json = JSON.stringify(result);
  if (callback) {
    return ContentService.createTextOutput(callback + '(' + json + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// 空き日程取得
// ============================================================
function getAvailableDates(params) {
  const user = getUserByToken(params.token);
  if (!user) return { success: false, error: 'アクセスできません' };
  if (!user.isActive) return { success: false, error: 'このURLは現在停止中です' };

  const year  = parseInt(params.year);
  const month = parseInt(params.month);
  const rules = JSON.parse(user.rules || '{}');

  const today    = new Date(); today.setHours(0, 0, 0, 0);
  const firstDay = new Date(year, month - 1, 1);
  const lastDay  = new Date(year, month, 0);
  const nextDay  = new Date(lastDay.getTime() + 86400000);

  // オーナーカレンダーの予定
  const ownerBusy = new Set();
  CalendarApp.getDefaultCalendar().getEvents(firstDay, nextDay).forEach(ev => {
    const s = new Date(ev.getStartTime()); s.setHours(0,0,0,0);
    const e = new Date(ev.getEndTime());
    for (const d = new Date(s); d < e; d.setDate(d.getDate() + 1)) {
      ownerBusy.add(fmt(d));
    }
  });

  // 祝日
  const holidays = new Set();
  try {
    CalendarApp.getCalendarById(CONFIG.HOLIDAY_CALENDAR_ID)
      .getEvents(firstDay, nextDay)
      .forEach(ev => holidays.add(fmt(ev.getStartTime())));
  } catch(_) {}

  // 承認済み予約（週上限チェック用）
  const approved = getApprovedDatesInMonth(year, month);

  // 各日の状態を判定
  const availability = {};
  for (const d = new Date(firstDay); d <= lastDay; d.setDate(d.getDate() + 1)) {
    const ds  = fmt(d);
    const dow = d.getDay(); // 0=日

    if (d < today)                                     { availability[ds] = 'past';       continue; }
    if (dow === 0)                                     { availability[ds] = 'sunday';     continue; }
    if (holidays.has(ds))                              { availability[ds] = 'holiday';    continue; }
    if (ownerBusy.has(ds))                             { availability[ds] = 'busy';       continue; }

    const daysAhead = Math.floor((d - today) / 86400000);
    if (rules.minDaysAhead && daysAhead < rules.minDaysAhead) { availability[ds] = 'restricted'; continue; }
    if (rules.maxDaysAhead && daysAhead > rules.maxDaysAhead) { availability[ds] = 'tooFar';     continue; }

    if (rules.maxDaysPerWeek) {
      const wk = weekStart(d);
      const cnt = approved.filter(x => weekStart(new Date(x)) === wk).length;
      if (cnt >= rules.maxDaysPerWeek) { availability[ds] = 'weekFull'; continue; }
    }

    availability[ds] = 'available';
  }

  return { success: true, user: { name: user.name, rules: rules }, availability };
}

// ============================================================
// 予約リクエスト送信
// ============================================================
function submitRequest(params) {
  const user = getUserByToken(params.token);
  if (!user)         return { success: false, error: 'アクセスできません' };
  if (!user.isActive) return { success: false, error: 'このURLは現在停止中です' };

  const requestId = 'REQ-' + new Date().getTime();
  const now = new Date();

  const sheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID).getSheetByName('reservations');
  sheet.appendRow([
    requestId, params.token, user.name,
    params.date || '', params.days || '', params.content || '',
    params.region || '', params.processing || '', params.notes || '',
    'pending', now.toISOString(), now.toISOString()
  ]);

  sendDiscordDM(user, params, requestId);

  return { success: true, requestId };
}

// ============================================================
// リクエスト状態確認
// ============================================================
function getRequestStatus(params) {
  const data = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID)
    .getSheetByName('reservations').getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === params.requestId) {
      return { success: true, status: data[i][9], date: data[i][3], days: data[i][4], content: data[i][5] };
    }
  }
  return { success: false, error: '見つかりません' };
}

// ============================================================
// ドロップダウン選択肢
// ============================================================
function getDropdownOptions() {
  const data = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID)
    .getSheetByName('dropdown_options').getDataRange().getValues();
  const options = {};
  for (let i = 1; i < data.length; i++) {
    if (data[i][0]) options[data[i][0]] = String(data[i][1]).split(',').map(s => s.trim()).filter(Boolean);
  }
  return { success: true, options };
}

// ============================================================
// ユーザー情報
// ============================================================
function getUserInfo(token) {
  const user = getUserByToken(token);
  if (!user) return { success: false, error: 'Invalid token' };
  return { success: true, name: user.name, rules: JSON.parse(user.rules || '{}'), isActive: user.isActive };
}

// ============================================================
// 管理API
// ============================================================
function adminGetRequests(params) {
  if (params.password !== CONFIG.ADMIN_PASSWORD) return { success: false, error: 'Unauthorized' };
  const data = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID)
    .getSheetByName('reservations').getDataRange().getValues();
  const rows = [];
  for (let i = 1; i < data.length; i++) {
    rows.push({
      id: data[i][0], token: data[i][1], name: data[i][2],
      date: data[i][3], days: data[i][4], content: data[i][5],
      region: data[i][6], processing: data[i][7], notes: data[i][8],
      status: data[i][9], createdAt: data[i][10]
    });
  }
  return { success: true, requests: rows.reverse() };
}

function adminUpdateStatus(params) {
  if (params.password !== CONFIG.ADMIN_PASSWORD) return { success: false, error: 'Unauthorized' };
  const ss    = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sheet = ss.getSheetByName('reservations');
  const data  = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === params.requestId) {
      sheet.getRange(i + 1, 10).setValue(params.status); // status列
      sheet.getRange(i + 1, 12).setValue(new Date().toISOString()); // updatedAt

      if (params.status === 'approved') {
        // Googleカレンダーに登録
        try {
          const date = new Date(data[i][3]);
          const days = parseInt(data[i][4]) || 1;
          const end  = new Date(date); end.setDate(end.getDate() + days);
          CalendarApp.getDefaultCalendar().createAllDayEvent(
            `[よやくん] ${data[i][2]}（${data[i][5]}）`, date, end
          );
        } catch(e) { Logger.log('Calendar error: ' + e); }
      }

      return { success: true };
    }
  }
  return { success: false, error: '見つかりません' };
}

// ============================================================
// Discord DM 送信
// ============================================================
function sendDiscordDM(user, params, requestId) {
  try {
    const dmRes = UrlFetchApp.fetch('https://discord.com/api/v10/users/@me/channels', {
      method: 'post',
      headers: { 'Authorization': 'Bot ' + CONFIG.DISCORD_BOT_TOKEN, 'Content-Type': 'application/json' },
      payload: JSON.stringify({ recipient_id: CONFIG.OWNER_DISCORD_USER_ID }),
      muteHttpExceptions: true
    });
    const channelId = JSON.parse(dmRes.getContentText()).id;

    const lines = [
      '📅 **新しい予約リクエスト**',
      `ID: \`${requestId}\``,
      `予約者: ${user.name}`,
      `日程: ${params.date}`,
      `日数: ${params.days || '—'}日`,
      `内容: ${params.content || '—'}`,
      `地域: ${params.region || '—'}`,
      `加工: ${params.processing || '—'}`,
    ];
    if (params.notes) lines.push(`備考: ${params.notes}`);
    lines.push('', `✅ 承認 → 管理画面で操作`);

    UrlFetchApp.fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'post',
      headers: { 'Authorization': 'Bot ' + CONFIG.DISCORD_BOT_TOKEN, 'Content-Type': 'application/json' },
      payload: JSON.stringify({ content: lines.join('\n') }),
      muteHttpExceptions: true
    });
  } catch(e) {
    Logger.log('Discord error: ' + e.message);
  }
}

// ============================================================
// スプレッドシート初期セットアップ（一回だけ実行）
// ============================================================
function setupSpreadsheet() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);

  // users シート
  let users = ss.getSheetByName('users');
  if (!users) { users = ss.insertSheet('users'); }
  if (users.getLastRow() === 0) {
    users.appendRow(['id', 'name', 'token', 'rules', 'isActive', 'createdAt']);
    users.appendRow([
      'user-001', 'Aさん', 'token-a',
      JSON.stringify({ minDaysAhead: 0, maxDaysAhead: 90 }),
      true, new Date().toISOString()
    ]);
    users.appendRow([
      'user-002', 'Bさん', 'token-b',
      JSON.stringify({ minDaysAhead: 14, maxDaysAhead: 90 }),
      true, new Date().toISOString()
    ]);
    users.appendRow([
      'user-003', 'Cさん', 'token-c',
      JSON.stringify({ minDaysAhead: 14, maxDaysAhead: 90, maxDaysPerWeek: 3, maxConsecutive: 3 }),
      true, new Date().toISOString()
    ]);
    users.appendRow([
      'user-004', 'Dさん', 'token-d',
      JSON.stringify({ minDaysAhead: 0, maxDaysAhead: 90, requestOnly: true }),
      true, new Date().toISOString()
    ]);
  }

  // reservations シート
  let res = ss.getSheetByName('reservations');
  if (!res) { res = ss.insertSheet('reservations'); }
  if (res.getLastRow() === 0) {
    res.appendRow(['requestId', 'token', 'name', 'date', 'days', 'content', 'region', 'processing', 'notes', 'status', 'createdAt', 'updatedAt']);
  }

  // dropdown_options シート
  let dd = ss.getSheetByName('dropdown_options');
  if (!dd) { dd = ss.insertSheet('dropdown_options'); }
  if (dd.getLastRow() === 0) {
    dd.appendRow(['field', 'options']);
    dd.appendRow(['content',    '溶接,切断,組立,仕上げ,その他']);
    dd.appendRow(['days',       '1日,2日,3日,4日以上（要相談）']);
    dd.appendRow(['region',     '北海道,東北,関東,中部,近畿,中国,四国,九州,沖縄']);
    dd.appendRow(['processing', 'あり,なし']);
  }

  return { success: true, message: 'セットアップ完了' };
}

// ============================================================
// ユーザー自身のリクエスト一覧
// ============================================================
function getUserRequests(params) {
  const user = getUserByToken(params.token);
  if (!user) return { success: false, error: 'アクセスできません' };
  const data = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID)
    .getSheetByName('reservations').getDataRange().getValues();
  const rows = [];
  for (let i = 1; i < data.length; i++) {
    if (data[i][1] === params.token) {
      rows.push({ id: data[i][0], date: data[i][3], days: data[i][4], content: data[i][5], status: data[i][9], createdAt: data[i][10] });
    }
  }
  return { success: true, requests: rows.reverse() };
}

// ============================================================
// ユーティリティ
// ============================================================
function getUserByToken(token) {
  const data = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID)
    .getSheetByName('users').getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][2] === token) {
      return { id: data[i][0], name: data[i][1], token: data[i][2], rules: data[i][3], isActive: data[i][4] !== false && data[i][4] !== 'FALSE' };
    }
  }
  return null;
}

function getApprovedDatesInMonth(year, month) {
  const data = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID)
    .getSheetByName('reservations').getDataRange().getValues();
  return data.slice(1)
    .filter(r => r[9] === 'approved' && r[3])
    .map(r => r[3])
    .filter(d => { const x = new Date(d); return x.getFullYear() === year && x.getMonth() + 1 === month; });
}

function fmt(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}

function weekStart(d) {
  const x = new Date(d); x.setHours(0,0,0,0); x.setDate(x.getDate() - x.getDay()); return fmt(x);
}
