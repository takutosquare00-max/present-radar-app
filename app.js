"use strict";

const OWNER = "takutosquare00-max";
const REPO = "present-radar";
const API = `https://api.github.com/repos/${OWNER}/${REPO}/contents`;

let token = localStorage.getItem("gh_token") || "";
let profile = JSON.parse(localStorage.getItem("profile") || "{}");
const PROFILE_KEYS = ["姓", "名", "姓ふりがな", "名ふりがな", "郵便番号", "都道府県",
                      "市区町村", "番地", "建物名", "電話番号", "メールアドレス",
                      "生年月日", "性別"];
let campaigns = [];   // data/campaigns.json の内容
let statuses = {};    // data/status.json: url -> {status, at}
let statusSha = null;
const PENDING_STATUS_KEY = "pending_statuses_v1";
const SYNC_BATCH_SIZE = 10;
const SYNC_DELAY_MS = 5 * 60 * 1000;
let pendingStatuses = StatusSync.parsePendingStatuses(localStorage.getItem(PENDING_STATUS_KEY));
let syncTimer = null;
let syncPromise = null;
const view = { tab: "new", period: "open", method: "all", cat: "", expired: false };

// 応募方法タブ: entry_type をどのタブに入れるか。
// X と Instagram の両対応投稿は enrich が X(Twitter) と判定するため X タブに入る。
const METHOD_TABS = {
  all: null,
  X: ["X(Twitter)"],
  Web: ["Webフォーム", "メール", "はがき"],
  Instagram: ["Instagram"],
  その他: ["LINE", "アプリ", "店頭・レシート", "その他", "不明"],
};

// 応募期間: start_date が未来なら「期間前」。日付比較で毎回計算するため、
// 開始日を迎えた企画は自動的に「期間中」タブへ移る。
function isUpcoming(c, today) {
  const s = c.details?.start_date;
  return !!(s && s > today);
}

function methodOf(c) {
  const t = c.details?.entry_type || "その他";
  for (const [tab, types] of Object.entries(METHOD_TABS)) {
    if (types && types.includes(t)) return tab;
  }
  return "その他";
}

const $ = (sel) => document.querySelector(sel);

// --- XSS対策: 収集データ(外部RSS由来)は必ずエスケープして描画する ---
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function safeHttpUrl(s) {
  try {
    const u = new URL(s);
    if (u.protocol === "https:" || u.protocol === "http:") return u.href;
  } catch { /* fallthrough */ }
  return null;
}

const b64decode = (s) =>
  new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s/g, "")), (c) => c.charCodeAt(0)));
const b64encode = (s) => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin);
};

async function gh(path, opts = {}) {
  return fetch(`${API}/${path}`, {
    cache: "no-store",
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(opts.headers || {}),
    },
  });
}

async function loadAll() {
  $("#msg").textContent = "読み込み中…";
  const [cRes, sRes] = await Promise.all([
    gh("data/campaigns.json", { headers: { Accept: "application/vnd.github.raw" } }),
    gh("data/status.json"),
  ]);
  if (!cRes.ok) {
    throw new Error(cRes.status === 401 || cRes.status === 403 || cRes.status === 404
      ? `認証エラー(HTTP ${cRes.status})。トークンの対象リポジトリと権限を確認してください`
      : `読み込み失敗(HTTP ${cRes.status})`);
  }
  campaigns = await cRes.json();
  if (sRes.ok) {
    const j = await sRes.json();
    statusSha = j.sha;
    statuses = StatusSync.applyStatusChanges(JSON.parse(b64decode(j.content)), pendingStatuses);
  } else if (sRes.status === 404) {
    statuses = StatusSync.applyStatusChanges({}, pendingStatuses);
    statusSha = null;
  }
  $("#msg").textContent = "";
  buildCategoryOptions();
  render();
  updateSyncUi();
  scheduleStatusSync();
}

