// ==UserScript==
// @name         Amex HK → 记账本 · 交易推送
// @namespace    local.amex-hk-ledger-push
// @version      1.2.0
// @description  截获 Amex HK 网银页面自己加载的交易和账户概况（總結欠、月結單結欠、還款日、可用信用額），推送到记账本（Reward Tracker）Worker。交易按 Amex 参考号去重，和月结单 CSV 导入的交易共用同一个 id。
// @match        https://global.americanexpress.com/*
// @run-at       document-start
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      reward-tracker.tom-rt.workers.dev
// ==/UserScript==

// 工作方式
// 1. document-start 时包住页面的 fetch：页面自己带着 account_token 去请求 /api/servicing/v1/financials/transactions，
//    脚本只读返回的 JSON，不碰令牌、不自己发 Amex 请求。
// 2. 页面已经缓存、不再请求时（例如在页面内来回切换），从页面的 Redux 缓存里补读一次。
// 3. 交易 id = "amexhk:" + reference_id，和 scripts/import_amex_hk.mjs 导入的结单交易一致：
//    · Worker 端：已存在的 id 直接跳过（待入账的除外，可以被更新）；
//    · 本地：记住已推送成功的 id，没有新交易就不发请求；
//    · 待入账：抓到完整待入账列表时带 replace_pending，Worker 删掉已经不在列表里的旧待入账（已入账或被撤销）。
// 4. 只推卡号末五位在 CARDS 里的卡；其他卡（例如附属卡）忽略。
// 5. 账户概况（首页 Dashboard 那块）：總結欠 → 当前欠款，可用信用額 / 信用額 → 可用额度 / 额度，
//    月結單結欠 → 上期账单，尚欠 → 月结单未还，還款日 / 最低還款额。来自页面的 ReadCardAccountVitals 数据，
//    内容没变就不重复推（最多每 6 小时刷新一次时间戳）。
//
// 6. 界面（1.2.0 起）：右下角 Amex 蓝的液态玻璃球体（和「活动追踪」脚本共用同一个球体）。点开是菜单：立即同步、
//    上次推送结果、自动推送开关、写入令牌、Worker 地址、清空本地去重记录、打开记账本。每次推送（自动或手动）先唤醒球体，
//    再从球体里长出进度卡片（进度条 + 百分比 + 当前步骤），完成后显示结果并收回球体。
//
// 首次使用：点球体 →「设置写入令牌」，填 Worker 的 INGEST_TOKEN。

