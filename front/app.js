// Reward Tracker 前端：纯静态页面，部署在 GitHub Pages。
// Worker 地址写在 config.js；登录后的会话令牌存在本机 localStorage，到期自动失效。

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const state = { env: null, items: [], accounts: {}, txns: [], benefits: [] };

const cfg = {
  url: (window.RT_CONFIG?.workerUrl || "").replace(/\/+$/, ""),
  get token() {
    const s = JSON.parse(localStorage.getItem("rt_session") || "null");
    return s && s.exp > Date.now() ? s.token : "";
  },
  setSession(token, exp) { localStorage.setItem("rt_session", JSON.stringify({ token, exp })); },
  clear() { localStorage.removeItem("rt_session"); },
};

// ---------------------------------------------------------------- api

async function api(path, { method = "GET", body } = {}) {
  if (!cfg.token) { showLogin(); throw new Error("请先登录"); }
  const res = await fetch(cfg.url + path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { cfg.clear(); showLogin(); throw new Error("登录已过期，请重新登录"); }
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

function ingest(data) {
  state.env = data.env;
  state.items = data.items;
  state.txns = data.transactions;
  state.benefits = data.benefits || [];
  state.accounts = {};
  for (const it of data.items) for (const a of it.accounts) state.accounts[a.id] = { ...a, institution: it.institution };
  render();
}

async function load() { ingest(await api("/api/data")); }

async function sync() {
  const btn = $("#btn-sync");
  btn.disabled = true; btn.textContent = "同步中…";
  try {
    ingest(await api("/api/sync", { method: "POST" }));
    const errs = state.items.filter((i) => i.error);
    toast(errs.length ? `${errs.length} 个连接需要处理，见「账户」` : "已同步");
  } catch (e) { toast(e.message); }
  finally { btn.disabled = false; btn.textContent = "同步"; }
}

// ---------------------------------------------------------------- plaid link

async function connect(itemId = null) {
  try {
    const { link_token } = await api("/api/link-token", { method: "POST", body: { item_id: itemId } });
    sessionStorage.setItem("rt_link", JSON.stringify({ token: link_token, itemId }));
    openLink(link_token, itemId);
  } catch (e) { toast(e.message); }
}

function openLink(token, itemId, receivedRedirectUri) {
  const handler = Plaid.create({
    token,
    receivedRedirectUri,
    onSuccess: async (public_token, metadata) => {
      sessionStorage.removeItem("rt_link");
      try {
        if (!itemId) {
          toast("连接成功，正在保存…");
          await api("/api/exchange", { method: "POST", body: { public_token, institution: metadata.institution } });
        }
        await load();
        toast("连接成功。新连接的交易可能要几分钟后才能同步到");
      } catch (e) { toast(e.message); }
    },
    onExit: (err) => {
      sessionStorage.removeItem("rt_link");
      if (err) toast(err.display_message || err.error_message || "已退出");
    },
  });
  handler.open();
}

// OAuth 银行跳转回来时继续 Link 流程
function resumeOAuth() {
  if (!new URLSearchParams(location.search).has("oauth_state_id")) return false;
  const saved = JSON.parse(sessionStorage.getItem("rt_link") || "null");
  if (!saved) return false;
  openLink(saved.token, saved.itemId, location.href);
  history.replaceState(null, "", location.pathname);
  return true;
}

async function removeItem(itemId, name) {
  if (!confirm(`断开 ${name}？本地存的该银行交易也会删除。`)) return;
  try { await api("/api/items/remove", { method: "POST", body: { item_id: itemId } }); await load(); toast("已断开"); }
  catch (e) { toast(e.message); }
}

// ---------------------------------------------------------------- render

const fmt = (n, cur = "USD") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: cur || "USD" }).format(n);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const acctLabel = (a) => (a ? `${a.institution} · ${a.name}${a.mask ? " ··" + a.mask : ""}` : "未知账户");
const WEEK = ["日", "一", "二", "三", "四", "五", "六"];

function render() {
  const badge = $("#env-badge");
  badge.hidden = state.env !== "sandbox";
  badge.textContent = "SANDBOX";
  renderAccountSelects();
  renderTxns();
  renderBenefits();
  renderAccounts();
}

function renderAccountSelects() {
  const opts = Object.values(state.accounts)
    .map((a) => `<option value="${esc(a.id)}">${esc(acctLabel(a))}</option>`).join("");
  for (const sel of [$("#f-account"), $('#benefit-form [name="account_id"]')]) {
    const keep = sel.value;
    const first = sel.options[0].outerHTML;
    sel.innerHTML = first + opts;
    sel.value = keep;
  }
}

function filteredTxns() {
  const acct = $("#f-account").value;
  const month = $("#f-month").value;
  const q = $("#f-q").value.trim().toLowerCase();
  return state.txns.filter((t) =>
    (!acct || t.account_id === acct) &&
    (!month || t.date.startsWith(month)) &&
    (!q || `${t.merchant || ""} ${t.name}`.toLowerCase().includes(q))
  );
}

