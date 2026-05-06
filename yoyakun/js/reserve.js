// よやくん — 予約ページ JS v1.0
'use strict';

// ★ここを自分のGASデプロイURLに変更する
const GAS_URL = 'https://script.google.com/macros/s/AKfycbySfJ-3w38y8BFGTer5eqomxFRcL-P9XyQdEYD7UpR7iNyf9gdEK2XhCLCVaM4wVSgpTA/exec';

// ============================================================
// 状態管理
// ============================================================
const State = {
  token: '',
  userName: '',
  rules: {},
  currentYear: 0,
  currentMonth: 0,
  availability: {},
  selectedDate: null,
  dropdowns: {},
  submittedId: null,
};

// ============================================================
// 初期化
// ============================================================
document.addEventListener('DOMContentLoaded', async () => {
  const params = new URLSearchParams(location.search);
  State.token = params.get('token') || '';

  if (!State.token) {
    showError('URLが正しくありません。招待リンクからアクセスしてください。');
    return;
  }

  const now = new Date();
  State.currentYear  = now.getFullYear();
  State.currentMonth = now.getMonth() + 1;

  try {
    await loadDropdowns();
    await loadUserInfo();
    await loadCalendar();
    setupForm();
  } catch (e) {
    showError('読み込みに失敗しました: ' + e.message);
  }
});

// ============================================================
// ユーザー情報読み込み
// ============================================================
async function loadUserInfo() {
  const res = await gasCall({ action: 'getUserInfo', token: State.token });
  if (!res.success) { showError(res.error || 'アクセスできません'); throw new Error(res.error); }
  State.userName = res.name;
  State.rules    = res.rules;
  document.getElementById('user-name').textContent = res.name + ' さん';
}

// ============================================================
// カレンダー読み込み・描画
// ============================================================
async function loadCalendar() {
  const grid = document.getElementById('cal-grid');
  grid.innerHTML = '<div class="loading-spinner" style="grid-column:1/-1">読み込み中...</div>';

  const res = await gasCall({
    action: 'getAvailableDates',
    token: State.token,
    year: State.currentYear,
    month: State.currentMonth,
  });
  if (!res.success) { showError(res.error); return; }

  State.availability = res.availability;
  document.getElementById('cal-title').textContent =
    State.currentYear + '年 ' + State.currentMonth + '月';

  renderCalendar();
}

function renderCalendar() {
  const grid = document.getElementById('cal-grid');
  grid.innerHTML = '';

  const firstDay = new Date(State.currentYear, State.currentMonth - 1, 1).getDay();
  const lastDate = new Date(State.currentYear, State.currentMonth, 0).getDate();

  // 空白
  for (let i = 0; i < firstDay; i++) {
    const el = document.createElement('div');
    el.className = 'cal-day empty';
    grid.appendChild(el);
  }

  for (let d = 1; d <= lastDate; d++) {
    const ds  = fmt(State.currentYear, State.currentMonth, d);
    const st  = State.availability[ds] || 'past';
    const el  = document.createElement('div');
    el.className = 'cal-day ' + st;
    el.textContent = d;
    el.dataset.date = ds;

    if (st === 'available') {
      el.addEventListener('click', () => selectDate(ds, el));
    }
    if (ds === State.selectedDate) el.classList.add('selected');

    // ツールチップ
    const tips = {
      past: '過去の日付',
      sunday: '日曜日（受付なし）',
      holiday: '祝日（受付なし）',
      busy: '予定あり',
      restricted: '受付開始前',
      weekFull: '週の上限に達しています',
      tooFar: '受付期間外',
      pending: 'リクエスト審査中',
      approved: '予約確定',
    };
    if (tips[st]) el.title = tips[st];

    grid.appendChild(el);
  }
}

function selectDate(ds, el) {
  // 選択解除
  document.querySelectorAll('.cal-day.selected').forEach(x => x.classList.remove('selected'));
  if (State.selectedDate === ds) {
    State.selectedDate = null;
    hideForm();
    return;
  }
  State.selectedDate = ds;
  el.classList.add('selected');
  showForm(ds);
}

// ============================================================
// ドロップダウン読み込み
// ============================================================
async function loadDropdowns() {
  const res = await gasCall({ action: 'getDropdowns', token: State.token });
  if (res.success) State.dropdowns = res.options;
}

// ============================================================
// フォーム
// ============================================================
function setupForm() {
  const opts = State.dropdowns;
  fillSelect('sel-content',    opts.content    || []);
  fillSelect('sel-days',       opts.days       || []);
  fillSelect('sel-region',     opts.region     || []);
  fillSelect('sel-processing', opts.processing || []);

  document.getElementById('btn-submit').addEventListener('click', submitRequest);
  document.getElementById('btn-cancel').addEventListener('click', () => {
    State.selectedDate = null;
    document.querySelectorAll('.cal-day.selected').forEach(x => x.classList.remove('selected'));
    hideForm();
  });
}

function fillSelect(id, options) {
  const sel = document.getElementById(id);
  sel.innerHTML = '<option value="">選択してください</option>';
  options.forEach(o => {
    const opt = document.createElement('option');
    opt.value = o; opt.textContent = o;
    sel.appendChild(opt);
  });
}

