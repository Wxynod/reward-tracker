// Reward Tracker — Apple Card：没有 Plaid、也拿不到 FinanceKit，靠上传 Apple 导出的交易 CSV 记账。
// · 解析 CSV（Transaction Date / Clearing Date / Description / Merchant / Category / Type / Amount (USD)）
// · 去重：交易 id 由「交易日 + 入账日 + 金额 + 描述 + 类型 + 当天第几笔」算出来，同一笔交易在任何一份 CSV 里 id 都一样，
//   Worker 的 /api/manual/import 对已存在的 id 直接跳过 → CSV 的日期范围可以随便重叠，重复上传也不会重复记账。
//   完全相同的两行（同一天两次同价地铁）靠「第几笔」区分；Apple 按整天导出，所以这个序号是稳定的。
// · 账单：月底出账，次月倒数第 5 天还款；上期账单金额按入账日累计推算（liability()，每次打开页面现算）。
// · 入口：账户详情里的「交易记录 · CSV 导入」；还没有 Apple Card 时，账户页底部有一块引导。
// 用到 app.js 的全局：state、api、load、toast、esc、fmt、today、instLogo、RT_ACCT。

(function () {
  const ITEM_ID = "manual:apple_card", ACCT_ID = "apple_card";
  const COLS = ["Transaction Date", "Clearing Date", "Description", "Merchant", "Category", "Type", "Amount (USD)"];

  // ---------------------------------------------------------------- CSV
  function parseCSV(text) {
    const rows = []; let row = [], cur = "", q = false;
    const s = text.replace(/^﻿/, "");
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) {
        if (c === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ",") { row.push(cur); cur = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && s[i + 1] === "\n") i++;
        row.push(cur); cur = "";
        if (row.length > 1 || row[0] !== "") rows.push(row);
        row = [];
      } else cur += c;
    }
    row.push(cur);
    if (row.length > 1 || row[0] !== "") rows.push(row);
    return rows;
  }

  // ---------------------------------------------------------------- 文本整理
  const squash = (s) => s.toUpperCase().replace(/\s+/g, "");
  const tidy = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  function hash(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36); }
  const titleCase = (s) => s.toLowerCase().replace(/(^|[\s\-/(&*.,])([a-z])/g, (_, a, b) => a + b.toUpperCase())
    .replace(/\bHk\b/g, "HK").replace(/\bUsa\b/g, "USA").replace(/\bIfc\b/g, "IFC").replace(/'S\b/g, "'s");
  const isoDate = (s) => { const m = String(s || "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null; };

  // Description = 商户名 + 地址连在一起。Merchant 通常是 Description 的开头（忽略大小写和空格），据此切开；
  // Merchant 是 Apple 自己起的名字（Apple ifc mall）时切不开，整段 Description 当地址。
  function splitDesc(desc, merchantRaw, splittable) {
    const M = tidy(merchantRaw.replace(/\(return\)\s*$/i, "")), D = tidy(desc.replace(/\(RETURN\)\s*$/i, ""));
    const m = squash(M), d = squash(D);
    if (m && d.startsWith(m) && m.length < d.length) {
      let n = 0, i = 0;
      while (i < D.length && n < m.length) { if (!/\s/.test(D[i])) n++; i++; }
      let head = D.slice(0, i).trim(), addr = D.slice(i).trim();
      const x = head.length > 32 && splittable ? head.match(/^(.*?)(\d.*)$/) : null;   // 商户栏混进了大半个地址
      if (x && x[1].trim().length >= 3) { head = x[1].trim(); addr = tidy(`${x[2]}${/^[A-Z]{1,3}\b/.test(addr) ? "" : " "}${addr}`); }
      return { head, addr, own: false };
    }
    if (m === d) {
      const x = splittable ? D.match(/^(.*?)(\d.*)$/) : null;   // 商户栏把地址也带上了：从第一个数字切开
      return x && x[1].trim().length >= 3 ? { head: x[1].trim(), addr: x[2].trim(), own: false } : { head: D, addr: "", own: false };
    }
    return { head: M, addr: D, own: true };
  }

  const VIA = { ALIPAYHK: "AlipayHK", ALIPAY: "Alipay", WEIXIN: "WeChat Pay", UMS: "UnionPay", KPAY: "KPay", QFPAY: "QFPay", BBMSL: "BBMSL", FARFETCH: null };
  // 常见商户的规范写法（去掉门店号，也方便匹配 logo）
  const KNOWN = [[/^mcdonald/i, "McDonald's"], [/^kfc\b/i, "KFC"], [/^7-?eleven/i, "7-Eleven"], [/^parknshop/i, "PARKnSHOP"], [/^lululemon/i, "lululemon"],
    [/^hong ?kong disneyland/i, "Hong Kong Disneyland"], [/^tfl\b/i, "TfL"], [/^t mobile/i, "T-Mobile Hotspot"], [/^heytea/i, "HEYTEA"], [/^starbucks/i, "Starbucks"],
    [/^wellcome/i, "Wellcome"], [/^mannings/i, "Mannings"], [/^don don donki/i, "Don Don Donki"], [/^taobao/i, "Taobao"], [/^pinduoduo/i, "Pinduoduo"]];
  function prettyName(head, own) {
    if (/^UBR\*|\bUBER\b/i.test(head)) return { name: "Uber", via: null };
    if (/^apple$/i.test(head)) return { name: "Apple Store", via: null };
    let s = head, via = null;
    const ag = s.match(/^([A-Z]+)\s*\*\s*/i);
    if (ag && ag[1].toUpperCase() in VIA) { via = VIA[ag[1].toUpperCase()]; s = s.slice(ag[0].length); }
    const k = KNOWN.find(([re]) => re.test(s));
    if (k) return { name: k[1], via };
    if (own) return { name: tidy(s), via };
    s = tidy(s.replace(/\s*\([^)]*$/, "").replace(/\(\d+\)\s*$/, "").replace(/(\D)\s*\d{3,}$/, "$1").replace(/[\s,\-]+$/, ""));
    return { name: titleCase(s) || titleCase(head), via };
  }

  const ISO3 = { HKG: "Hong Kong", CHN: "China", USA: "United States", GBR: "United Kingdom", NLD: "Netherlands", JPN: "Japan", TWN: "Taiwan", MAC: "Macau",
    SGP: "Singapore", KOR: "South Korea", DEU: "Germany", FRA: "France", ITA: "Italy", ESP: "Spain", CAN: "Canada", AUS: "Australia", THA: "Thailand", CHE: "Switzerland" };
  // 地址收尾：去掉占位的 000000 / UNKNOWN / NA 和结尾的国家代码（HKG、CHNCHN、HKGHK、ENGGBR…），国家单独存
  function cleanAddr(a) {
    let s = tidy(a.replace(/\b0{5,}\b/g, " ").replace(/([A-Za-z])0{6,}/g, "$1 "));
    let country = null;
    const parts = s.split(" "), last = parts[parts.length - 1] || "";
    const code = ISO3[last.slice(-3)] ? last.slice(-3) : /HK$/.test(last) && ISO3[last.slice(0, 3)] ? last.slice(0, 3) : null;
    if (code && /^[A-Z]{3,6}$/.test(last)) { country = ISO3[code]; parts.pop(); s = parts.join(" "); }
    s = tidy(s.replace(/\b(UNKNOWN|NA)$/i, "").replace(/([A-Za-z])0+$/, "$1").replace(/\s0+$/, "").replace(/[\s,&]+$/, ""));
    return { address: s ? titleCase(s) : null, country };
  }

  // Apple 的 Category → 记账本用的 Plaid 类别
  const CAT = {
    restaurants: ["FOOD_AND_DRINK", "FOOD_AND_DRINK_RESTAURANT"], grocery: ["FOOD_AND_DRINK", "FOOD_AND_DRINK_GROCERIES"],
    transportation: ["TRANSPORTATION", "TRANSPORTATION_PUBLIC_TRANSIT"], gas: ["TRANSPORTATION", "TRANSPORTATION_GAS"],
    shopping: ["GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE"],
    entertainment: ["ENTERTAINMENT", "ENTERTAINMENT_OTHER_ENTERTAINMENT"],
    "govt-services-parking": ["GOVERNMENT_AND_NON_PROFIT", "GOVERNMENT_AND_NON_PROFIT_OTHER_GOVERNMENT_AND_NON_PROFIT"],
    travel: ["TRAVEL", "TRAVEL_OTHER_TRAVEL"], hotels: ["TRAVEL", "TRAVEL_LODGING"], airlines: ["TRAVEL", "TRAVEL_FLIGHTS"],
    medical: ["MEDICAL", "MEDICAL_OTHER_MEDICAL"], health: ["PERSONAL_CARE", "PERSONAL_CARE_OTHER_PERSONAL_CARE"],
    utilities: ["RENT_AND_UTILITIES", "RENT_AND_UTILITIES_OTHER_UTILITIES"], services: ["GENERAL_SERVICES", "GENERAL_SERVICES_OTHER_GENERAL_SERVICES"],
    alcohol: ["FOOD_AND_DRINK", "FOOD_AND_DRINK_BEER_WINE_AND_LIQUOR"],
  };
  function categoryOf(r, name) {
    if (r.type === "Payment") return ["LOAN_PAYMENTS", "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT"];
    if (r.type === "Debit") return ["BANK_FEES", "BANK_FEES_OTHER_BANK_FEES"];                       // Daily Cash 扣回
    if (r.type === "Other") return r.amount < 0 ? ["INCOME", "INCOME_OTHER_INCOME"] : ["BANK_FEES", "BANK_FEES_OTHER_BANK_FEES"];
    if (name === "Uber") return ["TRANSPORTATION", "TRANSPORTATION_TAXIS_AND_RIDE_SHARES"];
    if (/APPLE\.COM\/BILL/i.test(r.desc)) return ["GENERAL_SERVICES", "GENERAL_SERVICES_OTHER_GENERAL_SERVICES"];
    if (/^APPLE\b/i.test(r.desc)) return ["GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_ELECTRONICS"];
    if (/MCDONALD|\bKFC\b/i.test(r.desc)) return ["FOOD_AND_DRINK", "FOOD_AND_DRINK_FAST_FOOD"];
    return CAT[r.category.toLowerCase()] || [null, null];
  }

  // ---------------------------------------------------------------- CSV → 交易
  function convert(text) {
    const table = parseCSV(text);
    if (!table.length) throw new Error("文件是空的");
    const head = table[0].map(tidy), ix = Object.fromEntries(COLS.map((c) => [c, head.indexOf(c)]));
    const lost = COLS.filter((c) => ix[c] < 0);
    if (lost.length) throw new Error(`不是 Apple Card 的交易 CSV：缺少「${lost.join("、")}」列`);
    const rows = [], bad = [];
    table.slice(1).forEach((x, i) => {
      const r = { date: isoDate(x[ix["Transaction Date"]]), clear: isoDate(x[ix["Clearing Date"]]), desc: tidy(x[ix.Description]),
        merchant: tidy(x[ix.Merchant]), category: tidy(x[ix.Category]), type: tidy(x[ix.Type]), amount: Number(String(x[ix["Amount (USD)"]]).replace(/[$,\s]/g, "")) };
      if (!r.date || !Number.isFinite(r.amount) || !r.desc) bad.push(i + 2); else rows.push(r);
    });
    // 退款的类别跟原来那笔消费走
    const catByHead = new Map();
    const seq = {}, out = [];
    for (const r of rows) {
      const sp = splitDesc(r.desc, r.merchant || r.desc, r.type === "Purchase" || r.type === "Credit");
      let { name, via } = prettyName(sp.head, sp.own);
      if (r.type === "Payment") name = r.desc.match(/ENDING IN (\d{4})/i) ? `Payment · ACH ··${r.desc.match(/ENDING IN (\d{4})/i)[1]}` : "Payment";
      else if (r.type === "Debit" || r.type === "Other") name = titleCase(r.desc);
      let [primary, detailed] = categoryOf(r, name);
      const hk = squash(sp.head);
      if (r.type === "Purchase" && primary) catByHead.set(hk, [primary, detailed]);
      r._sp = sp; r._name = name; r._via = via; r._cat = [primary, detailed]; r._hk = hk;
    }
    for (const r of rows) {
      const sp = r._sp;
      let [primary, detailed] = r._cat;
      if (r.type === "Credit") [primary, detailed] = catByHead.get(r._hk) || ["GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE"];
      const spend = r.type === "Purchase" || r.type === "Credit";
      // 支付平台 / Uber / Apple 服务的「地址」是平台总部，不是商户，不放进地址栏
      const platform = /^(ALIPAY|WEIXIN|UBR\*)|APPLE\.COM\/BILL/i.test(r.desc);
      const loc = spend && sp.addr && !platform ? cleanAddr(sp.addr) : null;
      const base = `${r.date}:${r.clear || r.date}:${Math.round(r.amount * 100)}:${hash(squash(r.desc) + "|" + r.type)}`;
      seq[base] = (seq[base] || 0) + 1;
      out.push({
        id: `apple:${base}:${seq[base]}`,
        account_id: ACCT_ID,
        date: r.date, authorized_date: r.date,
        name: r._name, merchant: spend ? r._name : null,
        amount: Math.round(r.amount * 100) / 100, currency: "USD",
        category: primary, category_detail: detailed,
        mcc: null, channel: null, pending: false, source: "apple_csv",
        detail: Object.fromEntries(Object.entries({
          original_description: r.desc,
          apple_type: r.type || null,
          apple_category: r.category || null,
          apple_merchant: r.merchant || null,
          post_date: r.clear,
          via: r._via,
          personal_finance_category: primary ? { primary, detailed } : null,
          location: loc && (loc.address || loc.country) ? loc : null,
          platform_address: spend && platform ? true : null,
        }).filter(([, v]) => v !== null && v !== undefined)),
      });
    }
    return { txns: out, bad };
  }

  // ---------------------------------------------------------------- 账单：月底出账，次月倒数第 5 天还款
  const pad = (n) => String(n).padStart(2, "0");
  const eom = (y, m) => `${y}-${pad(m)}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;           // m：1–12
  const dueOf = (y, m) => `${y}-${pad(m)}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate() - 4)}`;     // 当月倒数第 5 天
  function liability(a, txns, t0) {
    const mine = txns.filter((t) => t.account_id === a.id && !t.pending);
    if (!mine.length) return null;
    const y = +t0.slice(0, 4), m = +t0.slice(5, 7);
    const stmt = m === 1 ? eom(y - 1, 12) : eom(y, m - 1);
    const bal = mine.reduce((s, t) => s + ((t.detail?.post_date || t.date) <= stmt ? t.amount : 0), 0);
    const pay = mine.filter((t) => t.category === "LOAN_PAYMENTS" && t.amount < 0).sort((p, q) => (p.date < q.date ? 1 : -1))[0];
    return {
      last_statement_balance: Math.round(bal * 100) / 100, last_statement_issue_date: stmt,
      minimum_payment_amount: null, next_payment_due_date: dueOf(y, m),
      last_payment_amount: pay ? -pay.amount : null, last_payment_date: pay ? pay.date : null,
      is_overdue: null, aprs: [], eom: true, computed: true, source: "apple_csv",
    };
  }

  // ---------------------------------------------------------------- 状态
  const is = (a) => a?.id === ACCT_ID;
  const account = () => state.accounts[ACCT_ID] || null;
  const item = () => state.items.find((it) => it.item_id === ITEM_ID) || null;
  const ymd = (d) => `${d.slice(0, 4)} 年 ${+d.slice(5, 7)} 月 ${+d.slice(8, 10)} 日`;
  const md = (d) => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`;
  function status() {
    const mine = state.txns.filter((t) => t.account_id === ACCT_ID);
    if (!mine.length) return { count: 0 };
    let last = "", first = "9999";
    for (const t of mine) { if (t.date > last) last = t.date; if (t.date < first) first = t.date; }
    const age = Math.round((new Date(today()) - new Date(last)) / 864e5);
    return { count: mine.length, last, first, age, synced: item()?.last_synced || null };
  }

  let pending = null, busy = false, error = "";

  async function readFile(file) {
    error = ""; pending = null;
    try {
      if (!file) return;
      if (file.size > 5 * 1024 * 1024) throw new Error("文件超过 5 MB，不像是交易 CSV");
      const { txns, bad } = convert(await file.text());
      if (!txns.length) throw new Error("文件里没有交易");
      const have = new Set(state.txns.filter((t) => t.account_id === ACCT_ID).map((t) => t.id));
      const fresh = txns.filter((t) => !have.has(t.id));
      const dates = txns.map((t) => t.date).sort();
      const types = {};
      for (const t of fresh) types[t.detail.apple_type || "Other"] = (types[t.detail.apple_type || "Other"] || 0) + 1;
      pending = { file: file.name, txns, fresh, bad, from: dates[0], to: dates[dates.length - 1], types };
    } catch (e) { error = e.message || String(e); }
    refresh();
  }

  async function upload() {
    if (!pending || busy) return;
    busy = true; error = ""; refresh();
    try {
      const d = await api("/api/manual/import", { method: "POST", body: {
        item_id: ITEM_ID,
        item: { institution: "Apple Card", notice: "Apple Card 交易 CSV 上传，不经 Plaid" },
        accounts: [{ id: ACCT_ID, name: "Apple Card", official_name: "Goldman Sachs Bank USA", type: "credit", subtype: "credit card", currency: "USD", balance_from_txns: true, opening_balance: 0 }],
        transactions: pending.txns,
      } });
      if (d.rejected?.length) throw new Error(`${d.rejected.length} 笔被拒：${d.rejected[0].reason}`);
      const msg = d.added ? `Apple Card：新增 ${d.added} 笔，已存在跳过 ${d.skipped} 笔` : `Apple Card：没有新交易（${d.skipped} 笔都已存在）`;
      pending = null; busy = false;
      await load();
      toast(msg);
    } catch (e) { busy = false; error = e.message || String(e); }
    refresh();
  }

  function refresh() {
    window.RT_ACCT?.refresh();
    if (typeof renderAccounts === "function") renderAccounts();
  }

  // ---------------------------------------------------------------- 界面
  const ICO_DOC = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>`;
  const ICO_UP = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V5m0 0-4 4m4-4 4 4"/><path d="M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3"/></svg>`;
  const TYPE_ZH = { Purchase: "消费", Payment: "还款", Credit: "退款", Debit: "Daily Cash 扣回", Other: "调整" };

  function previewHTML() {
    const p = pending, n = p.fresh.length;
    const sample = [...p.fresh].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 4);
    return `<div class="ap-preview">
        <div class="ap-file">${ICO_DOC}<span>${esc(p.file)}</span></div>
        <div class="ap-stats">
          <div><small>文件里</small><b>${p.txns.length}</b><em>笔</em></div>
          <div class="${n ? "new" : ""}"><small>将新增</small><b>${n}</b><em>笔</em></div>
          <div><small>已存在 · 跳过</small><b>${p.txns.length - n}</b><em>笔</em></div>
          <div class="wide"><small>日期范围</small><b>${md(p.from)} – ${md(p.to)}</b><em>${p.from.slice(0, 4)}${p.to.slice(0, 4) !== p.from.slice(0, 4) ? "–" + p.to.slice(0, 4) : ""}</em></div>
        </div>
        ${n ? `<div class="ap-chips">${Object.entries(p.types).map(([k, v]) => `<span>${esc(TYPE_ZH[k] || k)} ${v}</span>`).join("")}</div>
        <ul class="ap-sample">${sample.map((t) => `<li><span>${md(t.date)}</span><b>${esc(t.name)}</b><i class="${t.amount < 0 ? "in" : ""}">${t.amount > 0 ? "−" : "+"}${esc(fmt(Math.abs(t.amount)))}</i></li>`).join("")}${n > sample.length ? `<li class="more"><span></span><b>另有 ${n - sample.length} 笔</b><i></i></li>` : ""}</ul>`
          : `<p class="ap-none">这份 CSV 里的交易都已经在记账本里了，不需要导入。</p>`}
        ${p.bad.length ? `<p class="ap-warn">第 ${esc(p.bad.slice(0, 6).join("、"))} 行读不出日期或金额，已跳过</p>` : ""}
        <div class="ap-actions">
          <button class="btn ghost" data-apple-cancel ${busy ? "disabled" : ""}>取消</button>
          <button class="btn primary" data-apple-confirm ${busy || !n ? "disabled" : ""}>${busy ? "导入中…" : n ? `导入 ${n} 笔` : "没有新交易"}</button>
        </div>
      </div>`;
  }

  // 导入面板：账户详情和账户页引导共用
  function panelHTML({ sec = true } = {}) {
    const st = status();
    const stale = st.count && st.age > 35;
    const upto = st.count
      ? `<p class="ap-upto"><small>交易记录更新到</small><b>${ymd(st.last)}</b><em class="${stale ? "stale" : ""}">${st.age <= 0 ? "今天" : `${st.age} 天前`}</em></p>`
      : `<p class="ap-upto"><small>还没有导入过交易</small></p>`;
    return `<section class="${sec ? "ad-sec " : ""}ap-import" data-apple-import>
        <div class="ap-head">
          <span class="ap-ico">${ICO_DOC}</span>
          <div class="ap-title"><h4>交易记录 · CSV 导入</h4>${upto}</div>
        </div>
        ${st.count ? `<p class="ap-meta">共 ${st.count} 笔 · 最早 ${ymd(st.first)}${st.synced ? ` · 上次导入 ${esc(new Date(st.synced).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }))}` : ""}</p>` : ""}
        ${pending ? previewHTML() : `<label class="ap-drop" data-apple-drop tabindex="0">
          <input type="file" accept=".csv,text/csv" data-apple-file hidden>
          ${ICO_UP}
          <b>选择 CSV 文件</b>
          <span>或把文件拖到这里</span>
        </label>`}
        ${error ? `<p class="ap-warn err">${esc(error)}</p>` : ""}
        <p class="ap-safe">日期范围可以和以前的重叠，已经记过的交易会自动跳过，不会重复。</p>
        <details class="ap-how"><summary>怎么导出 CSV？</summary>
          <ol>
            <li>iPhone 打开「钱包」，点 Apple Card，再点「卡余额」。</li>
            <li>选一期结单，点「导出交易」，格式选 CSV。</li>
            <li>把文件存到「文件」或隔空投送到电脑，回到这里上传。</li>
          </ol>
          <p>拿不准从哪天开始，就多选几个月，重复的部分不会重复记账。</p>
        </details>
      </section>`;
  }

  // 账户页底部：还没有 Apple Card 时的引导
  function onboardHTML() {
    if (item()) return "";
    return `<div class="card manual ap-onboard">
        <div class="inst-head">
          <h3 class="with-logo">${instLogo("Apple Card")}<span class="inst-name">Apple Card</span></h3>
          <div class="inst-actions"><span class="src-tag">非 Plaid</span></div>
        </div>
        <p class="ap-lead">Apple Card 连不上 Plaid。上传一份从「钱包」导出的交易 CSV，就能把它记进来：之后每次上传新的 CSV 接着记。</p>
        ${panelHTML({ sec: false })}
      </div>`;
  }

  // 账户详情里的说明（和香港卡的「没有通过 Plaid 连接」同一种样式）
  function noteHTML() {
    return `<section class="ad-sec ad-manual">
        <h4>没有通过 Plaid 连接</h4>
        <p>Apple Card 由 Goldman Sachs 发行，Plaid 连不上：交易来自你上传的 CSV。这样会有以下影响：</p>
        <ul>
          <li><b>不会自动同步。</b>「同步」「立刻从银行刷新」对它没有作用；上传新的 CSV 才会更新。</li>
          <li><b>当前欠款</b>是已导入交易的累计，截至最后一笔交易那天；之后的消费要等下次上传。</li>
          <li><b>账单日和还款日</b>按固定规则推算：每月最后一天出账，次月倒数第 5 天还款。最低还款 CSV 里没有。</li>
          <li><b>Daily Cash</b>按 Apple Pay 2% 估算，Apple 和 Uber 按 3%；个别不对的，在设置的「更新」里逐笔改。</li>
          <li><b>没有 MCC，</b>类别取自 Apple 的分类；地址取自交易描述，支付平台（Alipay、WeChat Pay）和 Uber 的不显示。</li>
        </ul>
      </section>`;
  }

  // ---------------------------------------------------------------- 事件
  if (typeof document !== "undefined") {
  document.addEventListener("change", (e) => {
    const f = e.target.closest?.("[data-apple-file]");
    if (f) readFile(f.files[0]);
  });
  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-apple-cancel]")) { pending = null; error = ""; refresh(); return; }
    if (e.target.closest("[data-apple-confirm]")) { upload(); return; }
    if (e.target.closest("[data-apple-open]")) {
      window.RT_ACCT?.open(ACCT_ID);
      setTimeout(() => document.querySelector("#acct-detail [data-apple-import]")?.scrollIntoView({ block: "start", behavior: "smooth" }), 320);
    }
  });
  document.addEventListener("keydown", (e) => {
    const d = e.target.closest?.("[data-apple-drop]");
    if (d && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); e.stopPropagation(); d.querySelector("input").click(); }
  }, true);
  for (const ev of ["dragenter", "dragover", "dragleave", "drop"]) {
    document.addEventListener(ev, (e) => {
      const d = e.target.closest?.("[data-apple-drop]");
      if (!d) return;
      e.preventDefault();
      d.classList.toggle("over", ev === "dragenter" || ev === "dragover");
      if (ev === "drop") readFile(e.dataTransfer?.files?.[0]);
    });
  }

  }

  const api_ = { ITEM_ID, ACCT_ID, is, liability, status, panelHTML, onboardHTML, noteHTML, convert, TYPE_ZH };
  if (typeof module !== "undefined" && module.exports) module.exports = api_;
  if (typeof window !== "undefined") window.RT_APPLE = api_;
})();