(() => {
  'use strict';

  const DEFAULT_URL = 'https://reward-tracker.tom-rt.workers.dev';
  const ITEM_ID = 'manual:amex_hk';
  // 卡号末五位 → 记账本里的账户 id（和导入脚本一致）
  const CARDS = { '52004': 'amexhk_platinum_52004', '01006': 'amexhk_explorer_01006' };
  const KEY = 'amex-hk-ledger:';
  const SEEN_MAX = 6000;
  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  const cfg = {
    get url() { return (GM_getValue(KEY + 'url', DEFAULT_URL) || DEFAULT_URL).replace(/\/+$/, ''); },
    get token() { return GM_getValue(KEY + 'token', ''); },
  };
  let seen = new Set(GM_getValue(KEY + 'seen', []));
  const saveSeen = () => GM_setValue(KEY + 'seen', [...seen].slice(-SEEN_MAX));

  // ---------------------------------------------------------------- 转换
  const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  function category(desc) {
    if (/^PAYMENT RECEIVED/i.test(desc)) return ['LOAN_PAYMENTS', 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'];
    if (/FINANCE CHARGE/i.test(desc)) return ['BANK_FEES', 'BANK_FEES_INTEREST_CHARGE'];
    if (/LATE PAYMENT CHARGE/i.test(desc)) return ['BANK_FEES', 'BANK_FEES_LATE_FEES'];
    return [null, null];
  }
  // 没有 reference_id 的待入账交易：用卡号 + 日期 + 金额 + 描述做一个稳定的哈希 id
  function hash(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(36);
  }
  const DATE = /^\d{4}-\d{2}-\d{2}$/;

  function convert(t) {
    const tail = clean(t.display_account_number).slice(-5);
    const account_id = CARDS[tail];
    if (!account_id) return null;                    // 不是要记账的卡
    const date = DATE.test(t.charge_date) ? t.charge_date : DATE.test(t.post_date) ? t.post_date : null;
    const amount = typeof t.amount === 'number' ? t.amount : Number(t.amount);
    if (!date || !Number.isFinite(amount)) return null;
    const pending = String(t.status || '').toLowerCase() === 'pending';
    const ref = clean(t.reference_id).replace(/'/g, '');
    const desc = clean(t.description || t.extended_details?.merchant?.display_name);
    const id = ref ? `amexhk:${ref}` : `amexhk:pending:${hash([tail, date, amount, desc].join('|'))}`;
    if (!ref && !pending) return null;               // 已入账却没有参考号：不推，避免以后和结单重复
    const m = t.extended_details?.merchant || {};
    const addr = m.address || {};
    const fx = t.foreign_details;
    const cat = t.extended_details?.category;
    const [c1, c2] = category(desc);
    return {
      id, account_id, date, name: desc, merchant: null, amount, currency: 'HKD',
      category: c1, category_detail: c2, pending, source: 'amex_hk_web',
      detail: {
        original_description: clean(m.display_name) || desc,
        location: (addr.address_lines?.length || addr.country_name) ? {
          address: clean((addr.address_lines || []).join(', ')) || null,
          city: clean(addr.city) || null,
          postal_code: clean(addr.postal_code) || null,
          country: clean(addr.country_name) || null,
        } : undefined,
        foreign: fx?.amount ? { amount: Number(fx.amount), currency: fx.currency_description || fx.iso_alpha_currency_code, rate: Number(fx.exchange_rate) || null } : undefined,
        amex_category: cat ? [cat.category_name, cat.subcategory_name].filter(Boolean).join('-') : undefined,
        reference: ref || undefined,
        statement_date: t.statement_end_date || undefined,
        post_date: t.post_date || undefined,
      },
    };
  }

  // ---------------------------------------------------------------- 账户概况（Dashboard）
  const amt = (x) => (x?.amount != null && Number.isFinite(Number(x.amount)) ? Number(x.amount) : null);
  const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== ''));
  function vitalsTail(v) {
    for (const la of v.loyaltyAccounts || []) for (const r of la.relationships || []) if (/\d{5}/.test(r.displayAccountNumber || '')) return clean(r.displayAccountNumber).slice(-5);
    const t = (v.transactions || []).find((x) => x.panLastFive);
    return t ? clean(t.panLastFive).slice(-5) : null;
  }
  function convertVitals(v) {
    if (!v || (!v.balances && !v.creditLimits && !v.paymentSummary)) return null;
    const tail = vitalsTail(v) || currentCardTail();
    const account_id = CARDS[tail];
    if (!account_id) return null;
    const b = v.balances?.[0] || {};
    const cl = v.creditLimits || {};
    const pd = v.paymentSummary?.paymentDueDetails || {};
    const sbd = v.balanceCreditDetails?.balanceDetails?.statementBalanceData || {};
    const issue = sbd.previousCycleEndDate || (v.statementPeriods || []).find((x) => x.index === 1)?.statementEndDate;
    const balances = compact({
      balance_current: amt(b.statementBalanceAmount),          // 總結欠
      balance_available: amt(cl.availableCreditAmount),        // 可用信用額
      limit: amt(cl.totalCreditAmount),                        // 信用額
    });
    const liabilities = compact({
      last_statement_balance: amt(b.lastStatementBalanceAmount) ?? amt(sbd.statementBalance), // 月結單結欠
      last_statement_issue_date: DATE.test(issue || '') ? issue : null,
      minimum_payment_amount: amt(pd.minimumPaymentDueAmount),
      next_payment_due_date: DATE.test(pd.paymentDueDate || '') ? pd.paymentDueDate : null,
      remaining_statement_balance: amt(b.remainingStatementBalanceAmount),                     // 月結單尚欠
      source: 'amex_hk_web',
    });
    if (!Object.keys(balances).length && Object.keys(liabilities).length <= 1) return null;
    return { account_id, balances, liabilities };
  }
  const snaps = new Map();   // account_id → 待推送的概况
  function collectVitals(v) {
    const c = convertVitals(v);
    if (!c) return false;
    const sig = JSON.stringify([c.balances, c.liabilities]);
    const last = GM_getValue(KEY + 'vitals:' + c.account_id, null);
    if (last && last.sig === sig && Date.now() - last.at < 6 * 3600e3) return false;  // 没变化，不推
    const now = new Date().toISOString();
    snaps.set(c.account_id, { sig, balances: { ...c.balances, as_of: now }, liabilities: { ...c.liabilities, as_of: now } });
    schedule();
    return true;
  }
  // 在任意 JSON 里找 Vitals 对象（接口返回可能套了一层）
  function findVitals(o, d = 0) {
    if (!o || typeof o !== 'object' || d > 4) return null;
    if (o.creditLimits || (o.balances && o.paymentSummary)) return o;
    for (const k of Object.keys(o)) { const r = findVitals(o[k], d + 1); if (r) return r; }
    return null;
  }

  // ---------------------------------------------------------------- 收集 + 推送
  const queue = new Map();          // id → 交易
  const pendingFull = new Set();    // 本轮抓到了完整待入账列表的账户
  let timer = null;

  function collect(list, { pendingList = false } = {}) {
    let n = 0;
    const accts = new Set();
    for (const raw of list || []) {
      const t = convert(raw);
      if (!t) continue;
      accts.add(t.account_id);
      // 已推送过的已入账交易不再发；待入账的每次都发（Worker 要靠完整列表判断哪些已入账）
      if (!t.pending && seen.has(t.id)) continue;
      queue.set(t.id, t); n++;
    }
    if (pendingList) {
      // 待入账列表为空时 accts 也是空的：从列表来源无法得知是哪张卡，交给页面当前卡号判断
      const cur = currentCardAccount();
      if (cur) accts.add(cur);
      for (const a of accts) pendingFull.add(a);
    }
    if (n || pendingFull.size) schedule();
    return n;
  }
  const autoOn = () => GM_getValue(KEY + 'auto', true);
  const schedule = () => { clearTimeout(timer); if (autoOn()) timer = setTimeout(() => push(), 1500); };

  function currentCardTail() {
    const txt = W.document?.querySelector('button.account-switcher-toggler')?.textContent || '';
    return (txt.match(/(\d{5})(?!\d)/) || [])[1] || null;
  }
  const currentCardAccount = () => CARDS[currentCardTail()] || null;

  const CARD_NAME = (a) => (a.includes('platinum') ? '白金卡' : 'Explorer');
  let pushing = false, pushedOnce = false;
  function push(manual = false, task = null) {
    clearTimeout(timer);
    if (!queue.size && !pendingFull.size && !snaps.size) { task?.done('没有需要推送的内容', 'quiet', 3000); return; }
    if (pushing) { timer = setTimeout(() => push(manual), 1500); return; }
    const k = ui();
    if (!cfg.token) {
      const msg = '还没设置写入令牌：点球体 →「设置写入令牌」，填 Worker 的 INGEST_TOKEN。交易先留在队列里。';
      if (task) task.fail(msg, { title: '记账本未连接' }); else k.toast(msg, 'warn', 9000, '记账本未连接');
      return;
    }
    const transactions = [...queue.values()];
    const replace_pending = [...pendingFull];
    const sent = [...snaps.entries()];
    queue.clear(); pendingFull.clear(); snaps.clear();
    const requeue = () => {
      for (const t of transactions) if (!queue.has(t.id)) queue.set(t.id, t);
      for (const a of replace_pending) pendingFull.add(a);
      for (const [a, x] of sent) if (!snaps.has(a)) snaps.set(a, x);
    };
    pushing = true;
    const t = task || k.task('amex-push', '同步 Amex 交易');
    k.status('正在推送…', 'run');
    const posted = transactions.filter((x) => !x.pending).length, pend = transactions.length - posted;
    const what = [posted ? `${posted} 笔新交易` : '', pend ? `${pend} 笔待入账` : '', sent.length ? `${sent.map(([a]) => CARD_NAME(a)).join('、')}的账户概况` : ''].filter(Boolean).join('、');
    t.step(`整理${what || '待入账列表'}`, 30);
    setTimeout(() => t.step('推送到记账本', 52).trickle(95, 2500), 260);
    const fail = (msg) => {
      pushing = false; requeue();
      GM_setValue(KEY + 'lastError', { at: Date.now(), message: msg });
      t.fail(msg + '。交易已放回队列。', { title: '推送失败', retry: () => push(true) });
      refreshMenu();
    };
    GM_xmlhttpRequest({
      method: 'POST',
      url: `${cfg.url}/api/manual/import`,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.token}` },
      data: JSON.stringify({
        item_id: ITEM_ID,
        item: { institution: 'American Express HK', region: 'HK' },
        transactions,
        ...(replace_pending.length ? { replace_pending } : {}),
        ...(sent.length ? {
          balances: Object.fromEntries(sent.map(([a, x]) => [a, x.balances])),
          liabilities: Object.fromEntries(sent.map(([a, x]) => [a, x.liabilities])),
        } : {}),
      }),
      timeout: 30000,
      onload: (r) => {
        let d = {};
        try { d = JSON.parse(r.responseText); } catch { /* 非 JSON */ }
        if (r.status !== 200) return fail(`记账本返回 ${r.status}：${d.error || r.statusText}`);
        pushing = false; pushedOnce = true;
        for (const t of transactions) if (!t.pending) seen.add(t.id);
        saveSeen();
        for (const [a, x] of sent) GM_setValue(KEY + 'vitals:' + a, { sig: x.sig, at: Date.now() });
        GM_setValue(KEY + 'last', { at: Date.now(), ...d, sent: transactions.length, vitals: sent.map(([a]) => a) });
        const parts = [
          d.added ? `新增 ${d.added} 笔` : '', d.updated ? `更新 ${d.updated} 笔` : '', d.removed ? `移除待入账 ${d.removed} 笔` : '',
          d.skipped ? `跳过 ${d.skipped} 笔已存在` : '',
          sent.length ? `更新${sent.map(([a]) => CARD_NAME(a)).join('、')}的欠款和账单` : '',
          d.rejected?.length ? `${d.rejected.length} 笔被拒：${d.rejected[0].reason || ''}` : '',
        ].filter(Boolean);
        const level = d.rejected?.length ? 'warn' : (d.added || d.updated || d.removed || sent.length) ? 'good' : 'quiet';
        t.done(parts.join(' · ') || '没有新交易', level, level === 'warn' ? 9000 : 5200);
        if (d.added) k.badge(d.added);
        refreshMenu();
      },
      onerror: () => fail('连不上记账本 Worker'),
      ontimeout: () => fail('推送超时'),
    });
  }

  // ---------------------------------------------------------------- 截获页面的交易请求
  const TXN_URL = /\/api\/servicing\/v\d+\/financials\/transactions(\?|$)/;
  const VITALS_URL = /ReadCardAccountVitals/i;
  const WATCH = (u) => TXN_URL.test(u) || VITALS_URL.test(u);
  function handle(url, json) {
    try {
      if (!json) return;
      if (VITALS_URL.test(url)) { collectVitals(findVitals(json)); return; }
      if (!TXN_URL.test(url)) return;
      const status = new URL(url, location.href).searchParams.get('status');
      collect(json.transactions, { pendingList: status === 'pending' });
    } catch (e) { console.warn('[记账本] 解析交易失败', e); }
  }
  const origFetch = W.fetch;
  if (origFetch) {
    W.fetch = function (input, init) {
      const p = origFetch.apply(this, arguments);
      try {
        const url = typeof input === 'string' ? input : input?.url || String(input);
        if (WATCH(url)) p.then((r) => { if (r.ok) r.clone().json().then((j) => handle(url, j)).catch(() => {}); }).catch(() => {});
      } catch { /* 不影响页面 */ }
      return p;
    };
  }
  const XO = W.XMLHttpRequest?.prototype;
  if (XO) {
    const open = XO.open, send = XO.send;
    XO.open = function (m, u) { this.__ledgerUrl = String(u); return open.apply(this, arguments); };
    XO.send = function () {
      if (WATCH(this.__ledgerUrl || '')) {
        this.addEventListener('load', () => { try { if (this.status === 200) handle(this.__ledgerUrl, JSON.parse(this.responseText)); } catch { /* 忽略 */ } });
      }
      return send.apply(this, arguments);
    };
  }

  // ---------------------------------------------------------------- 后备：从页面 Redux 缓存读
  function readStore() {
    const doc = W.document;
    const els = doc.querySelectorAll('main *, #root *, body > div *');
    let store = null;
    for (let i = els.length - 1; i >= 0 && !store; i -= Math.max(1, Math.floor(els.length / 40))) {
      const key = Object.keys(els[i]).find((k) => k.startsWith('__reactInternalInstance$') || k.startsWith('__reactFiber$'));
      let f = key && els[i][key];
      for (let hop = 0; f && !store && hop < 5000; hop++, f = f.return) {
        const p = f.memoizedProps;
        if (p?.store?.getState) store = p.store;
        else if (p?.value?.store?.getState) store = p.value.store;
      }
    }
    if (!store) return null;
    const st = store.getState();
    const root = (typeof st.toJS === 'function' ? st.toJS() : st)?.modules?.['axp-myca-root'] || {};
    const items = root.resources?.financialTransactions?.items;
    const vitals = root.procedures?.procedureCaches?.readCardAccountVitalsV1;
    return {
      txns: items ? Object.values(items).map((x) => x.data || x) : null,
      vitals: vitals ? Object.values(vitals).map((x) => x?.data || x) : [],
    };
  }
  // 从页面缓存读交易和账户概况。manual = 用户点了「立即同步」；announce = 自动同步也要显示结果（每次打开页面第一次）
  function pushFromStore(manual = false, announce = false) {
    const k = ui();
    const show = manual || (announce && !pushedOnce);   // 这次打开页面已经推送过就不再报「已是最新」
    const t = show ? k.task('amex-push', '同步 Amex 交易') : null;
    t?.step('读取页面上的交易和账户概况', 12);
    let s = null;
    try { s = readStore(); } catch (e) { console.warn('[记账本] 读页面缓存失败', e); }
    let v = 0;
    for (const x of s?.vitals || []) if (collectVitals(x)) v++;
    const n = s?.txns ? collect(s.txns) : 0;
    clearTimeout(timer);
    if (queue.size || pendingFull.size || snaps.size) {
      if (show || autoOn()) return setTimeout(() => push(manual, t), t ? 420 : 0);
      return;
    }
    if (!t) return;
    if (!s?.txns && !v) {
      setTimeout(() => t.done(manual ? '页面缓存里没找到交易或账户概况；打开首页或「最近交易」后再试' : '这一页没有交易数据', manual ? 'warn' : 'quiet', 6000), 420);
      return;
    }
    const total = s?.txns?.length || 0;
    setTimeout(() => t.done(total ? `已是最新 · 页面上的 ${total} 笔交易都已在记账本` : '已是最新 · 账户概况没有变化', 'quiet', 3600), 520);
  }

  // 进入交易页面后，若一直没截到请求（页面用了缓存），就从缓存补读
  let lastPath = '', announced = false;
  setInterval(() => {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    // 首页 / 交易页等：账户概况和交易都从缓存补读一次（已推过的会被过滤掉）。
    // 每次打开网银的第一次自动检查也显示进度卡片（没有新内容就显示「已是最新」）
    if (/^\/(dashboard|activity|account|overview)\b/.test(lastPath)) {
      setTimeout(() => { if (!autoOn()) return; pushFromStore(false, !announced); announced = true; }, 5000);
    }
  }, 1000);

  // ---------------------------------------------------------------- 球体菜单
  function ago(at) {
    const m = Math.round((Date.now() - at) / 60000);
    if (m < 1) return '刚刚';
    if (m < 60) return `${m} 分钟前`;
    if (m < 60 * 24) return `${Math.round(m / 60)} 小时前`;
    return new Date(at).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
  }
  function refreshMenu() {
    const k = ui();
    const l = GM_getValue(KEY + 'last', null), err = GM_getValue(KEY + 'lastError', null);
    if (err && (!l || err.at > l.at)) k.status(`${ago(err.at)}推送失败 · ${err.message}`, 'error');
    else if (l) k.status(`上次推送 ${ago(l.at)} · ${l.added ? `新增 ${l.added} 笔` : '没有新交易'}`, l.rejected?.length ? 'warn' : 'good');
    else k.status(cfg.token ? '还没推送过' : '未设置写入令牌', cfg.token ? 'quiet' : 'warn');
    const rows = l ? [
      ['时间', new Date(l.at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })],
      ['新增 / 更新', `${l.added} / ${l.updated}`],
      ['跳过已存在 / 移除待入账', `${l.skipped} / ${l.removed}`],
      ['记账本里共有', `${l.total} 笔`, (l.vitals?.length ? `同时更新了${l.vitals.map(CARD_NAME).join('、')}的欠款和账单` : '')],
    ] : [];
    k.section('push', {
      title: '交易推送', order: 1,
      items: [
        { rows, empty: '还没有推送过' },
        { label: '打开网银时自动推送', icon: 'bolt', toggle: autoOn(), onClick: (on) => { GM_setValue(KEY + 'auto', on); if (on && queue.size) schedule(); } },
        { label: '设置写入令牌', icon: 'key', value: cfg.token ? '已设置' : '未设置', keepOpen: true, onClick: setToken },
        { label: '设置 Worker 地址', icon: 'server', hint: cfg.url.replace(/^https?:\/\//, ''), keepOpen: true, onClick: setUrl },
        { label: '清空本地去重记录', icon: 'erase', hint: '下次把页面上的交易全部重发', danger: true, keepOpen: true, onClick: clearSeen },
      ],
    });
  }
  async function setToken() {
    const k = ui();
    const v = await k.dialog({ title: '写入令牌（交易推送）', message: 'Worker 的 INGEST_TOKEN，只用于写入记账本，不能读数据。' + (cfg.token ? '已设置；留空保持不变。' : ''),
      fields: [{ name: 'token', label: 'INGEST_TOKEN', type: 'password', placeholder: cfg.token ? '••••••••（不变）' : '粘贴令牌' }], ok: '保存' });
    if (v?.token?.trim()) { GM_setValue(KEY + 'token', v.token.trim()); k.toast('交易推送的写入令牌已保存', 'good'); refreshMenu(); if (queue.size || snaps.size) schedule(); }
  }
  async function setUrl() {
    const k = ui();
    const v = await k.dialog({ title: 'Worker 地址', message: '改成别的域名时，还要在脚本头部的 @connect 里加上这个域名。', fields: [{ name: 'url', label: '地址', value: cfg.url }], ok: '保存' });
    if (v?.url?.trim()) { GM_setValue(KEY + 'url', v.url.trim()); k.toast(`地址改为 ${v.url.trim()}`, 'warn', 6000, 'Worker 地址'); refreshMenu(); }
  }
  async function clearSeen() {
    const k = ui();
    if (!await k.confirm('清空本地去重记录', '下次会把页面上的交易全部重发一遍；记账本 Worker 仍会跳过已存在的交易，不会重复入账。', '清空', true)) return;
    seen = new Set(); saveSeen();
    for (const a of Object.values(CARDS)) GM_setValue(KEY + 'vitals:' + a, null);
    k.toast('已清空本地去重记录', 'quiet');
  }

  let kit = null;
  function ui() {
    if (kit) return kit;
    kit = glassOrb({
      brand: 'amex', title: 'Amex HK · 记账本', short: '记账本',
      rgb: '0,111,207', deep: '0,46,122', alpha: 0.5, ink: '#071e3d',
      logo: AMEX_LOGO, logoBox: ['56.5%', '50%', '87%'],
      ledgerUrl: 'https://wxynod.github.io/reward-tracker/',
    });
    kit.setPrimary({ label: '立即同步', onClick: () => pushFromStore(true) });
    kit.onOpen(() => { kit.badge(0); refreshMenu(); });
    refreshMenu();
    return kit;
  }
  const boot = () => { if (!/^\/login\b/.test(location.pathname)) ui(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true }); else boot();
  // Tampermonkey 菜单只留一个入口：球体被隐藏时用
  GM_registerMenuCommand('记账本：显示球体 / 立即同步', () => { ui().show(); pushFromStore(true); });

  const AMEX_LOGO = 'data:image/png;base64,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';

  // ==========================================================================================
  // Glass Orb kit v1 · 三个脚本里是同一份代码（改动请同步）
  // 右下角的液态玻璃球体：点开是菜单；同步 / 推送时先唤醒球体，再从球体里长出进度卡片。
  // 同一网站上有两个脚本时（Amex 交易推送 + 活动追踪）共用一个球体：先运行的脚本建球体，
  // 后来的脚本找到同一个元素（#rt-orb-<brand>，开放的 shadow root）往里加自己的菜单分组和进度卡片。
  // 不用 GM_* 存储，也不跨脚本传函数，只操作共享的 DOM。
  // ==========================================================================================
  function glassOrb(opt) {
    const ORB = 64, GAP = 12;
    const doc = document;
    const ID = 'rt-orb-' + opt.brand;
    let host = doc.getElementById(ID);
    const created = !host;
    if (created) {
      host = doc.createElement('div');
      host.id = ID;
      const root = host.attachShadow({ mode: 'open' });
      // 样式优先用 adoptedStyleSheets（不受网页 CSP 对内联 <style> 的限制），不支持再退回 <style>
      try { const sh = new CSSStyleSheet(); sh.replaceSync(ORB_CSS()); root.adoptedStyleSheets = [sh]; }
      catch { const st = doc.createElement('style'); st.textContent = ORB_CSS(); root.append(st); }
      const tpl = doc.createElement('template'); tpl.innerHTML = TEMPLATE(); root.append(tpl.content);
      host.style.setProperty('--rgb', opt.rgb);
      host.style.setProperty('--deep', opt.deep);
      host.style.setProperty('--a0', String(opt.alpha));
      host.style.setProperty('--ink', opt.ink);
      (doc.documentElement || doc).append(host);
    }
    const R = host.shadowRoot;
    const $ = (s, r = R) => r.querySelector(s);
    const orb = $('.orb'), menu = $('.menu'), cards = $('.cards'), defs = $('#rto-defs');
    const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
    const h = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    // ---------------------------------------------------------------- 初始化（只由建球体的脚本做一次）
    if (created) {
      $('.orb .logo').src = opt.logo;
      $('.m-logo img').src = opt.logo;
      $('.m-title').textContent = opt.title;
      orb.setAttribute('aria-label', opt.title);
      orb.style.setProperty('--logo-x', opt.logoBox?.[0] ?? '50%');
      orb.style.setProperty('--logo-y', opt.logoBox?.[1] ?? '50%');
      orb.style.setProperty('--logo-w', opt.logoBox?.[2] ?? '66%');
      $('.m-logo').style.cssText = orb.style.cssText;
      if (opt.ledgerUrl) {
        const a = $('.m-ledger'); a.href = opt.ledgerUrl; a.hidden = false;
      }
      // 弹簧曲线：CSS linear() 模拟质量-弹簧-阻尼系统（不支持时用 cubic-bezier 兜底）
      if (CSS.supports('transition-timing-function', 'linear(0, 1)')) {
        for (const [name, k, c] of [['bounce', 320, 21], ['soft', 240, 27], ['snap', 520, 40]]) {
          const s = springCurve(k, c);
          host.style.setProperty('--' + name, s.easing);
          host.style.setProperty('--' + name + '-ms', s.ms + 'ms');
        }
      }
      // 折射：先确认页面的 CSP 允许 data: 图片（feImage 要用），不允许就只用模糊
      const probe = new Image();
      probe.onload = () => { host.classList.add('lens'); lensAll(); };
      probe.src = lensMap(8, 8, 4, 3);

      // 指针跟随高光（球体和面板都用）
      R.addEventListener('pointermove', (e) => {
        const s = e.target.closest?.('.surf');
        if (!s) return;
        const r = s.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
        s.style.setProperty('--lx', (x * 100).toFixed(1) + '%');
        s.style.setProperty('--ly', (y * 100).toFixed(1) + '%');
        s.style.setProperty('--ang', (Math.atan2(y - 0.5, x - 0.5) * 180 / Math.PI + 90).toFixed(0) + 'deg');
      });
      R.addEventListener('pointerout', (e) => {
        const s = e.target.closest?.('.surf');
        if (s && !s.contains(e.relatedTarget)) { s.style.removeProperty('--lx'); s.style.removeProperty('--ly'); s.style.removeProperty('--ang'); }
      });
      orb.addEventListener('click', (e) => (menu.classList.contains('open') ? closeMenu() : openMenu('main', e.detail === 0)));
      doc.addEventListener('pointerdown', (e) => { if (menu.classList.contains('open') && !e.composedPath().includes(host)) closeMenu(); }, true);
      doc.addEventListener('keydown', (e) => { if (e.key === 'Escape' && menu.classList.contains('open')) { e.stopPropagation(); closeMenu(true); } }, true);
      $('.m-hide').addEventListener('click', () => { closeMenu(); setTimeout(() => { host.style.display = 'none'; }, 260); });
      orb.dataset.r = '32'; menu.dataset.r = '28';
      lens(orb);
    }

    // ---------------------------------------------------------------- 折射贴图
    function lensMap(w, h, r, band) {
      const c = doc.createElement('canvas'); c.width = w; c.height = h;
      const g = c.getContext('2d'); const img = g.createImageData(w, h); const d = img.data;
      const sd = (x, y) => {
        const qx = Math.abs(x - w / 2) - (w / 2 - r), qy = Math.abs(y - h / 2) - (h / 2 - r);
        return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
      };
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const px = x + 0.5, py = y + 0.5, i = (y * w + x) * 4;
        const depth = -sd(px, py);
        let dx = 0, dy = 0;
        if (depth > 0 && depth < band) {
          const nx = sd(px + 1, py) - sd(px - 1, py), ny = sd(px, py + 1) - sd(px, py - 1);
          const n = Math.hypot(nx, ny) || 1;
          const t = 1 - depth / band;                 // 边缘 = 1，往里减到 0
          const m = 1 - Math.sqrt(1 - t * t);         // 圆弧形的玻璃边：越靠边折得越厉害
          dx = (nx / n) * m; dy = (ny / n) * m;       // 往外取样：把边外的内容折进玻璃边里
        }
        d[i] = 128 + dx * 127; d[i + 1] = 128 + dy * 127; d[i + 2] = 128; d[i + 3] = 255;
      }
      g.putImageData(img, 0, 0);
      return c.toDataURL();
    }
    const lensCache = new Map();
    function lens(el) {
      if (!host.classList.contains('lens') || !el.isConnected) return;
      const w = Math.round(el.offsetWidth), hh = Math.round(el.offsetHeight);
      if (!w || !hh) return;
      const r = Math.min(Number(el.dataset.r) || 22, w / 2, hh / 2);
      const key = `${w}x${hh}r${Math.round(r)}`;
      let id = lensCache.get(key);
      if (!id) {
        id = 'rtl-' + key;
        if (!R.getElementById(id)) {
          const band = el === orb ? 15 : 13, scale = el === orb ? 30 : 24;
          defs.insertAdjacentHTML('beforeend',
            `<filter id="${id}" x="0" y="0" width="${w}" height="${hh}" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">` +
            `<feImage href="${lensMap(w, hh, r, band)}" x="0" y="0" width="${w}" height="${hh}" preserveAspectRatio="none" result="m"/>` +
            `<feDisplacementMap in="SourceGraphic" in2="m" scale="${scale}" xChannelSelector="R" yChannelSelector="G"/></filter>`);
        }
        lensCache.set(key, id);
      }
      el.style.setProperty('--lensf', `url(#${id})`);
      el.style.setProperty('--rr', r + 'px');
    }
    function lensAll() { R.querySelectorAll('.surf').forEach(lens); }

    // ---------------------------------------------------------------- 形变：元素从球体里长出来 / 收回球体
    // 关闭状态 = 把元素平移缩放到球体的位置和大小，圆角 50% 让它看起来就是那个圆球
    function morphVars(el) {
      const o = orb.getBoundingClientRect(), r = el.getBoundingClientRect();
      const tr = getComputedStyle(el).transform;
      // 读未变换时的几何：offset* 不受 transform 影响
      const w = el.offsetWidth, hh = el.offsetHeight;
      let cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if (tr && tr !== 'none') { const m = new DOMMatrixReadOnly(tr); cx -= m.e; cy -= m.f; }
      el.style.setProperty('--mx', (o.left + o.width / 2 - cx).toFixed(1) + 'px');
      el.style.setProperty('--my', (o.top + o.height / 2 - cy).toFixed(1) + 'px');
      el.style.setProperty('--sx', (ORB / w).toFixed(4));
      el.style.setProperty('--sy', (ORB / hh).toFixed(4));
    }

    // ---------------------------------------------------------------- 菜单
    let lastFocus = null;
    async function openMenu(view = 'main', kbd = false) {
      if (host.style.display === 'none') host.style.display = '';
      showView(view, false);
      cards.classList.add('aside');
      menu.classList.add('measuring');
      sizeMenu(false);
      morphVars(menu);
      menu.classList.remove('measuring');
      lens(menu);
      await frame();
      menu.classList.add('open'); orb.classList.add('open'); orb.setAttribute('aria-expanded', 'true');
      host.dispatchEvent(new Event('rto-open'));
      lastFocus = doc.activeElement;
      if (view === 'dialog' || kbd) setTimeout(() => { (R.querySelector('.m-view.on input, .m-view.on .row:not([disabled]), .m-view.on .m-primary:not([disabled])'))?.focus({ preventScroll: true }); }, 120);
    }
    function closeMenu(focusOrb = false) {
      if (!menu.classList.contains('open')) return;
      if (pendingDialog) pendingDialog(null, true);
      morphVars(menu);
      menu.classList.remove('open'); orb.classList.remove('open'); orb.setAttribute('aria-expanded', 'false');
      cards.classList.remove('aside');
      if (focusOrb) orb.focus({ preventScroll: true });
      orb.classList.remove('gulp'); void orb.offsetWidth; orb.classList.add('gulp');
    }
    function sizeMenu(animate = true) {
      const v = R.querySelector('.m-view.on');
      const max = Math.min(640, innerHeight - ORB - GAP - 44);
      const target = Math.min(max, v.scrollHeight);
      v.classList.toggle('scroll', v.scrollHeight > max + 1);
      if (!animate) menu.style.transition = 'none';
      menu.style.height = target + 'px';
      if (!animate) { void menu.offsetHeight; menu.style.transition = ''; }
      setTimeout(() => lens(menu), animate ? 420 : 0);
    }
    function showView(name, animate = true) {
      const views = R.querySelectorAll('.m-view');
      for (const v of views) {
        const on = v.dataset.view === name;
        v.classList.toggle('on', on);
        v.inert = !on;
      }
      if (animate) sizeMenu(true);
    }

    // ---------------------------------------------------------------- 菜单内容
    const ICONS = {
      sync: '<path d="M4 10a6 6 0 0 1 10.4-4.1L16 7.5M16 4v3.5h-3.5M16 10a6 6 0 0 1-10.4 4.1L4 12.5M4 16v-3.5h3.5"/>',
      upload: '<path d="M10 13V3.5M6.5 7 10 3.5 13.5 7M4 12.5V15a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 16 15v-2.5"/>',
      clock: '<circle cx="10" cy="10" r="6.5"/><path d="M10 6.5V10l2.5 1.6"/>',
      key: '<circle cx="7" cy="12.5" r="3"/><path d="m9.2 10.3 6.3-6.3M13 6.5l2 2M11.3 8.2l1.6 1.6"/>',
      server: '<rect x="3.5" y="4" width="13" height="5" rx="1.5"/><rect x="3.5" y="11" width="13" height="5" rx="1.5"/><path d="M6.5 6.5h.01M6.5 13.5h.01"/>',
      erase: '<path d="m8 16.5-4-4a1.4 1.4 0 0 1 0-2L11 3.5a1.4 1.4 0 0 1 2 0l3.5 3.5a1.4 1.4 0 0 1 0 2L9.5 16.5M8 16.5h8.5M6.5 8l5.5 5.5"/>',
      cards: '<rect x="3" y="5" width="14" height="10" rx="2"/><path d="M3 8.5h14M6 12h3"/>',
      reset: '<path d="M4 10a6 6 0 1 0 1.8-4.3L4 7.5M4 4v3.5h3.5"/>',
      chart: '<path d="M4 16V9M8.5 16V5M13 16v-5M17 16H3"/>',
      download: '<path d="M10 3.5V13M6.5 9.5 10 13l3.5-3.5M4 16.5h12"/>',
      gear: '<circle cx="10" cy="10" r="2.5"/><path d="M10 3v2M10 15v2M3 10h2M15 10h2M5 5l1.4 1.4M13.6 13.6 15 15M5 15l1.4-1.4M13.6 6.4 15 5"/>',
      scan: '<path d="M4 7V5.5A1.5 1.5 0 0 1 5.5 4H7M13 4h1.5A1.5 1.5 0 0 1 16 5.5V7M16 13v1.5a1.5 1.5 0 0 1-1.5 1.5H13M7 16H5.5A1.5 1.5 0 0 1 4 14.5V13M4 10h12"/>',
      bolt: '<path d="M11 3 5 11h4.5L9 17l6-8h-4.5z"/>',
    };
    const icon = (name) => `<svg viewBox="0 0 20 20" aria-hidden="true">${ICONS[name] || ICONS.gear}</svg>`;

    function section(key, def) {
      const box = $('.m-sections');
      let s = box.querySelector(`section[data-key="${key}"]`);
      const fresh = !s;
      if (fresh) { s = h('section'); s.dataset.key = key; s.style.order = def.order ?? 0; box.append(s); }
      s.replaceChildren();
      if (def.title) s.append(h('h6', '', def.title));
      for (const it of def.items || []) s.append(it.rows ? rowsBlock(it) : rowButton(it));
      if (menu.classList.contains('open')) sizeMenu(true);
    }
    function rowButton(it) {
      const b = h('button', 'row' + (it.danger ? ' danger' : ''));
      b.type = 'button';
      b.setAttribute('role', it.toggle != null ? 'menuitemcheckbox' : 'menuitem');
      if (it.toggle != null) b.setAttribute('aria-checked', String(!!it.toggle));
      b.disabled = !!it.disabled;
      b.innerHTML = `<span class="r-ico">${icon(it.icon)}</span><span class="r-txt"><span class="r-label"></span><span class="r-hint"></span></span><span class="r-trail"></span>`;
      $('.r-label', b).textContent = it.label;
      if (it.hint) $('.r-hint', b).textContent = it.hint; else $('.r-hint', b).remove();
      const trail = $('.r-trail', b);
      if (it.toggle != null) trail.innerHTML = `<span class="sw${it.toggle ? ' on' : ''}"><i></i></span>`;
      else if (it.value) trail.textContent = it.value;
      else if (it.external) trail.innerHTML = '<svg viewBox="0 0 20 20"><path d="M8 4.5H5.5A1.5 1.5 0 0 0 4 6v8.5A1.5 1.5 0 0 0 5.5 16H14a1.5 1.5 0 0 0 1.5-1.5V12M11 4h5v5M16 4l-7 7"/></svg>';
      b.addEventListener('click', async () => {
        if (b.disabled) return;
        if (it.toggle != null) {
          const sw = $('.sw', b); const on = !sw.classList.contains('on');
          sw.classList.toggle('on', on); b.setAttribute('aria-checked', String(on));
          it.onClick?.(on);
          return;
        }
        if (!it.keepOpen) closeMenu();
        await wait(it.keepOpen ? 0 : 140);
        it.onClick?.();
      });
      return b;
    }
    function rowsBlock(it) {
      const box = h('div', 'kv');
      for (const [label, value, sub] of it.rows) {
        const r = h('div', 'kv-row');
        r.append(h('span', 'kv-l', label), h('span', 'kv-v', value));
        if (sub) r.append(h('span', 'kv-s', sub));
        box.append(r);
      }
      if (!it.rows.length) box.append(h('div', 'kv-empty', it.empty || '暂无'));
      return box;
    }
    function setPrimary(p) {
      const b = $('.m-primary');
      if (!p) { b.hidden = true; return; }
      b.hidden = false;
      $('.mp-label', b).textContent = p.label;
      b.disabled = !!p.disabled; b.classList.toggle('busy', !!p.disabled);
      b.onclick = async () => { closeMenu(); await wait(140); p.onClick(); };
    }
    function status(text, level = 'quiet') {
      const s = $('.m-sub');
      s.dataset.level = level;
      $('span', s).textContent = text;
    }
    function badge(n) {
      const b = $('.orb .badge');
      if (!n) { b.classList.remove('on'); return; }
      b.textContent = n > 99 ? '99+' : String(n);
      b.classList.remove('on'); void b.offsetWidth; b.classList.add('on');
    }

    // ---------------------------------------------------------------- 对话框（在菜单里切换到表单页）
    let pendingDialog = null;
    function dialog(d) {
      return new Promise((resolve) => {
        if (pendingDialog) pendingDialog(null, true);
        const v = $('.m-view[data-view="dialog"]');
        v.replaceChildren();
        const form = h('form', 'dlg');
        const head = h('div', 'dlg-head');
        const back = h('button', 'dlg-back'); back.type = 'button'; back.setAttribute('aria-label', '返回');
        back.innerHTML = '<svg viewBox="0 0 20 20"><path d="M12.5 4.5 7 10l5.5 5.5"/></svg>';
        head.append(back, h('b', '', d.title));
        form.append(head);
        if (d.message) form.append(h('p', 'dlg-msg', d.message));
        const inputs = {};
        for (const f of d.fields || []) {
          const l = h('label', 'fld'); l.append(h('span', '', f.label));
          const i = h('input'); i.type = f.type || 'text'; i.value = f.value || ''; i.placeholder = f.placeholder || '';
          i.autocomplete = 'off'; i.spellcheck = false; i.name = f.name;
          l.append(i); form.append(l); inputs[f.name] = i;
        }
        const row = h('div', 'dlg-btns');
        const cancel = h('button', 'btn', d.cancel || '取消'); cancel.type = 'button';
        const ok = h('button', 'btn ' + (d.danger ? 'danger' : 'prim'), d.ok || '确定'); ok.type = 'submit';
        row.append(cancel, ok); form.append(row); v.append(form);
        let settled = false;
        const finish = (val, silent = false) => {
          if (settled) return;
          settled = true;
          if (pendingDialog === finish) pendingDialog = null;
          for (const i of Object.values(inputs)) i.value = '';     // 不把输入（例如令牌）留在页面里
          showView('main', false); sizeMenu(!silent);
          resolve(val);
        };
        pendingDialog = finish;
        back.onclick = cancel.onclick = () => finish(null);
        form.onsubmit = (e) => {
          e.preventDefault();
          finish(Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value])));
        };
        if (menu.classList.contains('open')) { showView('dialog'); setTimeout(() => (v.querySelector('input') || ok).focus({ preventScroll: true }), 200); }
        else openMenu('dialog');
      });
    }
    const confirmBox = (title, message, ok = '确定', danger = false) => dialog({ title, message, ok, danger }).then((v) => !!v);

    // ---------------------------------------------------------------- 进度卡片 / 通知
    const tasks = new Map();
    function makeCard(kind) {
      const c = h('div', 'card surf ' + kind);
      c.setAttribute('role', 'status');
      c.innerHTML = `${MAT()}<div class="ct"><div class="c-top"><span class="c-ico"><i class="spin"></i><svg class="ok" viewBox="0 0 20 20"><path d="M5 10.5 8.5 14 15 6.5"/></svg><svg class="bad" viewBox="0 0 20 20"><path d="M10 5.5v5.5M10 14.2v.1"/></svg></span><b class="c-title"></b><button class="c-x" type="button" aria-label="关闭"><svg viewBox="0 0 20 20"><path d="m6 6 8 8M14 6l-8 8"/></svg></button></div>` +
        `<div class="c-bar"><span class="track"><i class="fill"></i></span><span class="pct">0%</span></div><div class="c-step"></div><div class="c-act"></div></div>`;
      $('.c-x', c).onclick = () => dismiss(c);
      c.addEventListener('pointerenter', () => { c.dataset.hold = '1'; });
      c.addEventListener('pointerleave', () => { delete c.dataset.hold; if (c.dataset.dieAt && Date.now() > +c.dataset.dieAt) dismiss(c); });
      return c;
    }
    async function emerge(c) {
      if (!c.isConnected) cards.prepend(c);
      c.classList.add('measuring');
      morphVars(c); lens(c);
      c.classList.remove('measuring');
      await frame();
      c.classList.add('in');
    }
    async function dismiss(c) {
      if (!c.isConnected || c.classList.contains('leaving')) return;
      c.classList.add('leaving');
      morphVars(c);
      c.classList.remove('in');
      await wait(reduce() ? 0 : 420);
      // 其它卡片平滑补位（FLIP）
      const sibs = [...cards.children].filter((x) => x !== c);
      const before = new Map(sibs.map((x) => [x, x.getBoundingClientRect().top]));
      c.remove();
      for (const x of sibs) {
        const dy = before.get(x) - x.getBoundingClientRect().top;
        if (!dy) continue;
        x.animate([{ translate: `0 ${dy}px` }, { translate: '0 0' }], { duration: 420, easing: getComputedStyle(host).getPropertyValue('--soft') || 'ease-out' });
      }
      orb.classList.remove('gulp'); void orb.offsetWidth; orb.classList.add('gulp');
      for (const t of tasks.values()) if (t.card === c) tasks.delete(t.key);
      refreshRing();
    }
    function setStep(c, text) {
      const box = $('.c-step', c);
      if (box.lastElementChild?.textContent === text) return;
      const old = box.lastElementChild;
      const s = h('span', '', text);
      box.append(s);
      if (old) { old.classList.add('out'); setTimeout(() => old.remove(), 320); }
      requestAnimationFrame(() => s.classList.add('show'));
      requestAnimationFrame(() => lens(c));
    }
    function setPct(c, p) {
      p = Math.max(0, Math.min(100, p));
      c.dataset.pct = String(p);
      $('.fill', c).style.width = p + '%';
      // 百分比数字平滑滚动
      const el = $('.pct', c);
      const from = Number(c.dataset.shown || 0), t0 = performance.now(), dur = 520;
      cancelAnimationFrame(c._raf);
      const tick = (t) => {
        const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
        const v = from + (p - from) * e;
        c.dataset.shown = String(v);
        el.textContent = Math.round(v) + '%';
        if (k < 1) c._raf = requestAnimationFrame(tick);
      };
      c._raf = requestAnimationFrame(tick);
      refreshRing();
    }
    // 光环看共享 DOM 里所有还在进行的卡片（两个脚本的任务都算）
    function refreshRing() {
      const run = [...cards.querySelectorAll('.card.task:not(.end):not(.leaving)')];
      orb.classList.toggle('busy', run.length > 0);
      if (run.length) {
        const p = Math.min(...run.map((c) => Number(c.dataset.pct || 0)));
        orb.style.setProperty('--p', String(Math.max(3, p)));
        orb.classList.toggle('indet', p <= 0);
      }
    }
    function task(key, title) {
      const old = tasks.get(key);
      if (old && old.state === 'run') return old.api;
      if (old) dismiss(old.card);
      const c = makeCard('task');
      c.dataset.r = '22';
      $('.c-title', c).textContent = title;
      const t = { key, card: c, state: 'run', trickle: 0 };
      tasks.set(key, t);
      cards.prepend(c);          // 先放进去（关闭态 = 藏在球体里），光环据此立刻转起来
      // 先唤醒球体（光环转起来），再从球体里长出卡片
      orb.classList.remove('wake'); void orb.offsetWidth; orb.classList.add('wake');
      refreshRing();
      const shown = wait(reduce() ? 0 : 380).then(() => emerge(c)).then(refreshRing);
      const stopTrickle = () => { clearInterval(t.trickle); t.trickle = 0; };
      const api = {
        step(text, pct) { if (text) setStep(c, text); if (pct != null) { stopTrickle(); setPct(c, pct); } return api; },
        // 等待网络时进度慢慢往 to 靠近（永远到不了），避免卡在一个数字上
        trickle(to, ms = 6000) {
          stopTrickle();
          const start = Number(c.dataset.pct || 0), t0 = Date.now();
          t.trickle = setInterval(() => { const k = 1 - Math.exp(-(Date.now() - t0) / ms); setPct(c, start + (to - start) * k); }, 400);
          return api;
        },
        async done(text, level = 'good', ms = 4600) {
          stopTrickle(); await shown;
          t.state = level;
          c.classList.add('end', level);
          setPct(c, 100);
          if (text) setStep(c, text);
          refreshRing();
          if (level === 'good' || level === 'quiet') { orb.classList.remove('ok'); void orb.offsetWidth; orb.classList.add('ok'); }
          autoDismiss(c, ms);
          return api;
        },
        async fail(text, { retry, title: t2 } = {}) {
          stopTrickle(); await shown;
          t.state = 'error';
          c.classList.add('end', 'error');
          if (t2) $('.c-title', c).textContent = t2;
          setStep(c, text);
          if (retry) {
            const b = h('button', 'btn small', '重试'); b.type = 'button';
            b.onclick = () => { dismiss(c); setTimeout(retry, 300); };
            $('.c-act', c).replaceChildren(b);
          }
          refreshRing();
          return api;
        },
        title(s) { $('.c-title', c).textContent = s; return api; },
        close() { stopTrickle(); dismiss(c); },
      };
      t.api = api;
      return api;
    }
    function autoDismiss(c, ms) {
      if (!ms) return;
      c.dataset.dieAt = String(Date.now() + ms);
      setTimeout(() => { if (!c.dataset.hold) dismiss(c); }, ms);
    }
    function toast(text, level = 'good', ms = 4200, title) {
      const c = makeCard('note ' + level);
      c.dataset.r = '22';
      $('.c-title', c).textContent = title || ({ good: '完成', warn: '注意', error: '出错了', quiet: opt.short || '记账本' })[level] || opt.short;
      setStep(c, text);
      c.classList.add('end', level);
      orb.classList.remove('wake'); void orb.offsetWidth; orb.classList.add('wake');
      wait(reduce() ? 0 : 260).then(() => emerge(c));
      autoDismiss(c, ms + 400);
    }

    // 给活动追踪面板用：球体暂时藏起来（让位给从同一位置展开的面板）
    function conceal(on) { host.classList.toggle('concealed', !!on); if (on) closeMenu(); }
    // 卡片整体往左让位（例如活动追踪面板展开时）
    function shift(px) { cards.style.setProperty('--shift', (px || 0) + 'px'); }
    function onOpen(fn) { host.addEventListener('rto-open', fn); }

    return {
      host, created, orb,
      section, setPrimary, status, badge, task, toast, dialog, confirm: confirmBox,
      open: () => openMenu(), close: () => closeMenu(), conceal, shift, onOpen,
      show() { host.style.display = ''; },
      isOpen: () => menu.classList.contains('open'),
    };

    // ---------------------------------------------------------------- 模板
    function springCurve(k, c) {
      let x = 0, v = 0, t = 0, rest = 0; const dt = 1 / 240, pts = [0];
      while (t < 2.5) {
        v += (k * (1 - x) - c * v) * dt; x += v * dt; t += dt; pts.push(x);
        if (Math.abs(1 - x) < 0.0015 && Math.abs(v) < 0.02) { if (++rest > 24) break; } else rest = 0;
      }
      const n = 64, out = [];
      for (let i = 0; i < n; i++) out.push(+pts[Math.round(i * (pts.length - 1) / (n - 1))].toFixed(4));
      out[n - 1] = 1;
      return { easing: `linear(${out.join(', ')})`, ms: Math.round(t * 1000) };
    }
  }
  // 用函数而不是 const：脚本在初始化阶段就会调用 glassOrb()，这时文件末尾的 const 还没赋值
  function MAT() { return '<span class="mat"><i class="mb"></i><i class="ml"></i><i class="mt"></i><i class="mh"></i><i class="mr"></i></span>'; }
  function TEMPLATE() {
    return `<svg class="defs" width="0" height="0" aria-hidden="true"><defs id="rto-defs"></defs></svg>
<div class="cards" aria-live="polite"></div>
<div class="menu surf" role="menu">
  ${MAT()}
  <div class="m-wrap">
    <div class="m-view on" data-view="main">
      <div class="m-head"><span class="m-logo"><img alt=""></span><div class="m-ht"><div class="m-title"></div><div class="m-sub" data-level="quiet"><i></i><span>准备就绪</span></div></div></div>
      <button class="m-primary" type="button" hidden><svg viewBox="0 0 20 20"><path d="M4 10a6 6 0 0 1 10.4-4.1L16 7.5M16 4v3.5h-3.5M16 10a6 6 0 0 1-10.4 4.1L4 12.5M4 16v-3.5h3.5"/></svg><span class="mp-label">立即同步</span></button>
      <div class="m-sections"></div>
      <div class="m-foot"><a class="m-ledger" target="_blank" rel="noopener noreferrer" hidden>打开记账本<svg viewBox="0 0 20 20"><path d="M8 4.5H5.5A1.5 1.5 0 0 0 4 6v8.5A1.5 1.5 0 0 0 5.5 16H14a1.5 1.5 0 0 0 1.5-1.5V12M11 4h5v5M16 4l-7 7"/></svg></a><button class="m-hide" type="button">隐藏球体</button></div>
    </div>
    <div class="m-view" data-view="dialog"></div>
  </div>
</div>
<button class="orb surf" type="button" aria-haspopup="menu" aria-expanded="false">
  ${MAT()}
  <span class="lw"><img class="logo" alt="" draggable="false"></span>
  <svg class="ring" viewBox="0 0 76 76" aria-hidden="true"><circle class="rb" cx="38" cy="38" r="36"/><circle class="rf" cx="38" cy="38" r="36" pathLength="100"/></svg>
  <span class="badge"></span>
</button>`;
  }
  function ORB_CSS() { return `
:host{all:initial;position:fixed;right:20px;bottom:20px;width:64px;height:64px;z-index:2147483645;color-scheme:light;--a:var(--a0,.42);
  --bounce:cubic-bezier(.34,1.45,.5,1);--bounce-ms:620ms;--soft:cubic-bezier(.25,1.1,.4,1);--soft-ms:520ms;--snap:cubic-bezier(.3,1,.4,1);--snap-ms:260ms;
  --out:cubic-bezier(.55,0,.75,.3);
  font:500 13px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Segoe UI Variable Text","Segoe UI","Microsoft YaHei UI","Microsoft YaHei",system-ui,sans-serif;
  color:var(--ink);-webkit-font-smoothing:antialiased;letter-spacing:.005em}
:host(.concealed) .orb,:host(.concealed) .menu{visibility:hidden!important;transition:none!important}
*{box-sizing:border-box}
button{font:inherit;color:inherit;letter-spacing:inherit}
svg{fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
[hidden]{display:none!important}
.defs{position:absolute;width:0;height:0}

/* ---------------- 液态玻璃材质（五层）----------------
   mb 背景模糊 · ml 边缘折射（SVG 位移贴图）· mt 品牌色玻璃 · mh 指针高光 + 内阴影 · mr 高光描边
   注意：带 backdrop-filter 的层的祖先都不能有 opacity / filter，否则背景取不到，所以淡入淡出都只作用在各层自己身上 */
.surf{--lx:32%;--ly:18%;--ang:-35deg}
.mat{position:absolute;inset:0;border-radius:inherit;pointer-events:none;z-index:0}
.mat>i{position:absolute;inset:0;border-radius:inherit;opacity:var(--o,1);transition:opacity var(--fd,.22s) ease var(--fdl,0s)}
.mb{backdrop-filter:blur(var(--bl,4px)) saturate(190%) brightness(var(--br,1.04));-webkit-backdrop-filter:blur(var(--bl,4px)) saturate(190%) brightness(var(--br,1.04))}
:host(.lens) .ml{backdrop-filter:var(--lensf,none);clip-path:inset(0 round var(--rr,50%))}
.mt{background:
  linear-gradient(rgba(255,255,255,var(--veil,0)),rgba(255,255,255,var(--veil,0))),
  radial-gradient(140% 120% at 28% 12%,rgba(var(--rgb),calc(var(--a) - .12)),rgba(var(--rgb),var(--a)) 52%,rgba(var(--deep),calc(var(--a) + .1)))}
.mh{background:radial-gradient(70% 55% at var(--lx) var(--ly),rgba(255,255,255,var(--sheen,.38)),rgba(255,255,255,0) 72%);
  box-shadow:inset 0 1.5px 1px -.5px rgba(255,255,255,.95),inset 0 -1.5px 1.5px -.5px rgba(255,255,255,.45),
    inset 0 -10px 18px -10px rgba(var(--deep),.22),inset 0 0 0 .5px rgba(255,255,255,.28)}
.mr{padding:1.2px;background:conic-gradient(from var(--ang),rgba(255,255,255,.98),rgba(255,255,255,.2) 18%,rgba(255,255,255,.06) 34%,rgba(255,255,255,.5) 50%,rgba(255,255,255,.06) 66%,rgba(255,255,255,.2) 82%,rgba(255,255,255,.98));
  -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;transition:opacity .3s ease}

/* ---------------- 球体 ---------------- */
.orb{position:absolute;inset:0;width:64px;height:64px;padding:0;border:0;border-radius:50%;background:none;cursor:pointer;outline:none;
  --veil:0;--bl:3px;--sheen:.42;-webkit-tap-highlight-color:transparent;
  box-shadow:0 14px 30px -10px rgba(var(--deep),.55),0 3px 8px -2px rgba(var(--deep),.25);
  transition:transform var(--bounce-ms) var(--bounce),box-shadow .35s ease}
.orb:hover{transform:scale(1.07);box-shadow:0 18px 38px -10px rgba(var(--deep),.6),0 4px 10px -2px rgba(var(--deep),.25)}
.orb:active{transform:scale(.9);transition-duration:.14s;transition-timing-function:ease-out}
.orb.open{transform:scale(.94)}
.orb:focus-visible{box-shadow:0 0 0 3px #fff,0 0 0 5.5px rgba(var(--rgb),.85),0 14px 30px -10px rgba(var(--deep),.55)}
.lw{position:absolute;inset:0;border-radius:50%;overflow:hidden;z-index:1;pointer-events:none}
.orb .logo{position:absolute;left:var(--logo-x);top:var(--logo-y);width:var(--logo-w);transform:translate(-50%,-50%);pointer-events:none;
  filter:drop-shadow(0 .6px .6px rgba(var(--deep),.55)) drop-shadow(0 0 6px rgba(var(--deep),.25));
  transition:transform var(--bounce-ms) var(--bounce)}
.orb:active .logo{transform:translate(-50%,-50%) scale(.94)}
.orb::after{content:'';position:absolute;inset:0;border-radius:50%;pointer-events:none;z-index:2;
  background:radial-gradient(42% 26% at 40% 16%,rgba(255,255,255,.55),rgba(255,255,255,0) 100%)}
.orb.wake{animation:wake .72s var(--bounce) 1}
@keyframes wake{0%{transform:scale(1)}28%{transform:scale(1.16)}100%{transform:scale(1)}}
.orb.gulp{animation:gulp .5s var(--bounce) 1}
@keyframes gulp{0%{transform:scale(1)}30%{transform:scale(.9,.94)}100%{transform:scale(1)}}
.orb.ok .mr{animation:okrim 1.1s ease 1}
@keyframes okrim{0%,100%{filter:none}30%{filter:drop-shadow(0 0 4px rgba(255,255,255,.95))}}

.ring{position:absolute;left:-6px;top:-6px;width:76px;height:76px;pointer-events:none;z-index:3;opacity:0;transform:rotate(-90deg) scale(.86);
  transition:opacity .35s ease,transform var(--bounce-ms) var(--bounce)}
.ring circle{stroke-width:2.4;fill:none}
.ring .rb{stroke:rgba(var(--rgb),.16)}
.ring .rf{stroke:rgb(var(--rgb));stroke-dasharray:calc(var(--p,3) * 1) 100;transition:stroke-dasharray .6s cubic-bezier(.22,1,.36,1);
  filter:drop-shadow(0 0 2px rgba(var(--rgb),.6))}
.orb.busy .ring{opacity:1;transform:rotate(-90deg) scale(1)}
.orb.indet .ring{animation:spin 1.1s linear infinite}
.orb.indet .rf{stroke-dasharray:26 100}
@keyframes spin{from{transform:rotate(-90deg)}to{transform:rotate(270deg)}}

.badge{position:absolute;right:-4px;top:-4px;min-width:20px;height:20px;padding:0 6px;border-radius:10px;z-index:4;
  font:700 11px/20px -apple-system,"SF Pro Text","Segoe UI",system-ui,sans-serif;text-align:center;color:rgb(var(--deep));
  background:rgba(255,255,255,.92);box-shadow:0 3px 8px -2px rgba(var(--deep),.45),inset 0 0 0 .5px rgba(var(--rgb),.3);
  transform:scale(0);transition:transform .45s var(--bounce)}
.badge.on{transform:scale(1)}

/* ---------------- 形变（从球体长出 / 收回）----------------
   关闭态：平移到球体中心 + 缩放成 64×64 + 圆角 50% → 和球体重合 */
.menu,.card{transform:translate(var(--mx,0),var(--my,0)) scale(var(--sx,.2),var(--sy,.2));border-radius:50%;visibility:hidden;--o:0;
  transition:transform var(--snap-ms) var(--out),border-radius var(--snap-ms) var(--out),box-shadow .12s ease,visibility 0s linear var(--snap-ms);--fd:.1s;--fdl:0s}
.menu:not(.open),.card:not(.in){box-shadow:none!important}
.menu.open,.card.in{transform:none;visibility:visible;--o:1;
  transition:transform var(--bounce-ms) var(--bounce),border-radius calc(var(--bounce-ms) * .55) cubic-bezier(.2,.9,.3,1),box-shadow .5s ease .15s,visibility 0s;--fd:.18s}
.menu.measuring,.card.measuring{transition:none!important;transform:none!important;visibility:hidden}

/* ---------------- 菜单 ---------------- */
.menu{position:absolute;right:0;bottom:calc(100% + 14px);width:296px;max-width:calc(100vw - 40px);height:200px;border-radius:50%;
  --veil:.46;--bl:22px;--br:1.08;--sheen:.3;--a:calc(var(--a0,.42) * .8);
  box-shadow:0 30px 70px -22px rgba(var(--deep),.5),0 8px 22px -8px rgba(var(--deep),.22)}
.menu.open{border-radius:28px;transition:transform var(--bounce-ms) var(--bounce),border-radius calc(var(--bounce-ms) * .55) cubic-bezier(.2,.9,.3,1),height var(--soft-ms) var(--soft),visibility 0s}
.m-wrap{position:relative;z-index:1;height:100%;overflow:hidden;border-radius:inherit}
.m-view{position:absolute;left:0;right:0;top:0;padding:16px 12px 10px;max-height:100%;overflow:auto;scrollbar-width:none;
  opacity:0;transform:translateX(18px) scale(.98);filter:blur(4px);pointer-events:none;
  transition:opacity .2s ease,transform .45s var(--soft),filter .3s ease}
.m-view[data-view=main]{transform:translateX(-18px) scale(.98)}
.m-view.on{opacity:1;transform:none;filter:none;pointer-events:auto;transition:opacity .3s ease .08s,transform var(--soft-ms) var(--soft) .04s,filter .35s ease .06s}
.menu:not(.open) .m-view.on{opacity:0;filter:blur(6px);transition:opacity .12s ease,filter .12s ease}
.menu.open .m-view.on{transition:opacity .32s ease .12s,transform var(--soft-ms) var(--soft) .06s,filter .4s ease .1s}
.m-view::-webkit-scrollbar{display:none}
.m-view.scroll{-webkit-mask-image:linear-gradient(#000 calc(100% - 28px),transparent);mask-image:linear-gradient(#000 calc(100% - 28px),transparent);padding-bottom:22px}

.m-head{display:flex;align-items:center;gap:11px;padding:0 6px 12px}
.m-logo{position:relative;flex:none;width:38px;height:38px;border-radius:50%;overflow:hidden;
  background:radial-gradient(140% 120% at 28% 12%,rgba(var(--rgb),.78),rgb(var(--rgb)) 52%,rgb(var(--deep)));
  box-shadow:inset 0 1px 1px rgba(255,255,255,.7),inset 0 -2px 4px rgba(var(--deep),.35),0 4px 10px -3px rgba(var(--deep),.5)}
.m-logo img{position:absolute;left:var(--logo-x);top:var(--logo-y);width:var(--logo-w);transform:translate(-50%,-50%)}
.m-ht{min-width:0;flex:1}
.m-title{font-size:15px;font-weight:650;letter-spacing:.01em;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.m-sub{display:flex;align-items:center;gap:6px;font-size:12px;color:color-mix(in srgb,var(--ink) 64%,transparent);min-width:0}
.m-sub span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.m-sub i{flex:none;width:7px;height:7px;border-radius:50%;background:#9aa6b2}
.m-sub[data-level=good] i{background:#22b573;box-shadow:0 0 0 3px rgba(34,181,115,.18)}
.m-sub[data-level=warn] i{background:#f0a800;box-shadow:0 0 0 3px rgba(240,168,0,.2)}
.m-sub[data-level=error] i{background:#ff3b30;box-shadow:0 0 0 3px rgba(255,59,48,.18)}
.m-sub[data-level=run] i{background:rgb(var(--rgb));animation:pulse 1.2s ease infinite}
@keyframes pulse{50%{box-shadow:0 0 0 5px rgba(var(--rgb),0);transform:scale(.8)}0%{box-shadow:0 0 0 0 rgba(var(--rgb),.45)}}

.m-primary{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;height:42px;margin:0 0 10px;border:0;border-radius:21px;cursor:pointer;
  color:#fff;font-size:14px;font-weight:650;letter-spacing:.02em;
  background:linear-gradient(180deg,rgba(255,255,255,.22),rgba(255,255,255,0) 55%),linear-gradient(180deg,rgba(var(--rgb),.92),rgb(var(--deep)));
  box-shadow:inset 0 1px .5px rgba(255,255,255,.65),inset 0 -1px 1px rgba(0,0,0,.18),0 8px 20px -8px rgba(var(--deep),.75);
  transition:transform .4s var(--bounce),filter .2s ease}
.m-primary:hover{filter:brightness(1.08)}
.m-primary:disabled{cursor:default;filter:saturate(.7) brightness(1.05);opacity:.8}
.m-primary.busy svg{animation:spin2 1s linear infinite}
.m-primary:active{transform:scale(.96);transition-duration:.12s}
.m-primary svg{width:17px;height:17px;stroke-width:1.9}
.m-primary:hover svg{animation:spin360 .9s var(--soft) 1}
@keyframes spin360{to{transform:rotate(360deg)}}
.m-primary:focus-visible,.row:focus-visible,.btn:focus-visible,.m-foot>*:focus-visible,.dlg-back:focus-visible,.c-x:focus-visible{outline:2px solid rgb(var(--rgb));outline-offset:2px}

.m-sections{display:flex;flex-direction:column;gap:6px}
section{display:flex;flex-direction:column;gap:1px}
section h6{margin:6px 10px 3px;font-size:11px;font-weight:650;letter-spacing:.06em;color:color-mix(in srgb,var(--ink) 52%,transparent)}
.row{display:flex;align-items:center;gap:11px;width:100%;min-height:40px;padding:7px 10px;border:0;border-radius:14px;background:transparent;cursor:pointer;text-align:left;
  transition:background-color .18s ease,transform .35s var(--bounce)}
.row:hover{background:rgba(255,255,255,.42);box-shadow:inset 0 .5px 0 rgba(255,255,255,.8)}
.row:active{transform:scale(.975);transition-duration:.1s}
.row:disabled{opacity:.42;cursor:default;background:transparent;box-shadow:none;transform:none}
.r-ico{flex:none;width:28px;height:28px;border-radius:9px;display:grid;place-items:center;color:rgb(var(--deep));
  background:rgba(255,255,255,.55);box-shadow:inset 0 .5px 0 rgba(255,255,255,.9),0 1px 3px rgba(var(--deep),.12)}
.r-ico svg{width:17px;height:17px}
.danger .r-ico{color:#d70015}
.r-txt{flex:1;min-width:0;display:flex;flex-direction:column}
.r-label{font-size:13.5px;font-weight:550;line-height:1.3}
.r-hint{font-size:11.5px;line-height:1.35;color:color-mix(in srgb,var(--ink) 55%,transparent);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.r-trail{flex:none;font-size:12px;color:color-mix(in srgb,var(--ink) 55%,transparent);font-variant-numeric:tabular-nums}
.r-trail svg{width:15px;height:15px;display:block}
.sw{display:block;width:38px;height:23px;border-radius:12px;position:relative;background:rgba(var(--deep),.16);box-shadow:inset 0 1px 2px rgba(0,0,0,.12);transition:background-color .25s ease}
.sw i{position:absolute;left:2px;top:2px;width:19px;height:19px;border-radius:50%;background:#fff;box-shadow:0 2px 5px rgba(0,0,0,.22),inset 0 0 0 .5px rgba(0,0,0,.04);transition:transform .45s var(--bounce),width .2s ease}
.sw.on{background:rgb(var(--rgb))}
.sw.on i{transform:translateX(15px)}
.row:active .sw i{width:23px}
.row:active .sw.on i{transform:translateX(11px)}

.kv{margin:2px 4px 4px;padding:6px 10px;border-radius:14px;background:rgba(255,255,255,.34);box-shadow:inset 0 .5px 0 rgba(255,255,255,.8);
  display:grid;grid-template-columns:1fr auto;column-gap:10px}
.kv-row{display:contents}
.kv-l{font-size:12.5px;font-weight:550;padding:5px 0 0}
.kv-v{font-size:12.5px;text-align:right;font-variant-numeric:tabular-nums;padding:5px 0 0}
.kv-s{grid-column:1/-1;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:color-mix(in srgb,var(--ink) 55%,transparent);padding:0 0 5px;border-bottom:.5px solid rgba(var(--deep),.1)}
.kv-row:last-child .kv-s{border-bottom:0}
.kv-empty{grid-column:1/-1;font-size:12px;padding:6px 0;color:color-mix(in srgb,var(--ink) 55%,transparent)}

.m-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:8px 4px 0;padding:10px 6px 2px;border-top:.5px solid rgba(var(--deep),.12)}
.m-foot>*{display:inline-flex;align-items:center;gap:5px;border:0;background:none;padding:4px 6px;border-radius:8px;cursor:pointer;
  font-size:12.5px;font-weight:600;color:rgb(var(--deep));text-decoration:none}
.m-foot>*:hover{background:rgba(255,255,255,.4)}
.m-foot svg{width:13px;height:13px}
.m-hide{color:color-mix(in srgb,var(--ink) 55%,transparent)!important;font-weight:500!important}

/* 对话框 */
.dlg{display:flex;flex-direction:column;gap:10px;padding:0 4px 4px}
.dlg-head{display:flex;align-items:center;gap:8px;font-size:15px}
.dlg-head b{font-weight:650}
.dlg-back{width:30px;height:30px;border-radius:50%;border:0;display:grid;place-items:center;cursor:pointer;background:rgba(255,255,255,.5);
  box-shadow:inset 0 .5px 0 rgba(255,255,255,.9),0 1px 3px rgba(var(--deep),.12);transition:transform .35s var(--bounce)}
.dlg-back:active{transform:scale(.9)}
.dlg-back svg{width:16px;height:16px;stroke-width:2}
.dlg-msg{margin:0;font-size:12.5px;line-height:1.55;color:color-mix(in srgb,var(--ink) 75%,transparent)}
.fld{display:flex;flex-direction:column;gap:5px;font-size:12px;font-weight:550;color:color-mix(in srgb,var(--ink) 70%,transparent)}
.fld input{height:38px;padding:0 12px;border:0;border-radius:12px;font:500 13.5px/1 inherit;font-family:ui-monospace,"SF Mono","Cascadia Mono",Consolas,monospace;color:var(--ink);
  background:rgba(255,255,255,.7);box-shadow:inset 0 1px 2px rgba(var(--deep),.16),inset 0 0 0 .5px rgba(var(--deep),.14);outline:none;transition:box-shadow .2s ease}
.fld input:focus{box-shadow:inset 0 1px 2px rgba(var(--deep),.16),0 0 0 2.5px rgba(var(--rgb),.55)}
.dlg-btns{display:flex;gap:8px;justify-content:flex-end;margin-top:2px}
.btn{height:34px;padding:0 16px;border:0;border-radius:17px;cursor:pointer;font-size:13px;font-weight:600;
  background:rgba(255,255,255,.58);box-shadow:inset 0 .5px 0 rgba(255,255,255,.95),0 1px 3px rgba(var(--deep),.14);transition:transform .35s var(--bounce),filter .2s}
.btn:hover{filter:brightness(1.05)}
.btn:active{transform:scale(.94);transition-duration:.1s}
.btn.prim{color:#fff;background:linear-gradient(180deg,rgba(var(--rgb),.95),rgb(var(--deep)));box-shadow:inset 0 1px .5px rgba(255,255,255,.55),0 6px 14px -6px rgba(var(--deep),.7)}
.btn.danger{color:#fff;background:linear-gradient(180deg,#ff5a4f,#d70015);box-shadow:inset 0 1px .5px rgba(255,255,255,.5),0 6px 14px -6px rgba(180,0,20,.6)}
.btn.small{height:28px;padding:0 13px;font-size:12px}

/* ---------------- 进度卡片 / 通知 ---------------- */
.cards{position:absolute;right:calc(100% + 12px);bottom:0;display:flex;flex-direction:column;gap:10px;align-items:flex-end;pointer-events:none;
  transform:translateX(calc(var(--shift,0px) * -1));transition:transform var(--soft-ms) var(--soft)}
.cards.aside{transform:translateX(calc(-236px - var(--shift,0px)))}
.card{position:relative;width:min(304px,calc(100vw - 112px));min-height:64px;pointer-events:auto;
  --veil:.5;--bl:20px;--br:1.08;--sheen:.28;--a:calc(var(--a0,.42) * .76);
  box-shadow:0 22px 50px -18px rgba(var(--deep),.5),0 6px 16px -6px rgba(var(--deep),.2)}
.card.in{border-radius:22px}
.ct{position:relative;z-index:1;padding:12px 14px 11px 14px;display:flex;flex-direction:column;gap:7px;
  opacity:0;filter:blur(5px);transform:scale(.97);transition:opacity .12s ease,filter .12s ease,transform .2s ease}
.card.in .ct{opacity:1;filter:none;transform:none;transition:opacity .3s ease .14s,filter .35s ease .12s,transform var(--soft-ms) var(--soft) .08s}
.c-top{display:flex;align-items:center;gap:8px;min-height:20px}
.c-title{flex:1;min-width:0;font-size:13.5px;font-weight:650;letter-spacing:.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.c-ico{position:relative;flex:none;width:20px;height:20px;border-radius:50%;display:grid;place-items:center}
.c-ico>*{position:absolute;inset:0;margin:auto;transition:opacity .25s ease,transform .45s var(--bounce)}
.spin{width:16px;height:16px;border-radius:50%;background:conic-gradient(from 0deg,rgba(var(--rgb),0),rgb(var(--rgb)));animation:spin2 .85s linear infinite;
  -webkit-mask:radial-gradient(circle,transparent 5px,#000 5.5px);mask:radial-gradient(circle,transparent 5px,#000 5.5px)}
@keyframes spin2{to{transform:rotate(360deg)}}
.c-ico svg{width:20px;height:20px;padding:3px;border-radius:50%;color:#fff;stroke-width:2.4;opacity:0;transform:scale(.4)}
.c-ico .ok{background:#1fb26b;box-shadow:0 2px 6px -1px rgba(20,140,80,.55)}
.c-ico .bad{background:#f0a800;box-shadow:0 2px 6px -1px rgba(200,140,0,.5)}
.c-ico .ok path{stroke-dasharray:16;stroke-dashoffset:16;transition:stroke-dashoffset .4s ease .15s}
.card.end .spin{opacity:0;transform:scale(.4)}
.card.good .ok,.card.quiet .ok{opacity:1;transform:none}
.card.good .ok path,.card.quiet .ok path{stroke-dashoffset:0}
.card.warn .bad,.card.error .bad{opacity:1;transform:none}
.card.error .bad{background:#ff3b30;box-shadow:0 2px 6px -1px rgba(220,30,30,.5)}
.c-x{flex:none;width:22px;height:22px;margin:-2px -4px -2px 0;border:0;border-radius:50%;display:grid;place-items:center;cursor:pointer;background:transparent;
  color:color-mix(in srgb,var(--ink) 50%,transparent);opacity:0;transition:opacity .2s ease,background-color .2s ease}
.card:hover .c-x,.card.error .c-x,.c-x:focus-visible{opacity:1}
.c-x:hover{background:rgba(255,255,255,.5)}
.c-x svg{width:13px;height:13px;stroke-width:2}
.c-bar{display:flex;align-items:center;gap:10px}
.track{position:relative;flex:1;height:7px;border-radius:4px;overflow:hidden;background:rgba(var(--deep),.13);box-shadow:inset 0 1px 1.5px rgba(var(--deep),.18)}
.fill{position:absolute;left:0;top:0;bottom:0;width:0;border-radius:inherit;overflow:hidden;
  background:linear-gradient(90deg,rgba(var(--rgb),.72),rgb(var(--rgb)) 70%,rgb(var(--deep)));
  box-shadow:0 0 8px rgba(var(--rgb),.45);transition:width .6s cubic-bezier(.22,1,.36,1),background .4s ease}
.fill::before{content:'';position:absolute;left:0;right:0;top:1px;height:2px;border-radius:2px;background:rgba(255,255,255,.55)}
.fill::after{content:'';position:absolute;inset:0;background:linear-gradient(100deg,transparent 30%,rgba(255,255,255,.55) 50%,transparent 70%);
  transform:translateX(-100%);animation:shine 1.5s ease-in-out infinite}
@keyframes shine{to{transform:translateX(100%)}}
.card.end .fill::after{animation:none;opacity:0}
.card.good .fill,.card.quiet .fill{background:linear-gradient(90deg,#4cd690,#1fb26b);box-shadow:0 0 8px rgba(31,178,107,.4)}
.card.warn .fill{background:linear-gradient(90deg,#ffcf4a,#f0a800);box-shadow:none}
.card.error .fill{background:linear-gradient(90deg,#ff7b72,#ff3b30);box-shadow:none}
.pct{flex:none;min-width:36px;text-align:right;font-size:12.5px;font-weight:650;font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.c-step{position:relative;display:grid;font-size:12px;line-height:1.45;color:color-mix(in srgb,var(--ink) 72%,transparent)}
.c-step span{grid-area:1/1;opacity:0;transform:translateY(6px);filter:blur(2px);transition:opacity .28s ease,transform .38s var(--soft),filter .3s ease;overflow-wrap:anywhere}
.c-step span.show{opacity:1;transform:none;filter:none}
.c-step span.out{opacity:0;transform:translateY(-6px);filter:blur(2px)}
.c-act:empty{display:none}
.c-act{display:flex;justify-content:flex-end}
.note .c-bar{display:none}

@media (max-width:520px){:host{right:12px;bottom:12px}.cards.aside{transform:translateY(-8px)}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.001s!important;animation-iteration-count:1!important;transition-duration:.001s!important;transition-delay:0s!important}}
@supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){.mt{--veil:.82}}
`; }
  // ==================================== Glass Orb kit 结束 ====================================

})();