function showForm(ds) {
  const section = document.getElementById('form-section');
  section.classList.add('visible');
  document.getElementById('selected-date').textContent = '選択日: ' + ds.replace(/-/g, '/');
  document.getElementById('form-result').innerHTML = '';
  section.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function hideForm() {
  document.getElementById('form-section').classList.remove('visible');
}

// ============================================================
// リクエスト送信
// ============================================================
async function submitRequest() {
  const btn = document.getElementById('btn-submit');
  btn.disabled = true;
  btn.textContent = '送信中...';

  const content    = document.getElementById('sel-content').value;
  const days       = document.getElementById('sel-days').value;
  const region     = document.getElementById('sel-region').value;
  const processing = document.getElementById('sel-processing').value;
  const notes      = document.getElementById('txt-notes').value.trim();

  if (!content || !days || !region || !processing) {
    showFormAlert('すべての項目を選択してください。', 'error');
    btn.disabled = false;
    btn.textContent = 'リクエストを送る';
    return;
  }

  try {
    const res = await gasCall({
      action: 'submitRequest',
      token: State.token,
      date: State.selectedDate,
      content, days, region, processing, notes,
    });

    if (res.success) {
      State.submittedId = res.requestId;
      showFormAlert(
        '✅ リクエストを送信しました！<br>確認番号: <strong>' + res.requestId + '</strong><br>' +
        'このページで承認状況を確認できます。',
        'success'
      );
      btn.textContent = '送信済み';
      // 承認状況確認ボタン表示
      document.getElementById('btn-check-status').style.display = 'block';
      document.getElementById('btn-check-status').dataset.id = res.requestId;
    } else {
      showFormAlert(res.error || '送信に失敗しました。', 'error');
      btn.disabled = false;
      btn.textContent = 'リクエストを送る';
    }
  } catch(e) {
    showFormAlert('通信エラーが発生しました。', 'error');
    btn.disabled = false;
    btn.textContent = 'リクエストを送る';
  }
}

function showFormAlert(html, type) {
  const el = document.getElementById('form-result');
  el.innerHTML = '<div class="alert alert-' + type + '">' + html + '</div>';
}

// ============================================================
// ステータス確認
// ============================================================
async function checkStatus(requestId) {
  const el = document.getElementById('status-result');
  el.innerHTML = '<div class="loading-spinner">確認中...</div>';

  const res = await gasCall({ action: 'getStatus', requestId });
  if (!res.success) {
    el.innerHTML = '<div class="alert alert-error">見つかりません: ' + requestId + '</div>';
    return;
  }

  const labels = { pending: '⏳ 審査中', approved: '✅ 承認済み', denied: '❌ 否認' };
  const cls    = { pending: 'warning',   approved: 'success',    denied: 'error' };
  el.innerHTML = '<div class="alert alert-' + cls[res.status] + '">' +
    labels[res.status] + '<br>日程: ' + res.date + ' / ' + res.days + '</div>';
}

// 確認番号入力から確認
document.addEventListener('DOMContentLoaded', () => {
  const btnCheck = document.getElementById('btn-check-input');
  if (btnCheck) {
    btnCheck.addEventListener('click', () => {
      const id = document.getElementById('input-request-id').value.trim();
      if (id) checkStatus(id);
    });
  }
  const btnCheckStatus = document.getElementById('btn-check-status');
  if (btnCheckStatus) {
    btnCheckStatus.addEventListener('click', () => {
      checkStatus(btnCheckStatus.dataset.id);
      document.getElementById('status-result').scrollIntoView({ behavior: 'smooth' });
    });
  }
});

// ============================================================
// ナビゲーション
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btn-prev').addEventListener('click', async () => {
    const now = new Date();
    if (State.currentYear === now.getFullYear() && State.currentMonth === now.getMonth() + 1) return;
    State.currentMonth--;
    if (State.currentMonth < 1) { State.currentMonth = 12; State.currentYear--; }
    State.selectedDate = null;
    hideForm();
    await loadCalendar();
  });
  document.getElementById('btn-next').addEventListener('click', async () => {
    State.currentMonth++;
    if (State.currentMonth > 12) { State.currentMonth = 1; State.currentYear++; }
    State.selectedDate = null;
    hideForm();
    await loadCalendar();
  });
});

// ============================================================
// ユーティリティ
// ============================================================
function fmt(y, m, d) {
  return y + '-' + String(m).padStart(2,'0') + '-' + String(d).padStart(2,'0');
}

async function gasCall(params) {
  const qs = new URLSearchParams(params).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(GAS_URL + '?' + qs, { signal: controller.signal });
    clearTimeout(timer);
    return await res.json();
  } catch (e) {
    clearTimeout(timer);
    throw new Error(e.name === 'AbortError' ? 'タイムアウト' : '通信エラー: ' + e.message);
  }
}

function showError(msg) {
  document.body.innerHTML = '<div class="container" style="padding-top:40px">' +
    '<div class="alert alert-error">' + msg + '</div></div>';
}
