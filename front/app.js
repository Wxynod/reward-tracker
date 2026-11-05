// Reward Tracker 前端：纯静态页面，部署在 GitHub Pages。
// Worker 地址写在 config.js；登录后的会话令牌存在本机 localStorage，到期自动失效。

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const R = window.RT_REWARDS;
const I = window.RT_ICONS;
const B = window.RT_BRANDS;
window.brandLoaded = (img) => img.parentNode.classList.add("has-logo");
window.brandFail = (img) => {
  if (img.dataset.fallback) { img.src = img.dataset.fallback; delete img.dataset.fallback; return; }
  img.parentNode.classList.remove("has-logo");
  img.nextElementSibling?.remove();
  img.remove();
};
const EMPTY_REWARDS = () => ({ cards: {}, rules: {}, balances: {} });
const state = {
  env: null, items: [], accounts: {}, txns: [], benefits: [],
  rewards: EMPTY_REWARDS(), earn: new Map(), logos: {},
  editing: false, draft: null, catFilter: "",
};

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
  state.rewards = { ...EMPTY_REWARDS(), ...(data.rewards || {}) };
  state.accounts = {};
  for (const it of data.items) for (const a of it.accounts) state.accounts[a.id] = { ...a, institution: it.institution };
  render();
}

async function load() {
  ingest(await api("/api/data"));
  loadLogos();
}

async function loadLogos() {
  try { state.logos = (await api("/api/logos")).logos || {}; renderRewards(); renderAccounts(); }
  catch { /* logo 拿不到时用 favicon / 字母徽章兜底 */ }
}

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
  state.earn = R.compute(state.txns, state.accounts, state.rewards);
  document.body.classList.toggle("editing", state.editing);
  renderAccountSelects();
  renderRewards();
  renderSettings();
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