function renderTxns() {
  const list = filteredTxns();
  const out = list.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0);
  const inn = list.filter((t) => t.amount < 0).reduce((s, t) => s - t.amount, 0);
  $("#summary").innerHTML = `
    <div class="stat"><div class="label">支出</div><div class="value">${fmt(out)}</div></div>
    <div class="stat"><div class="label">退款 / 还款</div><div class="value">${fmt(inn)}</div></div>
    <div class="stat"><div class="label">笔数</div><div class="value">${list.length}</div></div>`;

  if (!state.items.length) {
    $("#txn-list").innerHTML = `<div class="empty">还没有连接银行。点击右上角「连接银行」开始。</div>`;
    return;
  }
  if (!list.length) { $("#txn-list").innerHTML = `<div class="empty">没有符合条件的交易</div>`; return; }

  const groups = new Map();
  for (const t of list) { if (!groups.has(t.date)) groups.set(t.date, []); groups.get(t.date).push(t); }

  $("#txn-list").innerHTML = [...groups].map(([date, ts]) => {
    const d = new Date(date + "T00:00:00");
    const dayOut = ts.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0);
    return `<div class="day">
      <div class="day-head"><span>${d.getMonth() + 1}月${d.getDate()}日 · 周${WEEK[d.getDay()]}</span><span>${dayOut ? "−" + fmt(dayOut) : ""}</span></div>
      ${ts.map(txnRow).join("")}
    </div>`;
  }).join("");
}

function txnRow(t) {
  const title = t.merchant || t.name;
  const a = state.accounts[t.account_id];
  const logo = t.logo ? `<img src="${esc(t.logo)}" alt="" loading="lazy">` : esc(title.trim()[0] || "·");
  const amt = t.amount > 0 ? `−${fmt(t.amount, t.currency)}` : `+${fmt(-t.amount, t.currency)}`;
  return `<div class="txn">
    <div class="logo">${logo}</div>
    <div>
      <div class="title">${esc(title)}${t.pending ? '<span class="tag">待入账</span>' : ""}</div>
      <div class="meta">${esc(a ? `${a.name}${a.mask ? " ··" + a.mask : ""}` : "")}${t.category ? " · " + esc(catName(t.category)) : ""}</div>
    </div>
    <div class="amt ${t.amount < 0 ? "in" : ""}">${amt}</div>
  </div>`;
}

const CAT = {
  FOOD_AND_DRINK: "餐饮", GENERAL_MERCHANDISE: "购物", TRAVEL: "旅行", TRANSPORTATION: "交通",
  ENTERTAINMENT: "娱乐", GENERAL_SERVICES: "服务", PERSONAL_CARE: "个人护理", MEDICAL: "医疗",
  RENT_AND_UTILITIES: "房租水电", HOME_IMPROVEMENT: "家居", LOAN_PAYMENTS: "还款", TRANSFER_IN: "转入",
  TRANSFER_OUT: "转出", BANK_FEES: "银行费用", INCOME: "收入", GOVERNMENT_AND_NON_PROFIT: "政府/公益",
};
const catName = (c) => CAT[c] || c;

// ---------------------------------------------------------------- benefits