// --- ステータス保存(端末へ即時保存 + GitHubへバッチ同期) ---

function savePendingStatuses() {
  localStorage.setItem(PENDING_STATUS_KEY, JSON.stringify(pendingStatuses));
  updateSyncUi();
}

function updateSyncUi(syncing = false) {
  const count = Object.keys(pendingStatuses).length;
  const button = $("#sync-status");
  button.hidden = count === 0 && !syncing;
  button.disabled = syncing;
  $("#pending-count").textContent = String(count);
  button.title = syncing ? "同期中" : `未同期 ${count}件。タップして同期`;
}

function scheduleStatusSync() {
  clearTimeout(syncTimer);
  if (!token || Object.keys(pendingStatuses).length === 0) return;
  if (Object.keys(pendingStatuses).length >= SYNC_BATCH_SIZE) {
    void flushPendingStatuses();
    return;
  }
  syncTimer = setTimeout(() => { void flushPendingStatuses(); }, SYNC_DELAY_MS);
}

function setStatus(url, status) {
  const change = { status, at: new Date().toISOString() };
  pendingStatuses[url] = change;
  statuses = StatusSync.applyStatusChanges(statuses, { [url]: change });
  savePendingStatuses();
  render();
  scheduleStatusSync();
}

async function pushStatuses(changeCount, retries) {
  const body = {
    message: `status: ${changeCount}件をまとめて更新`,
    content: b64encode(JSON.stringify(statuses, null, 1)),
    ...(statusSha ? { sha: statusSha } : {}),
  };
  const res = await gh("data/status.json", { method: "PUT", body: JSON.stringify(body) });
  if (res.ok) {
    statusSha = (await res.json()).content.sha;
    return;
  }
  if ((res.status === 409 || res.status === 422) && retries > 0) {
    const cur = await gh("data/status.json");
    if (cur.ok) {
      const j = await cur.json();
      statusSha = j.sha;
      statuses = StatusSync.applyStatusChanges(
        JSON.parse(b64decode(j.content)), pendingStatuses);
      render();
    }
    return pushStatuses(changeCount, retries - 1);
  }
  throw new Error(`HTTP ${res.status}`);
}

function flushPendingStatuses() {
  if (syncPromise) return syncPromise;
  const snapshot = structuredClone(pendingStatuses);
  const count = Object.keys(snapshot).length;
  if (!token || count === 0) return Promise.resolve();

  clearTimeout(syncTimer);
  updateSyncUi(true);
  $("#msg").textContent = `${count}件を同期中…`;
  syncPromise = pushStatuses(count, 2)
    .then(() => {
      pendingStatuses = StatusSync.removeSyncedChanges(pendingStatuses, snapshot);
      savePendingStatuses();
      $("#msg").textContent = "同期しました";
      setTimeout(() => {
        if ($("#msg").textContent === "同期しました") $("#msg").textContent = "";
      }, 1500);
    })
    .catch((e) => {
      $("#msg").textContent = `同期失敗: ${e.message}。未同期データは端末に保持しています`;
      throw e;
    })
    .finally(() => {
      syncPromise = null;
      updateSyncUi();
      scheduleStatusSync();
    });
  return syncPromise;
}

// --- 描画 ---
function statusOf(url) {
  return statuses[url]?.status || "new";
}

function buildCategoryOptions() {
  const cats = [...new Set(campaigns.map((c) => c.category || "その他"))].sort();
  $("#cat").innerHTML =
    '<option value="">全カテゴリー</option>' +
    cats.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
  $("#cat").value = view.cat;
}

