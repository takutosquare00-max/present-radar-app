"use strict";

const OWNER = "takutosquare00-max";
const REPO = "present-radar";
const API = `https://api.github.com/repos/${OWNER}/${REPO}/contents`;

let token = localStorage.getItem("gh_token") || "";
let profile = JSON.parse(localStorage.getItem("profile") || "{}");
const PROFILE_KEYS = ["氏名", "ふりがな", "郵便番号", "住所", "電話番号", "メールアドレス"];
let campaigns = [];   // data/campaigns.json の内容
let statuses = {};    // data/status.json: url -> {status, at}
let statusSha = null;
const view = { tab: "new", cat: "", free: false, expired: false };

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
    statuses = JSON.parse(b64decode(j.content));
  } else if (sRes.status === 404) {
    statuses = {};
    statusSha = null;
  }
  $("#msg").textContent = "";
  buildCategoryOptions();
  render();
}

// --- ステータス保存(直列化 + 競合時はリモートとマージして再送) ---
let saveChain = Promise.resolve();

function setStatus(url, status) {
  if (status === "new") delete statuses[url];
  else statuses[url] = { status, at: new Date().toISOString() };
  render();
  saveChain = saveChain
    .then(() => pushStatuses(2))
    .catch((e) => { $("#msg").textContent = `保存失敗: ${e.message}(↻で再試行)`; });
}

async function pushStatuses(retries) {
  const body = {
    message: "status: スマホから更新",
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
      statuses = { ...JSON.parse(b64decode(j.content)), ...statuses };
    }
    return pushStatuses(retries - 1);
  }
  throw new Error(`HTTP ${res.status}`);
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

  const rows = campaigns
    .filter((c) => statusOf(c.url) === view.tab)
    .filter((c) => !view.cat || (c.category || "その他") === view.cat)
    .filter((c) => !view.free || !c.purchase_required)
    .filter((c) => view.expired || !c.deadline || c.deadline >= today)
    .sort((a, b) =>
      (a.deadline ? 0 : 1) - (b.deadline ? 0 : 1) ||
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
function fillDraft(draft) {
  return String(draft).replace(/\{([^}]+)\}/g, (m, key) => profile[key] || m);
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
document.querySelectorAll("#tabs button").forEach((b) =>
  b.addEventListener("click", () => { view.tab = b.dataset.tab; render(); }));
$("#cat").addEventListener("change", (e) => { view.cat = e.target.value; render(); });
$("#free").addEventListener("change", (e) => { view.free = e.target.checked; render(); });
$("#expired").addEventListener("change", (e) => { view.expired = e.target.checked; render(); });

boot();