function filteredTxns({ ignoreCat = false } = {}) {
  const cat = ignoreCat ? "" : state.catFilter;
  const acct = $("#f-account").value;
  const month = $("#f-month").value;
  const q = $("#f-q").value.trim().toLowerCase();
  return state.txns.filter((t) =>
    (!acct || t.account_id === acct) &&
    (!month || t.date.startsWith(month)) &&
    (!q || `${t.merchant || ""} ${t.name}`.toLowerCase().includes(q)) &&
    (!cat || I.info(t).key === cat)
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

  renderCatBar();

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
  // 对照表和 Plaid 都没给出域名的商户，后台按名称搜索，找到后再刷新一次列表
  B.searchPending(() => renderTxns());
}

function txnRow(t) {
  const title = t.merchant || t.name;
  const a = state.accounts[t.account_id];
  const ic = I.info(t);
  const amt = t.amount > 0 ? `−${fmt(t.amount, t.currency)}` : `+${fmt(-t.amount, t.currency)}`;
  // 左侧：有品牌 logo 就显示品牌 logo（右下角带类别小圆点），否则显示彩色类别图标
  const srcs = [B.url(t), t.logo].filter(Boolean);
  const brand = srcs.length
    ? `<img class="blogo" src="${esc(srcs[0])}" ${srcs[1] ? `data-fallback="${esc(srcs[1])}"` : ""} alt="" loading="lazy"
         referrerpolicy="strict-origin-when-cross-origin" onload="brandLoaded(this)" onerror="brandFail(this)">
       <span class="cat-dot">${I.svg(ic.icon)}</span>`
    : "";
  return `<div class="txn">
    <div class="cat-icon" style="--c:${ic.color}" title="${esc(ic.label)}${t.mcc ? " · MCC " + esc(t.mcc) : ""}">${I.svg(ic.icon)}${brand}</div>
    <div>
      <div class="title">${esc(title)}${t.pending ? '<span class="tag">待入账</span>' : ""}</div>
      <div class="meta"><span class="cat-name" style="--c:${ic.color}">${esc(ic.label)}</span>${a ? esc(` · ${a.name}${a.mask ? " ··" + a.mask : ""}`) : ' · <span class="warn" title="这笔交易的账户不在当前账户列表里，点 ⚙ → 重新拉取全部交易">未知账户</span>'}</div>
    </div>
    <div class="right">
      <div class="amt ${t.amount < 0 ? "in" : ""}">${amt}</div>
      ${earnCell(t)}
    </div>
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

// 自动任务：信用卡季度轮换类别的额度进度（目前是 Freedom Flex），由积分引擎算出来
function rotationCards(today) {
  const shown = [];
  for (const a of creditAccounts()) {
    const pk = productOf(a);
    const product = R.PRODUCTS[pk];
    if (!product) continue;
    for (const r of product.rules) {
      if (!r.rotation || today < r.from || today > r.to) continue;
      const hit = (state.earn.rotations || []).find((x) => x.account_id === a.id && x.title === r.rotation.title);
      shown.push({ a, product, r, used: hit ? hit.used : 0 });
    }
  }
  return shown.map(({ a, product, r, used }) => {
    const pct = Math.min(100, (used / r.cap) * 100);
    const done = used >= r.cap;
    const daysLeft = Math.ceil((new Date(r.to) - new Date(today)) / 864e5);
    const actLeft = Math.ceil((new Date(r.rotation.activateBy) - new Date(today)) / 864e5);
    return `<div class="card benefit auto ${done ? "done" : ""}">
      <div class="benefit-head">
        <h3>${esc(product.name)} · ${esc(r.rotation.title)}</h3>
        <span class="tag auto-tag">自动</span>
      </div>
      <div class="meta">${esc(a.name)}${a.mask ? " ··" + esc(a.mask) : ""} · ${esc(r.from)} 至 ${esc(r.to)}${actLeft >= 0 ? ` · 记得在 ${esc(r.rotation.activateBy)} 前激活` : ""}</div>
      <div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div>
      <div class="nums"><span>${fmt(used)} / ${fmt(r.cap)}</span><span class="left">${done ? "额度已用满" : `还差 ${fmt(r.cap - used)} · 剩 ${daysLeft} 天`}</span></div>
      <ul class="rotation-items">${r.rotation.items.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
    </div>`;
  }).join("");
}

function renderBenefits() {
  const today = new Date().toISOString().slice(0, 10);
  const auto = rotationCards(today);
  const list = [...state.benefits].sort((a, b) => a.end.localeCompare(b.end));
  if (!list.length) {
    $("#benefit-list").innerHTML = auto + `<div class="empty">还没有自定义权益任务。例如开卡奖励的消费门槛、每月 Uber / 餐饮 credit。</div>`;
    return;
  }
  $("#benefit-list").innerHTML = auto + list.map((b) => {
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
        <h3 class="with-logo">${instLogo(it.institution)}${esc(it.institution)}</h3>
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

// 按类别的支出分布：一条彩色比例条 + 可点击筛选的类别标签
function renderCatBar() {
  const sums = new Map();
  for (const t of filteredTxns({ ignoreCat: true })) {
    if (t.amount <= 0) continue;
    const ic = I.info(t);
    if (["payment", "fee", "income", "benefit"].includes(ic.key)) continue;
    const s = sums.get(ic.key) || { ...ic, total: 0 };
    s.total += t.amount; sums.set(ic.key, s);
  }
  const list = [...sums.values()].sort((a, b) => b.total - a.total);
  const total = list.reduce((s, x) => s + x.total, 0);
  const el = $("#cat-bar");
  if (!total) { el.innerHTML = ""; return; }
  el.innerHTML = `
    <div class="cat-stack">${list.map((c) =>
      `<i style="--c:${c.color};flex:${c.total}" title="${esc(c.label)} ${fmt(c.total)}"></i>`).join("")}</div>
    <div class="cat-chips">${(state.catAll ? list : list.filter((c, i) => i < 8 || c.key === state.catFilter)).map((c) => `
      <button class="cat-chip ${state.catFilter === c.key ? "on" : ""}" data-cat="${c.key}" style="--c:${c.color}">
        <span class="dot">${I.svg(c.icon)}</span>${esc(c.label)}<b>${fmt(c.total)}</b><small>${Math.round(c.total / total * 100)}%</small>
      </button>`).join("")}
      ${list.length > 8 ? `<button class="cat-chip clear" data-more="1">${state.catAll ? "收起" : `更多 ${list.length - 8} 类`}</button>` : ""}
      ${state.catFilter ? `<button class="cat-chip clear" data-cat="">清除筛选 ✕</button>` : ""}
    </div>`;
}

// ---------------------------------------------------------------- rewards

const today = () => new Date().toISOString().slice(0, 10);
const creditAccounts = () => Object.values(state.accounts).filter((a) => a.type === "credit");
const productOf = (a) => (Object.hasOwn(state.rewards.cards, a.id) ? state.rewards.cards[a.id] || null : R.guessProduct(a));
const unitWord = (prog) => (R.PROGRAMS[prog].unit === "cash" ? "" : " 点");
const fmtBal = (v, prog) => R.fmtEarned(v, R.PROGRAMS[prog].unit) + unitWord(prog);

// logo：优先用 Plaid 返回的机构 logo，其次银行官网 favicon，最后是品牌色字母徽章
function logoSources(issuer, domain) {
  const hit = Object.entries(state.logos).find(([name, v]) => R.issuerOf(name) === issuer && v.logo);
  const list = [];
  const bf = domain && B.domainUrl(domain, 128);   // Brandfetch 高清图标优先
  if (bf) list.push(bf);
  if (hit) list.push(`data:image/png;base64,${hit[1].logo}`);
  if (domain) list.push(`https://www.google.com/s2/favicons?domain=${domain}&sz=256`);
  return list;
}

function logoHTML(issuer, domain, color, letter, cls) {
  const [src, ...rest] = logoSources(issuer, domain);
  const img = src
    ? `<img src="${esc(src)}" alt="${esc(issuer)}" ${rest.length ? `data-fallback="${esc(rest.join(" "))}"` : ""} referrerpolicy="strict-origin-when-cross-origin" onerror="logoFail(this)">`
    : "";
  return `<span class="${cls}" style="--brand:${esc(color || "#8a8276")}">${img}<i>${esc(letter)}</i></span>`;
}

window.logoFail = (img) => {
  const [next, ...rest] = (img.dataset.fallback || "").split(" ").filter(Boolean);
  if (!next) return img.remove();
  if (rest.length) img.dataset.fallback = rest.join(" "); else delete img.dataset.fallback;
  img.src = next;
};

function programLogo(key, cls = "plogo") {
  const p = R.PROGRAMS[key];
  return logoHTML(p.issuer, p.domain, p.color, p.issuer[0], cls);
}

function instLogo(institution) {
  const issuer = R.issuerOf(institution);
  const prog = Object.values(R.PROGRAMS).find((p) => p.issuer === issuer);
  const color = state.logos[institution]?.color || prog?.color;
  return logoHTML(issuer || institution, prog?.domain, color, String(institution || "?")[0], "ilogo");
}

function earnCell(t) {
  const e = state.earn.get(t.id);
  if (!e) return "";
  const prog = R.PROGRAMS[e.program];
  if (state.editing && e.cat !== "none") {
    const v = state.draft.rates[t.id] ?? Math.round(e.rate * 100) / 100;
    return `<label class="rate-edit" title="${esc(e.source)}">
      <input type="number" step="0.5" min="0" inputmode="decimal" data-rate="${esc(t.id)}" value="${esc(v)}">
      <span>${prog.unit === "cash" ? "%" : "x"}</span>
    </label>`;
  }
  if (e.cat === "none" || !e.earned) return "";
  const amt = R.fmtEarned(e.earned, prog.unit);
  return `<div class="earn" style="--brand:${prog.color}" title="${esc(e.source)}">
    ${e.earned > 0 ? "+" : ""}${amt}${prog.unit === "cash" ? "" : " " + prog.short}<span>${R.fmtRate(e.rate, prog.unit)}</span>
  </div>`;
}

function renderRewards() {
  const month = $("#r-month").value;
  const editing = state.editing;
  const balances = state.rewards.balances || {};

  // 汇总：每个积分计划 / 每张卡
  const progs = {};
  const cards = {};
  for (const a of creditAccounts()) {
    const pk = productOf(a);
    if (!pk) continue;
    const prog = R.PRODUCTS[pk].program;
    progs[prog] = progs[prog] || { month: 0, since: 0 };
    cards[a.id] = { a, pk, prog, spend: 0, earned: 0, cats: {} };
  }
  for (const t of state.txns) {
    const e = state.earn.get(t.id);
    if (!e || e.cat === "none") continue;
    const since = balances[e.program]?.updated;
    if (since && t.date > since) progs[e.program].since += e.earned;
    if (!t.date.startsWith(month)) continue;
    progs[e.program].month += e.earned;
    const c = cards[t.account_id];
    if (!c) continue;
    c.spend += t.amount; c.earned += e.earned;
    const label = R.catLabel(e.cat);
    c.cats[label] = (c.cats[label] || 0) + e.earned;
  }

  // 常用积分计划一直显示（没关联卡也显示，方便录余额）；Amex 现金返现只在用到时显示
  const ALWAYS = ["chase_ur", "citi_ty", "amex_mr", "marriott", "barclays", "apple_cash"];
  const keys = Object.keys(R.PROGRAMS).filter((k) => ALWAYS.includes(k) || progs[k] || balances[k]);
  const [y, m] = month.split("-");
  $("#r-note").textContent = `${y} 年 ${Number(m)} 月 · Pending 为按卡片倍数估算的本月新增，以银行账单为准`;

  const unknown = creditAccounts().filter((a) => /_other$/.test(productOf(a) || ""));
  $("#r-unknown").innerHTML = unknown.length ? `<div class="unknown-bar">
      <b>${unknown.length} 张卡没认出卡型</b>，暂按 1x 计算。银行给的账户名太笼统时需要手动选一下：
      ${unknown.map((a) => `<label class="unknown-row"><span>${esc(a.institution)} · ${esc(a.name)}${a.mask ? " ··" + esc(a.mask) : ""}</span>
        <select data-map="${esc(a.id)}"><option value="">不计积分</option>${productOptions(productOf(a))}</select></label>`).join("")}
    </div>` : "";

  $("#program-list").innerHTML = keys.map((k) => {
    const p = R.PROGRAMS[k], g = progs[k], b = balances[k];
    const unitTxt = p.unit === "cash" ? "" : "点";
    const balView = editing
      ? `<label class="bal-edit"><span>${p.unit === "cash" ? "$" : ""}</span><input type="number" step="${p.unit === "cash" ? "0.01" : "1"}" min="0" inputmode="decimal" data-bal="${k}" value="${esc(state.draft.balances[k] ?? b?.value ?? "")}" placeholder="输入总积分"><span>${unitTxt}</span></label>`
      : b
        ? `<div class="pbal">${esc(R.fmtEarned(b.value, p.unit))}<small>${unitWord(k)}</small></div>`
        : `<div class="pbal empty-bal">—<small>点 ⚙ →「更新」录入</small></div>`;
    const since = g?.since || 0;
    const metaLine = editing
      ? "保存后记为今天的余额"
      : b
        ? `更新于 ${esc(b.updated)}${since ? ` · 含之后新增估算 <b>${esc(fmtBal(b.value + since, k))}</b>` : ""}`
        : "&nbsp;";
    return `<article class="program" style="--brand:${p.color}">
      <header>${programLogo(k)}<div><div class="pname">${esc(p.name)}</div><div class="pissuer">${esc(p.issuer)}</div></div></header>
      <div class="plabel">Balance · 总积分</div>
      ${balView}
      <div class="pmeta">${metaLine}</div>
      <div class="pmonth">
        <span>Pending · ${Number(m)} 月</span>
        ${g ? `<b>${g.month >= 0 ? "+" : ""}${esc(fmtBal(g.month, k))}</b>` : `<em>未关联卡片</em>`}
      </div>
    </article>`;
  }).join("");
  updateScrollButtons();

  const rows = Object.values(cards).sort((x, y) => y.earned - x.earned || y.spend - x.spend);
  $("#card-earn").innerHTML = rows.length ? `<div class="card earn-table">${rows.map((c) => {
    const p = R.PROGRAMS[c.prog];
    const eff = c.spend > 0 ? (c.earned / c.spend) * (p.unit === "cash" ? 100 : 1) : 0;
    const chips = Object.entries(c.cats).sort((a, b) => b[1] - a[1]).slice(0, 4)
      .map(([n, v]) => `<span class="chip">${esc(n)} ${esc(R.fmtEarned(v, p.unit))}</span>`).join("");
    return `<div class="earn-row">
      ${programLogo(c.prog, "plogo sm")}
      <div class="er-main">
        <div class="er-title">${esc(R.PRODUCTS[c.pk].name)}${/_other$/.test(c.pk) ? '<span class="tag warn-tag">未识别卡型</span>' : ""}<span class="meta"> · ${esc(c.a.name)}${c.a.mask ? " ··" + esc(c.a.mask) : ""}</span></div>
        <div class="chips">${chips || '<span class="meta">本月暂无消费</span>'}</div>
      </div>
      <div class="er-num">
        <div><b>${c.earned >= 0 ? "+" : ""}${esc(fmtBal(c.earned, c.prog))}</b></div>
        <div class="meta">消费 ${fmt(c.spend)}${c.spend > 0 ? ` · 平均 ${esc(R.fmtRate(eff, p.unit))}` : ""}</div>
      </div>
    </div>`;
  }).join("")}</div>` : "";
}

function productOptions(sel) {
  const groups = {};
  for (const [k, p] of Object.entries(R.PRODUCTS)) (groups[p.issuer] = groups[p.issuer] || []).push([k, p]);
  return Object.entries(groups).map(([iss, list]) =>
    `<optgroup label="${esc(iss)}">${list.map(([k, p]) =>
      `<option value="${k}" ${k === sel ? "selected" : ""}>${esc(p.name)} · ${esc(R.PROGRAMS[p.program].short)}</option>`).join("")}</optgroup>`).join("");
}

function updateScrollButtons() {
  const el = $("#program-list");
  const max = el.scrollWidth - el.clientWidth;
  $("#p-prev").disabled = el.scrollLeft <= 2;
  $("#p-next").disabled = el.scrollLeft >= max - 2;
  $(".program-scroller").classList.toggle("scrollable", max > 2);
}

function renderSettings() {
  const accts = creditAccounts();
  const options = productOptions;
  $("#card-map").innerHTML = accts.length ? accts.map((a) => `
    <label class="map-row">
      <span>${esc(a.institution)} · ${esc(a.name)}${a.mask ? " ··" + esc(a.mask) : ""}</span>
      <select data-map="${esc(a.id)}"><option value="">不计积分</option>${options(productOf(a))}</select>
    </label>`).join("") : `<p class="hint">还没有信用卡账户</p>`;

  const rules = [];
  for (const [acct, map] of Object.entries(state.rewards.rules || {})) {
    for (const [key, rate] of Object.entries(map)) rules.push({ acct, key, rate });
  }
  $("#rule-list").innerHTML = rules.length ? rules.map((r) => {
    const a = state.accounts[r.acct];
    const pk = a && productOf(a);
    const unit = pk ? R.PROGRAMS[R.PRODUCTS[pk].program].unit : "pts";
    return `<div class="rule-row">
      <span>${esc(a ? a.name + (a.mask ? " ··" + a.mask : "") : "已断开的卡")} · ${esc(R.ruleKeyLabel(r.key))}</span>
      <b>${esc(R.fmtRate(r.rate, unit))}</b>
      <button class="btn small ghost" data-unrule="${esc(r.acct)}|${esc(r.key)}">删除</button>
    </div>`;
  }).join("") : `<p class="hint">还没有。编辑模式下改过的倍数会出现在这里。</p>`;
}

async function saveRewards(next, okMsg) {
  const prev = state.rewards;
  state.rewards = next; render();
  try { await api("/api/rewards", { method: "PUT", body: { rewards: next } }); if (okMsg) toast(okMsg); return true; }
  catch (e) { state.rewards = prev; render(); toast(e.message); return false; }
}

function setEditing(on) {
  state.editing = on;
  state.draft = on ? { rates: {}, balances: {} } : null;
  $("#editbar").hidden = !on;
  $("#btn-edit").textContent = on ? "保存" : "更新";
  render();
}

async function saveEdit() {
  const next = JSON.parse(JSON.stringify(state.rewards));
  let changed = 0;
  for (const [tid, raw] of Object.entries(state.draft.rates)) {
    if (raw === "") continue;
    const v = Number(raw), e = state.earn.get(tid), t = state.txns.find((x) => x.id === tid);
    if (!e || !t || !Number.isFinite(v) || v < 0 || Math.abs(v - e.rate) < 1e-9) continue;
    (next.rules[t.account_id] = next.rules[t.account_id] || {})[e.key] = v;
    changed++;
  }
  let bal = 0;
  for (const [k, raw] of Object.entries(state.draft.balances)) {
    if (raw === "") { if (next.balances[k]) { delete next.balances[k]; bal++; } continue; }
    const v = Number(raw);
    if (!Number.isFinite(v) || v < 0) continue;
    if (next.balances[k]?.value === v) continue;
    next.balances[k] = { value: v, updated: today() };
    bal++;
  }
  state.editing = false; state.draft = null;
  $("#editbar").hidden = true; $("#btn-edit").textContent = "更新";
  if (!changed && !bal) { render(); return toast("没有改动"); }
  const parts = [];
  if (changed) parts.push(`${changed} 条倍数已记住`);
  if (bal) parts.push(`${bal} 个余额已更新`);
  await saveRewards(next, `已保存：${parts.join("，")}`);
}

async function resync() {
  const btn = $("#btn-resync");
  if (!confirm("重新拉取所有银行的全部交易？需要一点时间。")) return;
  btn.disabled = true; btn.textContent = "拉取中…";
  try { ingest(await api("/api/resync", { method: "POST" })); toast("已重新拉取全部交易"); }
  catch (e) { toast(e.message); }
  finally { btn.disabled = false; btn.textContent = "重新拉取全部交易"; }
}

function toggleSettings(open) {
  const panel = $("#settings"), btn = $("#btn-settings");
  const show = open ?? panel.hidden;
  panel.hidden = !show;
  btn.setAttribute("aria-expanded", String(show));
}

function bindRewards() {
  $("#r-month").addEventListener("input", renderRewards);
  const pl = $("#program-list");
  const step = () => (pl.querySelector(".program")?.offsetWidth || 280) + 12;
  $("#p-prev").addEventListener("click", () => pl.scrollBy({ left: -step(), behavior: "smooth" }));
  $("#p-next").addEventListener("click", () => pl.scrollBy({ left: step(), behavior: "smooth" }));
  pl.addEventListener("scroll", updateScrollButtons, { passive: true });
  window.addEventListener("resize", updateScrollButtons);
  $("#btn-settings").addEventListener("click", (e) => { e.stopPropagation(); toggleSettings(); });
  document.addEventListener("click", (e) => {
    if (!$("#settings").hidden && !e.target.closest(".settings-wrap")) toggleSettings(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("#settings").hidden) toggleSettings(false);
    else if (state.editing) setEditing(false);
  });
  $("#btn-edit").addEventListener("click", () => { toggleSettings(false); state.editing ? saveEdit() : setEditing(true); });
  $("#btn-edit-save").addEventListener("click", saveEdit);
  $("#btn-edit-cancel").addEventListener("click", () => setEditing(false));
  $("#btn-resync").addEventListener("click", resync);

  document.addEventListener("input", (e) => {
    const el = e.target;
    if (el.dataset.rate && state.draft) state.draft.rates[el.dataset.rate] = el.value;
    if (el.dataset.bal && state.draft) state.draft.balances[el.dataset.bal] = el.value;
  });
  document.addEventListener("change", (e) => {
    const el = e.target;
    if (!el.dataset.map) return;
    const next = JSON.parse(JSON.stringify(state.rewards));
    next.cards[el.dataset.map] = el.value;
    saveRewards(next, "卡片对应已更新");
  });
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-unrule]");
    if (!b) return;
    const [acct, ...rest] = b.dataset.unrule.split("|");
    const key = rest.join("|");
    const next = JSON.parse(JSON.stringify(state.rewards));
    if (next.rules[acct]) { delete next.rules[acct][key]; if (!Object.keys(next.rules[acct]).length) delete next.rules[acct]; }
    saveRewards(next, "已删除，恢复按卡片默认倍数");
  });
}

// ---------------------------------------------------------------- ui

// ---------------------------------------------------------------- login

function showLogin(msg) {
  state.items = []; state.txns = []; state.benefits = []; state.accounts = {};
  state.rewards = EMPTY_REWARDS(); state.earn = new Map(); state.logos = {};
  state.editing = false; state.draft = null; $("#editbar").hidden = true;
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
  bindRewards();
  $("#cat-bar").addEventListener("click", (e) => {
    if (e.target.closest("[data-more]")) { state.catAll = !state.catAll; return renderCatBar(); }
    const b = e.target.closest("[data-cat]");
    if (!b) return;
    state.catFilter = state.catFilter === b.dataset.cat ? "" : b.dataset.cat;
    renderTxns();
  });

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
$("#r-month").value = $("#f-month").value;
render();
if (cfg.token) {
  showApp();
  if (!resumeOAuth()) load().catch((e) => toast(e.message));
} else {
  showLogin();
}