function render() {
  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date(Date.now() + 3 * 86400e3).toISOString().slice(0, 10);

  const inStatus = campaigns
    .filter((c) => statusOf(c.url) === view.tab)
    .filter((c) => view.expired || !c.deadline || c.deadline >= today);

  // 応募期間タブ(期間中/期間前)の件数と絞り込み
  const periodCounts = { open: 0, upcoming: 0 };
  for (const c of inStatus) periodCounts[isUpcoming(c, today) ? "upcoming" : "open"]++;
  document.querySelectorAll("#period-tabs button").forEach((b) => {
    b.classList.toggle("on", b.dataset.period === view.period);
    b.querySelector(".mc").textContent = periodCounts[b.dataset.period] || 0;
  });
  const inPeriod = inStatus.filter((c) =>
    (view.period === "upcoming") === isUpcoming(c, today));

  // 応募方法タブごとの件数(現在のステータス内)
  const methodCounts = {};
  for (const c of inPeriod) {
    const m = methodOf(c);
    methodCounts[m] = (methodCounts[m] || 0) + 1;
  }
  methodCounts.all = inPeriod.length;
  document.querySelectorAll("#method-tabs button").forEach((b) => {
    const m = b.dataset.method;
    b.classList.toggle("on", m === view.method);
    b.querySelector(".mc").textContent = methodCounts[m] || 0;
  });

  const rows = inPeriod
    .filter((c) => view.method === "all" || methodOf(c) === view.method)
    .filter((c) => !view.cat || (c.category || "その他") === view.cat)
    .sort((a, b) =>
      view.period === "upcoming"
        ? String(a.details?.start_date).localeCompare(String(b.details?.start_date))
        : (a.deadline ? 0 : 1) - (b.deadline ? 0 : 1) ||
          String(a.deadline).localeCompare(String(b.deadline)) ||
          (b.score || 0) - (a.score || 0));

  $("#count").textContent = `${rows.length} 件`;
  document.querySelectorAll("#tabs button").forEach((b) =>
    b.classList.toggle("on", b.dataset.tab === view.tab));

  $("#list").innerHTML = rows.map((c, i) => {
    const d = c.details && c.details.entry_type !== "不明" ? c.details : null;
    const url = safeHttpUrl(d?.official_url) || safeHttpUrl(c.url);
    const isSoon = c.deadline && c.deadline <= soon;
    return `<div class="card">
      <h2>${esc(c.title)}</h2>
      <div class="meta">
        <span class="badge">${esc(c.category || "その他")}</span>
        ${d ? `<span class="badge">${esc(d.entry_type)}</span>` : ""}
        ${c.purchase_required ? '<span class="badge buy">購入条件の可能性</span>' : ""}
        ${c.company ? `<span>${esc(c.company)}</span>` : ""}
        ${isUpcoming(c, today) ? `<span class="badge start">開始 ${esc(c.details.start_date)}</span>` : ""}
        ${c.deadline ? `<span class="${isSoon ? "deadline-soon" : ""}">締切 ${esc(c.deadline)}</span>` : ""}
      </div>
      ${d ? renderDetails(d, i) : ""}
      <div class="actions">
        ${url ? `<a class="go" href="${esc(url)}" target="_blank" rel="noopener noreferrer">応募ページ →</a>` : ""}
        ${view.tab !== "applied" ? `<button data-i="${i}" data-set="applied">応募した ✓</button>` : ""}
        ${view.tab === "new" ? `<button data-i="${i}" data-set="skipped">スキップ</button>` : ""}
        ${view.tab !== "new" ? `<button data-i="${i}" data-set="new">戻す</button>` : ""}
      </div>
    </div>`;
  }).join("") || '<div class="empty">該当する企画はありません</div>';

  document.querySelectorAll("#list button[data-set]").forEach((b) => {
    b.addEventListener("click", () => setStatus(rows[+b.dataset.i].url, b.dataset.set));
  });
  document.querySelectorAll("#list button[data-copy]").forEach((b) => {
    b.addEventListener("click", async () => {
      const draft = rows[+b.dataset.copy]?.details?.draft;
      if (!draft) return;
      await navigator.clipboard.writeText(fillDraft(draft));
      b.textContent = "コピーしました ✓";
      setTimeout(() => { b.textContent = "ドラフトをコピー"; }, 1500);
    });
  });
}