function benefitProgress(b) {
  const kws = (b.keywords || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const hits = state.txns.filter((t) =>
    (!b.account_id || t.account_id === b.account_id) &&
    t.date >= b.start && t.date <= b.end &&
    (!kws.length || kws.some((k) => `${t.merchant || ""} ${t.name}`.toLowerCase().includes(k)))
  );
  if (b.type === "count") return { value: hits.filter((t) => t.amount > 0).length, hits };
  // 消费金额按净额算：退款会抵扣
  return { value: Math.max(0, hits.reduce((s, t) => s + t.amount, 0)), hits };
}

function renderBenefits() {
  const today = new Date().toISOString().slice(0, 10);
  const list = [...state.benefits].sort((a, b) => a.end.localeCompare(b.end));
  if (!list.length) {
    $("#benefit-list").innerHTML = `<div class="empty">还没有权益任务。例如开卡奖励的消费门槛、季度类别返现、每月 Uber / 餐饮 credit。</div>`;
    return;
  }
  $("#benefit-list").innerHTML = list.map((b) => {
    const { value } = benefitProgress(b);
    const target = Number(b.target) || 0;
    const pct = target ? Math.min(100, (value / target) * 100) : 0;
    const done = value >= target && target > 0;
    const daysLeft = Math.ceil((new Date(b.end) - new Date(today)) / 864e5);
    const show = (n) => (b.type === "count" ? `${n} 笔` : fmt(n));
    const a = state.accounts[b.account_id];
    const status = done ? "已完成" : daysLeft < 0 ? "已过期" : `还差 ${show(Math.max(0, target - value))} · 剩 ${daysLeft} 天`;
    return `<div class="card benefit ${done ? "done" : ""}">
      <div class="benefit-head">
        <h3>${esc(b.name)}</h3>
        <button class="btn small ghost" data-del="${esc(b.id)}">删除</button>
      </div>
      <div class="meta">${esc(a ? acctLabel(a) : "任意卡片")} · ${esc(b.start)} 至 ${esc(b.end)}${b.keywords ? " · 关键词：" + esc(b.keywords) : ""}${b.note ? " · " + esc(b.note) : ""}</div>
      <div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div>
      <div class="nums"><span>${show(value)} / ${show(target)}</span><span class="left">${status}</span></div>
    </div>`;
  }).join("");
}

async function saveBenefits(next) {
  const prev = state.benefits;
  state.benefits = next; renderBenefits();
  try { await api("/api/benefits", { method: "PUT", body: { benefits: next } }); }
  catch (e) { state.benefits = prev; renderBenefits(); toast(e.message); }
}

// ---------------------------------------------------------------- accounts

function renderAccounts() {
  if (!state.items.length) { $("#account-list").innerHTML = `<div class="empty">还没有连接银行</div>`; return; }
  $("#account-list").innerHTML = state.items.map((it) => `
    <div class="card">
      <div class="inst-head">
        <h3>${esc(it.institution)}</h3>
        <div>
          ${it.error ? `<button class="btn small primary" data-relink="${esc(it.item_id)}">重新连接</button>` : ""}
          <button class="btn small ghost" data-remove="${esc(it.item_id)}" data-name="${esc(it.institution)}">断开</button>
        </div>
      </div>
      ${it.error ? `<div class="err">${esc(it.error.code)}：${esc(it.error.message)}</div>` : ""}
      ${it.accounts.map((a) => `
        <div class="acct">
          <div><div>${esc(a.name)}${a.mask ? " ··" + esc(a.mask) : ""}</div><div class="meta">${esc(a.official_name || a.subtype || "")}</div></div>
          <div style="text-align:right">
            <div>${a.balance_current != null ? fmt(a.balance_current, a.currency) : "—"}</div>
            <div class="meta">${a.limit ? "额度 " + fmt(a.limit, a.currency) : ""}</div>
          </div>
        </div>`).join("")}
      <div class="hint" style="margin-top:8px">上次同步：${it.last_synced ? new Date(it.last_synced).toLocaleString("zh-CN") : "尚未同步"}</div>
    </div>`).join("");
}

// ---------------------------------------------------------------- ui

// ---------------------------------------------------------------- login

function showLogin(msg) {
  state.items = []; state.txns = []; state.benefits = []; state.accounts = {};
  $("#app").hidden = true;
  $("#login").hidden = false;
  const err = $("#login-err");
  err.hidden = !msg; err.textContent = msg || "";
  $('#login-form [name="password"]').value = "";
  $('#login-form [name="username"]').focus();
}

function showApp() {
  $("#login").hidden = true;
  $("#app").hidden = false;
}

async function doLogin(e) {
  e.preventDefault();
  const f = e.target, btn = f.querySelector("button");
  if (!cfg.url) return showLogin("config.js 里还没有填 Worker 地址");
  btn.disabled = true; btn.textContent = "登录中…";
  try {
    const res = await fetch(cfg.url + "/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: f.username.value.trim(), password: f.password.value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `登录失败 (${res.status})`);
    cfg.setSession(data.token, data.exp);
    f.password.value = "";
    showApp();
    await load();
  } catch (err) {
    showLogin(err.message === "Failed to fetch" ? "连不上 Worker，请检查 config.js 和 ALLOWED_ORIGINS" : err.message);
  } finally {
    btn.disabled = false; btn.textContent = "登录";
  }
}

function logout() {
  cfg.clear();
  render();
  showLogin();
}

let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg; el.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}

function bind() {
  $$(".tabs button").forEach((b) => b.addEventListener("click", () => {
    $$(".tabs button").forEach((x) => x.classList.toggle("active", x === b));
    $$(".tab").forEach((t) => t.classList.toggle("active", t.id === `tab-${b.dataset.tab}`));
  }));
  $("#btn-sync").addEventListener("click", sync);
  $("#btn-link").addEventListener("click", () => connect());
  $("#btn-logout").addEventListener("click", logout);
  $("#login-form").addEventListener("submit", doLogin);
  ["#f-account", "#f-month", "#f-q"].forEach((s) => $(s).addEventListener("input", renderTxns));

  $("#benefit-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    if (f.end < f.start) return toast("截止日期早于开始日期");
    saveBenefits([...state.benefits, { id: crypto.randomUUID(), ...f, target: Number(f.target) }]);
    e.target.reset(); $("#benefit-editor").open = false;
  });

  document.addEventListener("click", (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.del && confirm("删除这个任务？")) saveBenefits(state.benefits.filter((b) => b.id !== t.dataset.del));
    if (t.dataset.relink) connect(t.dataset.relink);
    if (t.dataset.remove) removeItem(t.dataset.remove, t.dataset.name);
  });
}

bind();
$("#f-month").value = new Date().toISOString().slice(0, 7);
render();
if (cfg.token) {
  showApp();
  if (!resumeOAuth()) load().catch((e) => toast(e.message));
} else {
  showLogin();
}
