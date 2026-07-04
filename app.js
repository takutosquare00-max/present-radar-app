"use strict";

const OWNER = "takutosquare00-max";
const REPO = "present-radar";
const API = `https://api.github.com/repos/${OWNER}/${REPO}/contents`;

let token = localStorage.getItem("gh_token") || "";
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
    const url = safeHttpUrl(c.url);
    const isSoon = c.deadline && c.deadline <= soon;
    return `<div class="card">
      <h2>${esc(c.title)}</h2>
      <div class="meta">
        <span class="badge">${esc(c.category || "その他")}</span>
        ${c.purchase_required ? '<span class="badge buy">購入条件の可能性</span>' : ""}
        ${c.company ? `<span>${esc(c.company)}</span>` : ""}
        ${c.deadline ? `<span class="${isSoon ? "deadline-soon" : ""}">締切 ${esc(c.deadline)}</span>` : ""}
        <span>${esc(c.source || "")}</span>
      </div>
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
}

// --- 画面切り替え・イベント ---
function showSetup(show) {
  $("#setup").hidden = !show;
  $("#tabs").hidden = show;
  $("#filters").hidden = show;
  $("#list").innerHTML = "";
  $("#count").textContent = "";
}

function boot() {
  if (!token) { showSetup(true); return; }
  showSetup(false);
  loadAll().catch((e) => { $("#msg").textContent = e.message; });
}

$("#token-save").addEventListener("click", () => {
  const t = $("#token-input").value.trim();
  if (!t) return;
  token = t;
  localStorage.setItem("gh_token", t);
  $("#token-input").value = "";
  boot();
});
$("#settings-btn").addEventListener("click", () => {
  if (confirm("保存済みトークンを削除して設定画面を開きますか?")) {
    localStorage.removeItem("gh_token");
    token = "";
    showSetup(true);
  }
});
$("#reload").addEventListener("click", boot);
document.querySelectorAll("#tabs button").forEach((b) =>
  b.addEventListener("click", () => { view.tab = b.dataset.tab; render(); }));
$("#cat").addEventListener("change", (e) => { view.cat = e.target.value; render(); });
$("#free").addEventListener("change", (e) => { view.free = e.target.checked; render(); });
$("#expired").addEventListener("change", (e) => { view.expired = e.target.checked; render(); });

boot();