// --- 応募方法の詳細とドラフト ---
// 分割保存された項目から複合プレースホルダー({氏名}{住所}など)を合成する。
// 旧形式(氏名・住所を1項目で保存)のプロフィールもそのまま使える。
function profileValue(key) {
  if (profile[key]) return profile[key];
  const join = (...parts) => parts.filter(Boolean).join(" ").trim();
  switch (key) {
    case "氏名": return join(profile["姓"], profile["名"]);
    case "ふりがな": return join(profile["姓ふりがな"], profile["名ふりがな"]);
    case "住所": return [profile["都道府県"], profile["市区町村"],
                        profile["番地"], profile["建物名"]].filter(Boolean).join("");
    default: return "";
  }
}

function fillDraft(draft) {
  return String(draft).replace(/\{([^}]+)\}/g, (m, key) => profileValue(key) || m);
}

function renderList(label, arr) {
  if (!Array.isArray(arr) || !arr.length) return "";
  return `<h3>${esc(label)}</h3><ul>${arr.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>`;
}

function renderDetails(d, i) {
  const prize = [d.prize, d.winners && `抽選 ${d.winners}`].filter(Boolean).join(" / ");
  return `<details class="detail">
    <summary>応募方法と条件を見る</summary>
    ${prize ? `<h3>賞品</h3><ul><li>${esc(prize)}</li></ul>` : ""}
    ${renderList("応募条件", d.conditions)}
    ${renderList("応募手順", d.steps)}
    ${renderList("入力が必要な情報", d.required_fields)}
    ${d.draft ? `<div class="draft"><h3>応募ドラフト</h3><pre>${esc(fillDraft(d.draft))}</pre>
      <button data-copy="${i}">ドラフトをコピー</button></div>` : ""}
  </details>`;
}

// --- 画面切り替え・イベント ---
function showSetup(show) {
  $("#setup").hidden = !show;
  $("#tabs").hidden = show;
  $("#method-tabs").hidden = show;
  $("#period-tabs").hidden = show;
  $("#filters").hidden = show;
  $("#list").innerHTML = "";
  $("#count").textContent = "";
  if (show) {
    PROFILE_KEYS.forEach((k) => { $(`#p-${k}`).value = profile[k] || ""; });
  }
}

function boot() {
  if (!token) { showSetup(true); return; }
  showSetup(false);
  loadAll().catch((e) => { $("#msg").textContent = e.message; });
}

$("#save-btn").addEventListener("click", () => {
  const t = $("#token-input").value.trim();
  if (t) {
    token = t;
    localStorage.setItem("gh_token", t);
    $("#token-input").value = "";
  }
  profile = {};
  PROFILE_KEYS.forEach((k) => {
    const v = $(`#p-${k}`).value.trim();
    if (v) profile[k] = v;
  });
  localStorage.setItem("profile", JSON.stringify(profile));
  boot();
});
$("#settings-btn").addEventListener("click", () => showSetup(true));
$("#reload").addEventListener("click", boot);
$("#sync-status").addEventListener("click", () => {
  flushPendingStatuses().catch(() => {});
});
document.querySelectorAll("#tabs button").forEach((b) =>
  b.addEventListener("click", () => { view.tab = b.dataset.tab; render(); }));
document.querySelectorAll("#method-tabs button").forEach((b) =>
  b.addEventListener("click", () => { view.method = b.dataset.method; render(); }));
document.querySelectorAll("#period-tabs button").forEach((b) =>
  b.addEventListener("click", () => { view.period = b.dataset.period; render(); }));
$("#cat").addEventListener("change", (e) => { view.cat = e.target.value; render(); });
$("#expired").addEventListener("change", (e) => { view.expired = e.target.checked; render(); });
window.addEventListener("online", () => { void flushPendingStatuses(); });

boot();
