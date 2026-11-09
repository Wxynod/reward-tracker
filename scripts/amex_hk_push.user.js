// ==UserScript==
// @name         Amex HK → 记账本 · 交易推送
// @namespace    local.amex-hk-ledger-push
// @version      1.0.0
// @description  截获 Amex HK 网银页面自己加载的交易数据，推送到记账本（Reward Tracker）Worker。按 Amex 参考号去重，和月结单 CSV 导入的交易共用同一个 id。
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
//
// 首次使用：Tampermonkey 菜单 →「记账本：设置写入令牌」，填 Worker 的 INGEST_TOKEN。

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
  const schedule = () => { clearTimeout(timer); timer = setTimeout(push, 1500); };

  function currentCardAccount() {
    const txt = W.document?.querySelector('button.account-switcher-toggler')?.textContent || '';
    const tail = (txt.match(/(\d{5})(?!\d)/) || [])[1];
    return CARDS[tail] || null;
  }

  function push() {
    if (!queue.size && !pendingFull.size) return;
    if (!cfg.token) { toast('记账本：还没设置写入令牌（Tampermonkey 菜单 → 设置写入令牌）', 'warn'); return; }
    const transactions = [...queue.values()];
    const replace_pending = [...pendingFull];
    queue.clear(); pendingFull.clear();
    GM_xmlhttpRequest({
      method: 'POST',
      url: `${cfg.url}/api/manual/import`,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.token}` },
      data: JSON.stringify({
        item_id: ITEM_ID,
        item: { institution: 'American Express HK', region: 'HK' },
        transactions,
        ...(replace_pending.length ? { replace_pending } : {}),
      }),
      timeout: 30000,
      onload: (r) => {
        let d = {};
        try { d = JSON.parse(r.responseText); } catch { /* 非 JSON */ }
        if (r.status !== 200) {
          // 失败的放回队列，下次再推
          for (const t of transactions) if (!queue.has(t.id)) queue.set(t.id, t);
          toast(`记账本推送失败（${r.status}）：${d.error || r.statusText}`, 'error');
          return;
        }
        for (const t of transactions) if (!t.pending) seen.add(t.id);
        saveSeen();
        const rej = d.rejected?.length ? `，${d.rejected.length} 笔被拒` : '';
        GM_setValue(KEY + 'last', { at: Date.now(), ...d, sent: transactions.length });
        if (d.added || d.updated || d.removed || rej) {
          toast(`记账本：新增 ${d.added}，更新 ${d.updated}，移除待入账 ${d.removed}，已存在跳过 ${d.skipped}${rej}`, rej ? 'warn' : 'good');
        } else {
          toast(`记账本：没有新交易（${d.skipped} 笔已存在）`, 'quiet');
        }
      },
      onerror: () => { for (const t of transactions) queue.set(t.id, t); toast('记账本：连不上 Worker', 'error'); },
      ontimeout: () => { for (const t of transactions) queue.set(t.id, t); toast('记账本：推送超时', 'error'); },
    });
  }

  // ---------------------------------------------------------------- 截获页面的交易请求
  const TXN_URL = /\/api\/servicing\/v\d+\/financials\/transactions(\?|$)/;
  function handle(url, json) {
    try {
      if (!TXN_URL.test(url) || !json) return;
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
        if (TXN_URL.test(url)) p.then((r) => { if (r.ok) r.clone().json().then((j) => handle(url, j)).catch(() => {}); }).catch(() => {});
      } catch { /* 不影响页面 */ }
      return p;
    };
  }
  const XO = W.XMLHttpRequest?.prototype;
  if (XO) {
    const open = XO.open, send = XO.send;
    XO.open = function (m, u) { this.__ledgerUrl = String(u); return open.apply(this, arguments); };
    XO.send = function () {
      if (TXN_URL.test(this.__ledgerUrl || '')) {
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
    let st = store.getState();
    st = typeof st.toJS === 'function' ? st.toJS() : st;
    const items = st?.modules?.['axp-myca-root']?.resources?.financialTransactions?.items;
    return items ? Object.values(items).map((x) => x.data || x) : null;
  }
  function pushFromStore(manual = false) {
    let list = null;
    try { list = readStore(); } catch (e) { console.warn('[记账本] 读页面缓存失败', e); }
    if (!list) { if (manual) toast('记账本：页面缓存里没找到交易，打开「最近交易」或某一期账单后再试', 'warn'); return; }
    const n = collect(list);
    if (manual && !n) toast(`记账本：页面上的 ${list.length} 笔都已推送过`, 'quiet');
  }

  // 进入交易页面后，若一直没截到请求（页面用了缓存），就从缓存补读
  let lastPath = '';
  setInterval(() => {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    if (/^\/activity\b/.test(lastPath)) setTimeout(() => { if (!queue.size) pushFromStore(); }, 5000);
  }, 1000);

  // ---------------------------------------------------------------- 菜单
  GM_registerMenuCommand('记账本：立即推送页面上的交易', () => pushFromStore(true));
  GM_registerMenuCommand('记账本：设置写入令牌', () => {
    const v = W.prompt('Worker 的 INGEST_TOKEN（只用于写入记账本，不能读数据）', cfg.token ? '（已设置，留空不变）' : '');
    if (v && !v.startsWith('（')) { GM_setValue(KEY + 'token', v.trim()); toast('记账本：写入令牌已保存', 'good'); }
  });
  GM_registerMenuCommand('记账本：设置 Worker 地址', () => {
    const v = W.prompt('记账本 Worker 地址', cfg.url);
    if (v) { GM_setValue(KEY + 'url', v.trim()); toast(`记账本：地址改为 ${v.trim()}（需同时在脚本头部 @connect 里加上这个域名）`, 'warn'); }
  });
  GM_registerMenuCommand('记账本：上次推送结果', () => {
    const l = GM_getValue(KEY + 'last', null);
    toast(l ? `${new Date(l.at).toLocaleString()}：发送 ${l.sent}，新增 ${l.added}，更新 ${l.updated}，跳过 ${l.skipped}，移除 ${l.removed}，库中共 ${l.total}` : '还没有推送过', 'quiet', 8000);
  });
  GM_registerMenuCommand('记账本：清空本地去重记录', () => {
    seen = new Set(); saveSeen(); toast('记账本：已清空本地记录；下次会把页面上的交易全部重发（Worker 仍会跳过已存在的）', 'quiet');
  });

  // ---------------------------------------------------------------- 提示条
  let host = null;
  function toast(text, level = 'good', ms = 4500) {
    const doc = W.document;
    if (!doc.body) { doc.addEventListener('DOMContentLoaded', () => toast(text, level, ms), { once: true }); return; }
    if (!host) {
      host = doc.createElement('div');
      host.style.cssText = 'position:fixed;left:20px;bottom:20px;z-index:2147483646;';
      host.attachShadow({ mode: 'open' }).innerHTML = `<style>
        .t{font:500 13.5px/1.5 "Noto Serif SC","Songti SC",serif;color:#0b2a4a;max-width:min(420px,calc(100vw - 40px));
          padding:10px 14px;margin-top:8px;border-radius:16px;background:rgba(232,242,252,.72);
          backdrop-filter:blur(24px) saturate(180%);-webkit-backdrop-filter:blur(24px) saturate(180%);
          box-shadow:0 14px 40px -14px rgba(6,40,84,.45),inset 0 1px 0 rgba(255,255,255,.9);
          transition:opacity .4s ease,transform .5s cubic-bezier(.32,1.28,.52,1)}
        .t.good{border-left:4px solid #18a06e}.t.warn{border-left:4px solid #e2a400}.t.error{border-left:4px solid #e0393e}.t.quiet{opacity:.85}
        .t.out{opacity:0;transform:translateY(8px)}</style><div class="box"></div>`;
      doc.body.append(host);
    }
    const box = host.shadowRoot.querySelector('.box');
    const el = doc.createElement('div');
    el.className = `t ${level}`; el.textContent = text;
    box.append(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 450); }, ms);
  }
})();
